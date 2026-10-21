"""A low-bank checkpoint can create only one bounded generation job."""

import copy
import json
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest

from anki.learnrecur_skill_import import SkillImportError
from learnrecur.companion.jobs import (
    FixtureProvider,
    JobConflict,
    Jobs,
    RetryableFailure,
    TerminalFailure,
)
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


class Rejected(FixtureProvider):
    def generate(self, context):
        raise TerminalFailure()


class Copied(FixtureProvider):
    """Return a charged batch that copies an example, so publication fails."""

    def estimate(self, context):
        return 100

    def generate(self, context):
        result = super().generate(context)
        result["exercises"][0] = context["examples"][0]
        result["usage"] = {
            "input_tokens": 10,
            "output_tokens": 10,
            "gross_cost_microusd": 80,
        }
        return result


def at(jobs, seconds):
    jobs.clock = lambda: 1790888400 + seconds


@pytest.mark.parametrize("provider", [Rejected(), Copied()], ids=["free", "charged"])
def test_failed_refill_retries_in_its_own_row_after_a_growing_wait(jobs, provider):
    value = checkpoint(jobs)
    first = jobs.request_refill(value, "fixture")
    job_id = first["job_id"]
    assert jobs.run_once(provider) == job_id
    assert jobs.get(job_id)["state"] == "failed"
    failed = {"status": "failed", "job_id": job_id}
    at(jobs, 3500)
    assert jobs.request_refill(value, "fixture") == failed
    restarted = Jobs(Store(jobs.store.path.parent), clock=lambda: 1790888400 + 3700)
    with ThreadPoolExecutor(max_workers=8) as pool:
        replies = list(
            pool.map(lambda _: restarted.request_refill(value, "fixture"), range(8))
        )
    assert all(reply == {"status": "queued", "job_id": job_id} for reply in replies)
    assert count(jobs) == 1
    assert restarted.run_once(provider) == job_id
    assert restarted.get(job_id)["attempts"] == 2
    # The second failure waits two hours before a third round.
    at(jobs, 3700 + 7000)
    assert jobs.request_refill(value, "fixture") == failed
    at(jobs, 3700 + 7300)
    assert jobs.request_refill(value, "fixture")["status"] == "queued"
    assert jobs.run_once(FixtureProvider()) == job_id
    assert jobs.get(job_id)["state"] == "completed"
    assert jobs.request_refill(value, "fixture") == {
        "status": "awaiting_import",
        "job_id": None,
    }
    assert count(jobs) == 1
    with jobs.store.connect() as db:
        spent = db.execute(
            "select count(*),sum(net_actual) from generation_attempts where net_actual is not null"
        ).fetchone()
    assert spent == (3, 160 if isinstance(provider, Copied) else 0)


def test_retried_round_gets_its_own_attempt_limit_and_short_backoff(jobs):
    class Busy(FixtureProvider):
        def generate(self, context):
            raise RetryableFailure()

    value = checkpoint(jobs)
    job_id = jobs.request_refill(value, "fixture")["job_id"]
    # Each round retries three times within seconds, then waits for the next.
    for start, wait in ((0, 3700), (4000, 7300)):
        for step in range(4):
            at(jobs, start + step * 20)
            jobs.run_once(Busy())
        assert jobs.get(job_id)["state"] == "failed"
        at(jobs, start + wait)
        assert jobs.request_refill(value, "fixture")["status"] == "queued"
    assert jobs.get(job_id)["attempts"] == 6
    assert count(jobs) == 1


def test_settled_failed_manual_job_no_longer_blocks_refills(jobs, payload):
    manual = jobs.enqueue(payload)
    with jobs.store.connect() as db:
        db.execute(
            "update generation_jobs set state='failed',attempts=1 where id=?",
            (manual["id"],),
        )
        db.execute(
            "insert into generation_attempts (job_id,attempt,month,state,gross_reserved,credit_reserved,net_reserved) values (?,1,'2026-09','calling',10,0,10)",
            (manual["id"],),
        )
    # A failed job with an unrecorded charge still blocks.
    assert jobs.request_refill(checkpoint(jobs), "fixture") == {
        "status": "failed",
        "job_id": manual["id"],
    }
    with jobs.store.connect() as db:
        db.execute(
            "update generation_attempts set state='settled',gross_actual=0,credit_actual=0,net_actual=0"
        )
    result = jobs.request_refill(checkpoint(jobs), "fixture")
    assert result["status"] == "queued" and result["job_id"] != manual["id"]


