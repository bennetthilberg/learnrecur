"""A low-bank checkpoint can create only one bounded generation job."""

import copy
import json
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest

from anki.learnrecur_skill_import import SkillImportError
from learnrecur.companion.jobs import FixtureProvider, JobConflict, Jobs
from learnrecur.companion.openai_provider import request_body
from learnrecur.companion.reports import Reports
from learnrecur.companion.server import Store
from learnrecur.companion.tests.test_creation import definition
from learnrecur.companion.tests.test_jobs import example, jobs, payload
from learnrecur.companion.tests.test_reports import value as report_value
from learnrecur.companion.tests.test_server import batch, request, server

__all__ = ["jobs", "payload", "batch", "server"]


def checkpoint(jobs, sequence=0, *, skill_id="spanish-ar-preterite-yo", revision=1):
    return {
        "source_id": jobs.store.snapshot()["source_id"],
        "skill_id": skill_id,
        "revision": revision,
        "bank_sequence": sequence,
        "remaining": 2,
    }


def count(jobs):
    with jobs.store.connect() as db:
        return db.execute("select count(*) from generation_jobs").fetchone()[0]


@pytest.fixture
def guided_skill(jobs):
    examples = [
        example(),
        {
            "prompt": "Ayer yo ___ una carta. (mandar)",
            "answer": "mandé",
            "explanation": "Use -é for yo in the preterite.",
        },
    ]
    created = jobs.create_skill(definition(jobs, examples=examples), "fixture")
    assert jobs.run_once(FixtureProvider()) == created["id"]
    assert jobs.get(created["id"])["state"] == "completed"
    return created["request"]["skill_id"], examples


def test_refill_uses_all_saved_examples_in_provider_request(jobs, guided_skill):
    skill_id, examples = guided_skill
    other = jobs.create_skill(definition(jobs, examples=[examples[1]]), "fixture")
    jobs.run_once(FixtureProvider())
    assert jobs.get(other["id"])["state"] == "completed"
    result = jobs.request_refill(checkpoint(jobs, skill_id=skill_id), "openai")
    job = jobs.get(result["job_id"])
    assert job["request"]["examples"] == examples
    body = json.loads(request_body(job["context"])["input"])
    assert body["examples"] == examples
    assert body["existing_prompts"] == job["context"]["existing_prompts"]
    assert not {e["prompt"] for e in examples} & set(body["existing_prompts"])
    assert job["attempts"] == 0


def test_source_guidance_survives_concurrency_restart_and_later_batches(
    jobs, guided_skill
):
    skill_id, examples = guided_skill
    value = checkpoint(jobs, skill_id=skill_id)
    with ThreadPoolExecutor(max_workers=8) as pool:
        replies = list(
            pool.map(lambda _: jobs.request_refill(value, "fixture"), range(8))
        )
    assert all(reply == replies[0] for reply in replies)
    assert count(jobs) == 2  # Creation and one shared refill.
    first_id = replies[0]["job_id"]
    frozen = jobs.get(first_id)["context"]
    assert frozen["examples"] == examples
    restarted = Jobs(Store(jobs.store.path.parent))
    assert restarted.request_refill(value, "openai") == replies[0]
    assert restarted.get(first_id)["context"] == frozen
    assert restarted.run_once(FixtureProvider()) == first_id
    assert restarted.get(first_id)["state"] == "completed"
    assert restarted.definition(skill_id)["examples"] == examples
    second = restarted.request_refill(
        checkpoint(restarted, 1, skill_id=skill_id), "fixture"
    )
    assert second["job_id"] != first_id
    assert restarted.get(second["job_id"])["context"]["examples"] == examples
    batch = restarted.store.snapshot()["bank_updates"][skill_id][0]
    assert not {e["prompt"] for e in examples} & {
        e["prompt"] for e in batch["exercises"]
    }


@pytest.mark.parametrize("clear_examples", [False, True])
def test_refill_uses_current_revision_guidance_or_cleared_examples_fallback(
    jobs, guided_skill, clear_examples
):
    skill_id, original = guided_skill
    updated = [] if clear_examples else [original[1]]
    edit = {
        **jobs.definition(skill_id),
        "request_id": uuid4().hex,
        "examples": updated,
    }
    changed = jobs.edit_skill(edit, "fixture")
    assert jobs.definition(skill_id)["examples"] == original
    assert jobs.request_refill(checkpoint(jobs, skill_id=skill_id), "fixture") == {
        "status": "awaiting_import",
        "job_id": None,
    }
    assert jobs.run_once(FixtureProvider()) == changed["id"]
    assert jobs.get(changed["id"])["state"] == "completed"
    restarted = Jobs(Store(jobs.store.path.parent))
    result = restarted.request_refill(
        checkpoint(restarted, skill_id=skill_id, revision=2), "fixture"
    )
    skill = next(s for s in restarted.store.snapshot()["skills"] if s["id"] == skill_id)
    fallback = {
        k: skill["bank"]["exercises"][0][k] for k in ("prompt", "answer", "explanation")
    }
    assert restarted.get(result["job_id"])["context"]["examples"] == (
        updated or [fallback]
    )
    assert restarted.definition(skill_id)["examples"] == updated


