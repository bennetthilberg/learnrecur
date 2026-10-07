"""Pending edits keep the published definition intact and recover one revision."""

import copy
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from uuid import uuid4

import pytest

from anki.learnrecur_skill_import import SkillImportError
from learnrecur.companion.jobs import FixtureProvider, JobConflict, Jobs
from learnrecur.companion.openai_provider import OpenAIProvider
from learnrecur.companion.server import Store
from learnrecur.companion.tests.test_creation import large_skill
from learnrecur.companion.tests.test_openai_provider import SYNTHETIC_KEY, Transport

ROOT = Path(__file__).resolve().parents[2]
ORIGINAL = json.loads((ROOT / "fixtures/spanish-import.json").read_text())["skills"][0]
REVISED = json.loads((ROOT / "fixtures/spanish-revision.json").read_text())["skills"][0]
EXAMPLE = {
    "prompt": "Yo ___ ayer. (hablar)",
    "answer": "hablé",
    "explanation": "Use -é.",
}


@pytest.fixture
def jobs(tmp_path):
    jobs = Jobs(Store(tmp_path / "companion"))
    jobs.store.import_batch({"skills": [ORIGINAL]})
    return jobs


def edit(jobs, **changes):
    return {
        **jobs.definition(ORIGINAL["id"]),
        "request_id": uuid4().hex,
        "title": "Completed past actions",
        "description": REVISED["description"],
        "examples": [EXAMPLE],
        **changes,
    }


def test_pending_edit_recovers_publication_without_changing_identity(jobs):
    before = jobs.store.snapshot()
    value = edit(jobs)
    created = jobs.edit_skill(value, "fixture")
    assert jobs.store.snapshot() == before
    provider = FixtureProvider()
    job_id, token, context = jobs.claim(provider)
    assert jobs.calling(job_id, token)
    jobs.save_result(job_id, token, provider.generate(context))
    restarted = Jobs(Store(jobs.store.path.parent))
    assert restarted.edit_skill(value, None)["id"] == created["id"]
    restarted.run_once(provider)
    after = restarted.store.snapshot()
    assert after["identities"] == before["identities"]
    assert after["previous_revisions"][ORIGINAL["id"]] == [ORIGINAL]
    skill = after["skills"][0]
    assert skill["bank"]["revision"] == 2
    assert skill["title"] == value["title"]
    assert skill["description"] == value["description"]
    assert len(skill["bank"]["exercises"]) == 3
    assert restarted.definition(ORIGINAL["id"])["examples"] == [EXAMPLE]
    assert restarted.edit_skill(value, "openai")["id"] == created["id"]
    assert restarted.run_once(provider) is None
    with restarted.store.connect() as db:
        assert db.execute("select count(*) from generation_attempts").fetchone()[0] == 1
        assert db.execute("select count(*) from skill_drafts").fetchone()[0] == 0


def test_concurrent_retries_and_competing_edits_keep_one_job(jobs):
    value = edit(jobs)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: jobs.edit_skill(value, "fixture"), range(4)))
    assert len({result["id"] for result in results}) == 1
    with pytest.raises(JobConflict, match="pending changes"):
        jobs.edit_skill(edit(jobs), "fixture")
    with pytest.raises(JobConflict, match="different skill"):
        jobs.edit_skill({**value, "title": "Other title"}, "fixture")
    with pytest.raises(SkillImportError, match="waiting"):
        jobs.store.import_batch({"skills": [REVISED]})


def test_edit_blocks_old_refills_before_a_provider_call(jobs):
    refill = jobs.enqueue(
        {
            "request_id": "old-refill",
            "skill_id": ORIGINAL["id"],
            "revision": 1,
            "count": 3,
        }
    )
    value = edit(jobs)
    jobs.edit_skill(value, "fixture")
    assert jobs.request_refill(
        {
            "source_id": value["source_id"],
            "skill_id": ORIGINAL["id"],
            "revision": 1,
            "bank_sequence": 0,
            "remaining": 0,
        },
        "fixture",
    ) == {"status": "awaiting_import", "job_id": None}
    jobs.run_once(FixtureProvider())
    assert jobs.get(refill["id"])["state"] == "obsolete"
    assert jobs.get(refill["id"])["attempts"] == 0


def test_invalid_output_keeps_old_bank_and_allows_deliberate_new_edit(jobs):
    before = jobs.store.snapshot()
    value = edit(jobs)
    created = jobs.edit_skill(value, "fixture")

    class Invalid(FixtureProvider):
        def generate(self, context):
            result = super().generate(context)
            result["exercises"].pop()
            return result

    jobs.run_once(Invalid())
    assert jobs.get(created["id"])["state"] == "failed"
    assert jobs.store.snapshot() == before
    retry = jobs.edit_skill(edit(jobs), "fixture")
    jobs.run_once(FixtureProvider())
    assert jobs.get(retry["id"])["state"] == "completed"
    assert len(jobs.store.snapshot()["skills"]) == 1


@pytest.mark.parametrize(
    "change", ["source", "revision", "missing", "disabled", "paused", "limit"]
)
def test_rejected_edit_preserves_published_state_without_reservation(jobs, change):
    before = jobs.store.snapshot()
    value = edit(jobs)
    provider = "fixture"
    if change == "source":
        value["source_id"] = str(uuid4())
    elif change == "revision":
        value["base_revision"] = 2
    elif change == "missing":
        value["skill_id"] = "missing"
    elif change == "disabled":
        provider = None
    elif change == "paused":
        (jobs.store.path.parent / ".restore-pending").write_text("paused")
    else:
        value["base_revision"] = 100
    with pytest.raises(SkillImportError):
        jobs.edit_skill(value, provider)
    assert jobs.store.snapshot() == before
    with jobs.store.connect() as db:
        for table in ("skill_drafts", "generation_jobs", "generation_attempts"):
            assert db.execute(f"select count(*) from {table}").fetchone()[0] == 0


def test_edit_reserves_history_and_bank_space_before_paid_generation(jobs):
    jobs.store.configure_limits(max_snapshot_bytes=1024 * 1024)
    large = large_skill()
    large["id"] = large["bank"]["skill_id"] = "large-bank"
    jobs.store.import_batch({"skills": [large]})
    before = jobs.store.snapshot()
    with pytest.raises(JobConflict, match="no room"):
        jobs.edit_skill(edit(jobs), "openai")
    assert jobs.store.snapshot() == before
    with jobs.store.connect() as db:
        assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 0


def test_edit_does_not_consume_another_skill_slot(jobs):
    jobs.store.configure_limits(max_skills=100)
    skills = []
    for index in range(99):
        skill = copy.deepcopy(ORIGINAL)
        skill["id"] = skill["bank"]["skill_id"] = f"synthetic-{index}"
        skills.append(skill)
    jobs.store.import_batch({"skills": skills})
    created = jobs.edit_skill(edit(jobs), "fixture")
    jobs.run_once(FixtureProvider())
    assert jobs.get(created["id"])["state"] == "completed"
    assert len(jobs.store.snapshot()["skills"]) == 100


def test_openai_edit_uses_saved_examples_and_settles_mocked_usage(jobs):
    value = edit(jobs)
    created = jobs.edit_skill(value, "openai")
    transport = Transport()
    jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=transport))
    job = jobs.get(created["id"])
    assert job["state"] == "completed"
    assert job["request"]["base_revision"] == 1
    assert job["context"]["examples"] == [EXAMPLE]
    assert job["usage"]["gross_cost_microusd"] > 0
    assert [call[0] for call in transport.calls] == ["POST"]
    assert jobs.edit_skill(value, None)["id"] == created["id"]