def test_failed_edit_no_longer_holds_back_refills(jobs, guided_skill):
    skill_id, examples = guided_skill
    edit = {
        **jobs.definition(skill_id),
        "request_id": uuid4().hex,
        "description": "A description the fixture rejects.",
    }
    changed = jobs.edit_skill(edit, "fixture")
    value = checkpoint(jobs, skill_id=skill_id)
    assert jobs.request_refill(value, "fixture")["status"] == "awaiting_import"
    assert jobs.run_once(FixtureProvider()) == changed["id"]
    assert jobs.get(changed["id"])["state"] == "failed"
    result = jobs.request_refill(value, "fixture")
    assert result["status"] == "queued"
    with jobs.store.connect() as db:
        assert not db.execute(
            "select 1 from skill_drafts where id=?", (skill_id,)
        ).fetchone()
    assert jobs.run_once(FixtureProvider()) == result["job_id"]
    assert jobs.get(result["job_id"])["state"] == "completed"
    assert jobs.definition(skill_id)["examples"] == examples


def test_operator_release_records_the_charge_and_unblocks_refills(jobs, payload):
    class Lost(FixtureProvider):
        def estimate(self, context):
            return 100

        def generate(self, context):
            raise RuntimeError("connection lost after the request was sent")

    manual = jobs.enqueue(payload)
    jobs.run_once(Lost())
    assert jobs.get(manual["id"])["state"] == "needs_attention"
    value = checkpoint(jobs)
    assert jobs.request_refill(value, "fixture") == {
        "status": "needs_attention",
        "job_id": manual["id"],
    }
    for charge in (-1, 5000001, True, None):
        with pytest.raises(SkillImportError):
            jobs.release(manual["id"], charge)
    marker = jobs.store.path.parent / ".paid-restore-pending"
    marker.write_text("paused")
    with pytest.raises(JobConflict):
        jobs.release(manual["id"], 40)
    marker.unlink()
    history = jobs.history()
    assert history["budget"]["reserved_microusd"] == 100
    assert "refills are paused" in history["jobs"][0]["reason"]
    assert jobs.release(manual["id"], 40) == {
        "job_id": manual["id"],
        "attempt": 1,
        "provider_response_id": None,
        "gross_microusd": 40,
        "net_microusd": 40,
    }
    with pytest.raises(JobConflict):
        jobs.release(manual["id"], 0)
    history = jobs.history()
    assert history["budget"]["reserved_microusd"] == 0
    assert history["budget"]["estimated_spend_microusd"] == 40
    assert (
        history["jobs"][0]["reason"] == "Stopped after checking the provider's records."
    )
    result = jobs.request_refill(value, "fixture")
    assert result["status"] == "queued" and result["job_id"] != manual["id"]


def test_release_cli_is_separate_from_paid_options(jobs, payload, monkeypatch, capsys):
    import sys

    from learnrecur.companion.jobs import main

    manual = jobs.enqueue(payload)
    with jobs.store.connect() as db:
        db.execute(
            "update generation_jobs set state='needs_attention',attempts=1 where id=?",
            (manual["id"],),
        )
        db.execute(
            "insert into generation_attempts (job_id,attempt,month,state,gross_reserved,credit_reserved,net_reserved,response_id) values (?,1,'2026-10','calling',10,0,10,'resp_synthetic')",
            (manual["id"],),
        )
    base = ["jobs", "--data-dir", str(jobs.store.path.parent)]
    release = ["--release-job", manual["id"], "--confirmed-charge-microusd", "0"]
    monkeypatch.setattr(sys, "argv", [*base, *release, "--provider", "openai"])
    with pytest.raises(SystemExit) as failure:
        main()
    assert failure.value.code == 2
    assert jobs.get(manual["id"])["state"] == "needs_attention"
    monkeypatch.setattr(sys, "argv", [*base, *release])
    main()
    assert "resp_synthetic" in capsys.readouterr().out
    assert jobs.get(manual["id"])["state"] == "failed"