def test_imported_revision_does_not_reuse_old_source_guidance(jobs, guided_skill):
    skill_id, _ = guided_skill
    skill = next(s for s in jobs.store.snapshot()["skills"] if s["id"] == skill_id)
    skill["bank"]["revision"] = 2
    jobs.store.import_batch({"skills": [skill]})
    result = jobs.request_refill(
        checkpoint(jobs, skill_id=skill_id, revision=2), "fixture"
    )
    first = skill["bank"]["exercises"][0]
    assert jobs.get(result["job_id"])["context"]["examples"] == [
        {k: first[k] for k in ("prompt", "answer", "explanation")}
    ]
    assert jobs.definition(skill_id)["examples"] == []


def test_report_retries_and_withdrawals_keep_source_guidance(jobs, guided_skill):
    skill_id, examples = guided_skill
    report = report_value(jobs.store)
    assert report["skill_id"] == skill_id
    original = copy.deepcopy(jobs.store.snapshot())
    first = Reports(jobs.store).receive(report, "fixture")
    assert jobs.get(first["job_id"])["context"]["examples"] == examples
    assert Reports(jobs.store).receive(report, "fixture") == first
    assert jobs.store.snapshot() == original
    restarted = Jobs(Store(jobs.store.path.parent))
    withdrawn = {**report, "version": 2, "active": False}
    assert not Reports(restarted.store).receive(withdrawn, "fixture")["active"]
    redone = Reports(restarted.store).receive({**report, "version": 3}, "fixture")
    assert redone["job_id"] == first["job_id"]
    assert restarted.get(first["job_id"])["context"]["examples"] == examples
    assert count(restarted) == 2


def test_oversized_saved_examples_preserve_report_without_provider_work(jobs):
    examples = [{"prompt": "p" * 7900, "answer": "a", "explanation": "e" * 7900}] * 3
    created = jobs.create_skill(definition(jobs, examples=examples), "fixture")
    jobs.run_once(FixtureProvider())
    assert jobs.get(created["id"])["state"] == "completed"
    report = report_value(jobs.store)
    receipt = Reports(jobs.store).receive(report, "openai")
    assert receipt["active"] and receipt["status"] == "blocked"
    assert receipt["job_id"] is None
    assert Reports(jobs.store).receive(report, "openai") == receipt
    withdrawn = Reports(jobs.store).receive(
        {**report, "active": False, "version": 2}, "openai"
    )
    assert not withdrawn["active"]
    with jobs.store.connect() as db:
        assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 1
        assert db.execute("select count(*) from generation_attempts").fetchone()[0] == 1


def test_concurrent_clients_and_restart_share_one_job(jobs):
    value = checkpoint(jobs)
    with ThreadPoolExecutor(max_workers=8) as pool:
        replies = list(
            pool.map(lambda _: jobs.request_refill(value, "fixture"), range(8))
        )
    assert all(reply == replies[0] for reply in replies)
    assert count(jobs) == 1
    restored = Jobs(Store(jobs.store.path.parent))
    value["remaining"] = 0
    assert restored.request_refill(value, "openai") == replies[0]
    job = restored.get(replies[0]["job_id"])
    assert job["request"]["count"] == 3
    assert job["context"]["provider"] == "fixture-spanish-v1"
    assert job["context"]["examples"][0]["answer"] == "hablé"


def test_completed_batch_requires_import_before_another_refill(jobs):
    first = jobs.request_refill(checkpoint(jobs), "fixture")
    assert jobs.run_once(FixtureProvider()) == first["job_id"]
    assert jobs.request_refill(checkpoint(jobs), "fixture") == {
        "status": "awaiting_import",
        "job_id": None,
    }
    second = jobs.request_refill(checkpoint(jobs, 1), "fixture")
    assert second["job_id"] != first["job_id"]
    assert jobs.run_once(FixtureProvider()) == second["job_id"]
    banks = jobs.store.snapshot()["bank_updates"]["spanish-ar-preterite-yo"]
    prompts = [e["prompt"] for batch in banks for e in batch["exercises"]]
    assert len(prompts) == len(set(prompts)) == 6
    assert count(jobs) == 2


