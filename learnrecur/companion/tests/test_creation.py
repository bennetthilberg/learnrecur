"""Draft creation must not expose empty banks or repeat paid requests."""

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import pytest

from anki.learnrecur_skill_import import SkillImportError
from learnrecur.companion.jobs import FixtureProvider, JobConflict, Jobs
from learnrecur.companion.openai_provider import OpenAIProvider
from learnrecur.companion.server import Store
from learnrecur.companion.tests.test_openai_provider import SYNTHETIC_KEY, Transport

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[2] / "fixtures/spanish-import.json").read_text()
)["skills"][0]


@pytest.fixture
def jobs(tmp_path):
    return Jobs(Store(tmp_path / "companion"))


def definition(jobs, **changes):
    return {
        "request_id": uuid4().hex,
        "source_id": jobs.store.snapshot()["source_id"],
        "title": FIXTURE["title"],
        "description": FIXTURE["description"],
        "examples": [],
        **changes,
    }


def test_creation_survives_restart_and_is_not_importable_until_publication(jobs):
    payload = definition(jobs)
    job = jobs.create_skill(payload, "fixture")
    assert jobs.store.snapshot()["skills"] == []
    restarted = Jobs(Store(jobs.store.path.parent))
    assert restarted.create_skill(payload, None)["id"] == job["id"]
    restarted.run_once(FixtureProvider())
    snapshot = restarted.store.snapshot()
    skill = snapshot["skills"][0]
    assert skill["title"] == payload["title"]
    assert len(skill["bank"]["exercises"]) == 3
    assert len(snapshot["identities"]) == 1
    assert restarted.create_skill(payload, "openai")["id"] == job["id"]
    assert restarted.run_once(FixtureProvider()) is None
    with restarted.store.connect() as db:
        assert db.execute("select count(*) from skill_drafts").fetchone()[0] == 0
        assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 1
        assert db.execute("select count(*) from generation_attempts").fetchone()[0] == 1


def test_concurrent_retries_share_one_draft_and_job(jobs):
    payload = definition(jobs)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(
            pool.map(lambda _: jobs.create_skill(payload, "fixture"), range(4))
        )
    assert len({job["id"] for job in results}) == 1
    with jobs.store.connect() as db:
        assert db.execute("select count(*) from skill_drafts").fetchone()[0] == 1
    with pytest.raises(JobConflict, match="different skill"):
        jobs.create_skill({**payload, "description": "Different"}, "fixture")


@pytest.mark.parametrize(
    "change", ["source", "missing", "examples", "title", "paused", "disabled"]
)
def test_rejected_creation_rolls_back_without_a_job(jobs, change):
    payload = definition(jobs)
    provider = "fixture"
    if change == "source":
        payload["source_id"] = str(uuid4())
    elif change == "missing":
        del payload["description"]
    elif change == "examples":
        payload["examples"] = [{"prompt": "Missing answer"}]
    elif change == "title":
        payload["title"] = "é" * 129
    elif change == "paused":
        (jobs.store.path.parent / ".restore-pending").write_text("paused")
    else:
        provider = None
    with pytest.raises(SkillImportError):
        jobs.create_skill(payload, provider)
    with jobs.store.connect() as db:
        assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 0
        assert db.execute("select count(*) from skill_drafts").fetchone()[0] == 0
    assert jobs.store.snapshot()["skills"] == []


def test_examples_guide_generation_and_do_not_become_cached_exercises(jobs):
    example = {
        "prompt": "Anoche yo ___ una canción. (cantar)",
        "answer": "canté",
        "explanation": "The ending is -é.",
    }
    created = jobs.create_skill(definition(jobs, examples=[example]), "fixture")
    assert created["context"]["examples"] == [example]
    jobs.run_once(FixtureProvider())
    prompts = [
        e["prompt"] for e in jobs.store.snapshot()["skills"][0]["bank"]["exercises"]
    ]
    assert example["prompt"] not in prompts


def test_saved_initial_result_can_publish_after_restore_without_a_call(jobs):
    created = jobs.create_skill(definition(jobs), "fixture")
    provider = FixtureProvider()
    job_id, token, context = jobs.claim(provider)
    assert jobs.calling(job_id, token)
    jobs.save_result(job_id, token, provider.generate(context))
    (jobs.store.path.parent / ".restore-pending").write_text("paused")
    restarted = Jobs(Store(jobs.store.path.parent))
    restarted.run_once(provider)
    assert restarted.get(created["id"])["state"] == "completed"
    assert len(restarted.store.snapshot()["skills"]) == 1
    assert (jobs.store.path.parent / ".restore-pending").exists()


def test_initial_openai_job_uses_existing_pricing_and_preserves_its_request(jobs):
    payload = definition(jobs)
    created = jobs.create_skill(payload, "openai")
    assert created["request"]["provider"] == "openai"
    assert created["context"]["provider_config"]["model"] == "gpt-6-luna"
    transport = Transport()
    jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=transport))
    assert jobs.get(created["id"])["state"] == "completed"
    assert len(jobs.store.snapshot()["skills"]) == 1
    assert [call[0] for call in transport.calls] == ["POST"]
    assert jobs.create_skill(payload, None)["id"] == created["id"]


def test_failed_initial_output_has_no_card_identity_or_partial_skill(jobs):
    created = jobs.create_skill(definition(jobs), "fixture")

    class Incomplete(FixtureProvider):
        def generate(self, context):
            result = super().generate(context)
            result["exercises"].pop()
            return result

    jobs.run_once(Incomplete())
    assert jobs.get(created["id"])["state"] == "failed"
    snapshot = jobs.store.snapshot()
    assert snapshot["skills"] == [] and snapshot["identities"] == {}


def test_import_cannot_take_over_a_pending_skill_identity(jobs):
    payload = definition(jobs)
    jobs.create_skill(payload, "fixture")
    key = "skill-" + payload["request_id"]
    skill = {**FIXTURE, "id": key, "bank": {**FIXTURE["bank"], "skill_id": key}}
    with pytest.raises(SkillImportError, match="waiting"):
        jobs.store.import_batch({"skills": [skill]})
    with pytest.raises(JobConflict, match="Import"):
        jobs.enqueue(
            {"request_id": "extra", "skill_id": key, "revision": 1, "count": 3}
        )


def test_drafts_obey_capacity_and_published_identity_collisions(jobs):
    payload = definition(jobs)
    key = "skill-" + payload["request_id"]
    skill = {**FIXTURE, "id": key, "bank": {**FIXTURE["bank"], "skill_id": key}}
    jobs.store.import_batch({"skills": [skill]})
    with pytest.raises(JobConflict, match="identity"):
        jobs.create_skill(payload, "fixture")
    for _ in range(99):
        jobs.create_skill(definition(jobs), "fixture")
    with pytest.raises(JobConflict, match="100 skills"):
        jobs.create_skill(definition(jobs), "fixture")
    with pytest.raises(SkillImportError):
        jobs.store.import_batch({"skills": [FIXTURE]})
