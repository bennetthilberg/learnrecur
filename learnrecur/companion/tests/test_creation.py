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
    jobs.store.configure_limits(max_skills=100)
    payload = definition(jobs)
    key = "skill-" + payload["request_id"]
    skill = {**FIXTURE, "id": key, "bank": {**FIXTURE["bank"], "skill_id": key}}
    jobs.store.import_batch({"skills": [skill]})
    with pytest.raises(JobConflict, match="identity"):
        jobs.create_skill(payload, "fixture")
    for index in range(98):
        key = f"synthetic-{index}"
        jobs.store.import_batch(
            {
                "skills": [
                    {**FIXTURE, "id": key, "bank": {**FIXTURE["bank"], "skill_id": key}}
                ]
            }
        )
    jobs.create_skill(definition(jobs), "fixture")
    with pytest.raises(JobConflict, match="skill limit"):
        jobs.create_skill(definition(jobs), "fixture")
    with pytest.raises(SkillImportError):
        jobs.store.import_batch({"skills": [FIXTURE]})


def large_skill(count=19):
    # Valid, escaped text makes the snapshot large without hitting the skill cap.
    exercises = [
        {
            "id": f"exercise-{index}",
            "prompt": f"{index}" + "\\" * 8000,
            "answer": "\\" * 8192,
            "explanation": "\\" * 8192,
        }
        for index in range(count)
    ]
    return {**FIXTURE, "bank": {**FIXTURE["bank"], "exercises": exercises}}


def test_creation_rejects_full_snapshot_before_reserving_or_calling(jobs):
    jobs.store.configure_limits(max_snapshot_bytes=1024 * 1024)
    jobs.store.import_batch({"skills": [large_skill()]})
    with pytest.raises(JobConflict, match="no room"):
        jobs.create_skill(definition(jobs), "openai")
    with jobs.store.connect() as db:
        for table in ("skill_drafts", "generation_jobs", "generation_attempts"):
            assert db.execute(f"select count(*) from {table}").fetchone()[0] == 0


def test_concurrent_drafts_reserve_space_and_imports_cannot_take_it(jobs):
    jobs.store.configure_limits(max_snapshot_bytes=1024 * 1024)
    # Leave enough space for exactly one worst-case initial bank.
    jobs.store.import_batch({"skills": [large_skill(18)]})
    payloads = [definition(jobs), definition(jobs)]

    def create(payload):
        try:
            return jobs.create_skill(payload, "fixture")
        except JobConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        created = list(pool.map(create, payloads))
    assert sum(job is not None for job in created) == 1
    extra = large_skill(1)
    extra["id"] = extra["bank"]["skill_id"] = "another-skill"
    before = jobs.store.snapshot()
    assert (
        len(json.dumps({"skills": [*before["skills"], extra]}).encode()) < 1024 * 1024
    )
    with pytest.raises(SkillImportError, match="storage limits"):
        jobs.store.import_batch({"skills": [extra]})
    assert jobs.store.snapshot() == before
    job = next(job for job in created if job)

    class LargestBank(FixtureProvider):
        def generate(self, context):
            result = super().generate(context)
            result["exercises"] = [
                {
                    "prompt": str(index) + "\\" * 8191,
                    "answer": "\\" * 8192,
                    "explanation": "\\" * 8192,
                }
                for index in range(3)
            ]
            return result

    jobs.run_once(LargestBank())
    assert jobs.get(job["id"])["state"] == "completed"
    assert len(jobs.store.snapshot()["skills"]) == 2