@pytest.mark.parametrize(
    "state",
    [
        "queued",
        "running",
        "provider_pending",
        "retry_wait",
        "waiting_budget",
        "result_ready",
        "failed",
        "needs_attention",
    ],
)
def test_existing_manual_job_prevents_automatic_replacement(jobs, payload, state):
    manual = jobs.enqueue(payload)
    with jobs.store.connect() as db:
        db.execute(
            "update generation_jobs set state=? where id=?", (state, manual["id"])
        )
    assert jobs.request_refill(checkpoint(jobs), "fixture") == {
        "status": state,
        "job_id": manual["id"],
    }
    assert count(jobs) == 1


def test_uncertain_charge_blocks_other_revisions(jobs, payload):
    manual = jobs.enqueue(payload)
    revised = copy.deepcopy(jobs.store.snapshot()["skills"][0])
    revised["bank"]["revision"] = 2
    jobs.store.import_batch({"skills": [revised]})
    with jobs.store.connect() as db:
        db.execute(
            "update generation_jobs set state='needs_attention' where id=?",
            (manual["id"],),
        )
    value = checkpoint(jobs)
    value["revision"] = 2
    assert jobs.request_refill(value, "fixture")["status"] == "needs_attention"
    assert count(jobs) == 1


def test_zero_budget_and_failed_checkpoint_do_not_get_new_jobs(jobs):
    jobs.configure_budget(0)
    result = jobs.request_refill(checkpoint(jobs), "fixture")

    class Costly(FixtureProvider):
        def estimate(self, context):
            return 1

    assert jobs.run_once(Costly()) is None
    assert (
        jobs.request_refill(checkpoint(jobs), "fixture")["status"] == "waiting_budget"
    )
    with jobs.store.connect() as db:
        assert db.execute("select count(*) from generation_attempts").fetchone()[0] == 0
        db.execute(
            "update generation_jobs set state='failed' where id=?", (result["job_id"],)
        )
    assert jobs.request_refill(checkpoint(jobs), "fixture")["status"] == "failed"
    assert count(jobs) == 1


@pytest.mark.parametrize(
    "field,value",
    [
        ("remaining", 3),
        ("remaining", True),
        ("bank_sequence", -1),
        ("bank_sequence", True),
        ("skill_id", []),
        ("revision", True),
        ("provider", "openai"),
    ],
)
def test_invalid_checkpoint_does_not_enqueue(jobs, field, value):
    body = checkpoint(jobs)
    body[field] = value
    with pytest.raises(SkillImportError):
        jobs.request_refill(body, "fixture")
    assert count(jobs) == 0


@pytest.mark.parametrize(
    "field,value",
    [
        ("source_id", "different"),
        ("skill_id", "unknown"),
        ("revision", 2),
        ("bank_sequence", 1),
    ],
)
def test_stale_or_foreign_identity_does_not_enqueue(jobs, field, value):
    body = checkpoint(jobs)
    body[field] = value
    with pytest.raises(JobConflict):
        jobs.request_refill(body, "fixture")
    assert count(jobs) == 0


def test_revision_change_rejects_old_client_and_obsoletes_old_work(jobs):
    old = checkpoint(jobs)
    job = jobs.request_refill(old, "fixture")
    revised = copy.deepcopy(jobs.store.snapshot()["skills"][0])
    revised["bank"]["revision"] = 2
    revised["description"] += " Updated description."
    jobs.store.import_batch({"skills": [revised]})
    with pytest.raises(JobConflict):
        jobs.request_refill(old, "fixture")
    assert jobs.run_once(FixtureProvider()) is None
    assert jobs.get(job["job_id"])["state"] == "obsolete"
    new = {**old, "revision": 2}
    assert jobs.request_refill(new, "fixture")["job_id"] != job["job_id"]


def test_endpoint_is_authenticated_and_disabled_by_default(server, batch):
    server.store.import_batch(batch)
    body = checkpoint(Jobs(server.store))
    assert request(server, body, token=None, path="/v1/refill-requests")[0] == 401
    assert request(server, body, path="/v1/refill-requests") == (
        200,
        {"status": "disabled", "job_id": None},
    )
    assert count(Jobs(server.store)) == 0
    server.refill_provider = "fixture"
    status, first = request(server, body, path="/v1/refill-requests")
    assert status == 200 and first["status"] == "queued"
    assert request(server, body, path="/v1/refill-requests") == (200, first)
