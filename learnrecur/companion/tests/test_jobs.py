"""Check durable job recovery, budget accounting, and optional examples."""

import copy
import json
import threading
from pathlib import Path

import pytest

from anki.learnrecur_skill_import import SkillImportError
from learnrecur.companion.jobs import (
    FixtureProvider,
    JobConflict,
    Jobs,
    RetryableFailure,
    TerminalFailure,
)
from learnrecur.companion.server import Store
from learnrecur.companion.tests.test_server import request

ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def jobs(tmp_path):
    store = Store(tmp_path / "companion")
    store.import_batch(
        json.loads((ROOT / "learnrecur/fixtures/spanish-import.json").read_text())
    )
    return Jobs(store, clock=lambda: 1790888400)


@pytest.fixture
def payload():
    return {
        "request_id": "example-request",
        "skill_id": "spanish-ar-preterite-yo",
        "revision": 1,
        "count": 3,
    }


def example():
    return {
        "prompt": "Ayer yo ___ español. (estudiar)",
        "answer": "estudié",
        "explanation": "Replace -ar with -é: estudiar → estudié.",
    }


def test_examples_are_optional_frozen_guidance_and_not_published(jobs, payload):
    payload["examples"] = [example()]
    job = jobs.enqueue(payload)
    payload["examples"][0]["answer"] = "changed"
    assert jobs.get(job["id"])["context"]["examples"][0]["answer"] == "estudié"
    assert jobs.enqueue(job["request"])["id"] == job["id"]
    with pytest.raises(JobConflict):
        jobs.enqueue(payload)
    contexts = []

    class Recording(FixtureProvider):
        def generate(self, context):
            contexts.append(copy.deepcopy(context))
            return super().generate(context)

    assert jobs.run_once(Recording()) == job["id"]
    assert jobs.get(job["id"])["state"] == "completed"
    snapshot = jobs.store.snapshot()
    assert snapshot["skills"][0]["bank"]["revision"] == 1
    assert len(snapshot["skills"][0]["bank"]["exercises"]) == 3
    generated = snapshot["bank_updates"][payload["skill_id"]][0]
    assert len(generated["exercises"]) == 3
    assert example()["prompt"] not in [e["prompt"] for e in generated["exercises"]]
    assert contexts[0]["examples"] == [example()]
    restored = Jobs(Store(jobs.store.path.parent))
    assert restored.get(job["id"])["state"] == "completed"
    restored.publish(job["id"])
    assert restored.store.snapshot() == snapshot


@pytest.mark.parametrize(
    "damage",
    [
        "examples_type",
        "example_missing",
        "example_big",
        "example_control",
        "too_many",
        "count",
        "revision",
    ],
)
def test_invalid_request_never_creates_a_job(jobs, payload, damage):
    if damage == "examples_type":
        payload["examples"] = "text"
    if damage == "example_missing":
        payload["examples"] = [{"prompt": "x"}]
    if damage == "example_big":
        payload["examples"] = [{**example(), "prompt": "x" * 8193}]
    if damage == "example_control":
        payload["examples"] = [{**example(), "prompt": "\x00"}]
    if damage == "too_many":
        payload["examples"] = [example()] * 6
    if damage == "count":
        payload["count"] = True
    if damage == "revision":
        payload["revision"] = 2
    with pytest.raises(SkillImportError):
        jobs.enqueue(payload)
    with jobs.store.connect() as db:
        assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 0


def test_concurrent_requests_share_one_job_and_one_claim(jobs, payload):
    results = []
    threads = [
        threading.Thread(target=lambda: results.append(jobs.enqueue(payload)))
        for _ in range(4)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(results) == 4 and len({r["id"] for r in results}) == 1
    claims = []
    threads = [
        threading.Thread(target=lambda: claims.append(jobs.claim(FixtureProvider())))
        for _ in range(3)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(c is not None for c in claims) == 1


def test_restart_before_call_can_resume_but_after_call_requires_attention(
    jobs, payload
):
    first = jobs.enqueue(payload)
    job_id, token, context = jobs.claim(FixtureProvider())
    jobs.clock = lambda: 1790888461
    claim = jobs.claim(FixtureProvider())
    assert claim[0] == first["id"] and claim[1] != token
    with pytest.raises(JobConflict):
        jobs.calling(job_id, token)
    jobs.calling(claim[0], claim[1])
    with pytest.raises(JobConflict):
        jobs.calling(claim[0], claim[1])
    jobs.clock = lambda: 1790888522
    assert jobs.claim(FixtureProvider()) is None
    assert jobs.get(first["id"])["state"] == "needs_attention"
    with pytest.raises(JobConflict):
        jobs.save_result(claim[0], claim[1], FixtureProvider().generate(context))
    assert "bank_updates" not in jobs.store.snapshot()


def test_saved_output_resumes_publication_without_another_call(jobs, payload):
    job = jobs.enqueue(payload)
    job_id, token, context = jobs.claim(FixtureProvider())
    jobs.calling(job_id, token)
    jobs.save_result(job_id, token, FixtureProvider().generate(context))
    restored = Jobs(Store(jobs.store.path.parent))

    class NoCalls(FixtureProvider):
        def generate(self, context):
            raise AssertionError("Saved output should be reused")

    assert restored.run_once(NoCalls()) == job["id"]
    assert restored.get(job["id"])["state"] == "completed"


@pytest.mark.parametrize("stage", ["queued", "saved"])
def test_revision_change_keeps_old_output_out_of_bank(jobs, payload, stage):
    job = jobs.enqueue(payload)
    if stage == "saved":
        job_id, token, context = jobs.claim(FixtureProvider())
        jobs.calling(job_id, token)
        jobs.save_result(job_id, token, FixtureProvider().generate(context))
    jobs.store.import_batch(
        json.loads((ROOT / "learnrecur/fixtures/spanish-revision.json").read_text())
    )
    jobs.run_once(FixtureProvider())
    assert jobs.get(job["id"])["state"] == "obsolete"
    assert "bank_updates" not in jobs.store.snapshot()


@pytest.mark.parametrize(
    "failure,state",
    [
        (RetryableFailure, "failed"),
        (TerminalFailure, "failed"),
        (RuntimeError, "needs_attention"),
    ],
)
def test_failures_are_bounded_and_unknown_cost_is_not_retried(
    jobs, payload, failure, state
):
    job = jobs.enqueue(payload)

    class Broken(FixtureProvider):
        def generate(self, context):
            raise failure("private provider details must not be stored")

    for attempt in range(5):
        jobs.clock = lambda attempt=attempt: 1790888400 + attempt * 100
        jobs.run_once(Broken())
    result = jobs.get(job["id"])
    assert result["state"] == state
    assert result["attempts"] == (3 if failure is RetryableFailure else 1)
    assert "private" not in result["error"]
    assert "bank_updates" not in jobs.store.snapshot()


class Priced(FixtureProvider):
    def estimate(self, context):
        return 100

    def generate(self, context):
        result = super().generate(context)
        result["usage"] = {
            "input_tokens": 20,
            "output_tokens": 30,
            "gross_cost_microusd": 80,
        }
        return result


def test_budget_reservations_credits_expiry_and_actual_usage(jobs, payload):
    jobs.configure_budget(50, 60, 1790888500)
    first = jobs.enqueue(payload)
    claimed = jobs.claim(Priced())
    assert claimed is not None  # $0.000100 gross, $0.000060 credit, $0.000040 net.
    second = jobs.enqueue({**payload, "request_id": "second"})
    assert (
        jobs.claim(Priced()) is None
    )  # The first reservation holds the credit and budget.
    assert jobs.get(second["id"])["state"] == "waiting_budget"
    jobs.calling(claimed[0], claimed[1])
    jobs.save_result(claimed[0], claimed[1], Priced().generate(claimed[2]))
    jobs.publish(first["id"])
    with jobs.store.connect() as db:
        assert db.execute(
            "select gross_actual,credit_actual,net_actual from generation_attempts"
        ).fetchone() == (80, 60, 20)
    jobs.clock = lambda: 1790888501
    assert jobs.claim(Priced()) is None  # Expired credits cannot fund another job.
    # Settled usage retains the month in which the call started.
    with jobs.store.connect() as db:
        assert (
            db.execute("select month from generation_attempts").fetchone()[0]
            == "2026-10"
        )


def test_uncertain_provider_attempt_keeps_reservation(jobs, payload):
    jobs.configure_budget(100)
    first = jobs.enqueue(payload)

    class Lost(Priced):
        def generate(self, context):
            raise TimeoutError()

    jobs.run_once(Lost())
    assert jobs.get(first["id"])["state"] == "needs_attention"
    second = jobs.enqueue({**payload, "request_id": "second"})
    assert jobs.run_once(Priced()) is None
    assert jobs.get(second["id"])["state"] == "waiting_budget"
    with jobs.store.connect() as db:
        assert db.execute(
            "select net_reserved,net_actual from generation_attempts"
        ).fetchone() == (100, None)


@pytest.mark.parametrize("damage", ["count", "duplicate", "example", "schema"])
def test_rejected_results_record_cost_without_publication(jobs, payload, damage):
    payload["examples"] = [example()]
    job = jobs.enqueue(payload)

    class Invalid(Priced):
        def generate(self, context):
            result = super().generate(context)
            if damage == "count":
                result["exercises"].pop()
            if damage == "duplicate":
                result["exercises"][1] = copy.deepcopy(result["exercises"][0])
            if damage == "example":
                result["exercises"][0] = example()
            if damage == "schema":
                result["exercises"][0]["answer"] = ""
            return result

    jobs.run_once(Invalid())
    assert jobs.get(job["id"])["state"] == "failed"
    assert "bank_updates" not in jobs.store.snapshot()
    with jobs.store.connect() as db:
        assert (
            db.execute("select net_actual from generation_attempts").fetchone()[0] == 80
        )


def test_http_jobs_require_auth_and_retry_survives_restart(server, batch, payload):
    request(server, batch)
    assert request(server, payload, token="wrong", path="/v1/generation-jobs")[0] == 401
    status, first = request(server, payload, path="/v1/generation-jobs")
    assert status == 200 and first["state"] == "queued"
    assert request(server, payload, path="/v1/generation-jobs") == (200, first)
    assert request(server, path=f"/v1/generation-jobs/{first['id']}") == (200, first)
    Jobs(Store(server.store.path.parent)).run_once(FixtureProvider())
    assert (
        request(server, path=f"/v1/generation-jobs/{first['id']}")[1]["state"]
        == "completed"
    )


def test_expired_credit_is_rechecked_before_contacting_provider(jobs, payload):
    jobs.configure_budget(50, 60, 1790888401)
    job = jobs.enqueue(payload)
    claimed = jobs.claim(Priced())
    jobs.clock = lambda: 1790888402
    assert not jobs.calling(claimed[0], claimed[1])
    assert jobs.get(job["id"])["state"] == "waiting_budget"
    with jobs.store.connect() as db:
        assert (
            db.execute("select net_actual from generation_attempts").fetchone()[0] == 0
        )


def test_revision_change_between_claim_and_call_releases_reservation(jobs, payload):
    job = jobs.enqueue(payload)
    claimed = jobs.claim(Priced())
    jobs.store.import_batch(
        json.loads((ROOT / "learnrecur/fixtures/spanish-revision.json").read_text())
    )
    assert not jobs.calling(claimed[0], claimed[1])
    assert jobs.get(job["id"])["state"] == "obsolete"


@pytest.mark.parametrize("committed", [False, True])
def test_process_death_during_publication_is_safe_to_resume(jobs, payload, committed):
    import os
    import subprocess
    import sys

    job = jobs.enqueue(payload)
    claimed = jobs.claim(FixtureProvider())
    jobs.calling(claimed[0], claimed[1])
    jobs.save_result(claimed[0], claimed[1], FixtureProvider().generate(claimed[2]))
    script = """
import os,sys
from pathlib import Path
from learnrecur.companion.server import Store
from learnrecur.companion.jobs import Jobs
store=Store(Path(sys.argv[1]))
if sys.argv[3]=='False':
    store._snapshot=lambda db: os._exit(74)
Jobs(store).publish(sys.argv[2])
os._exit(75)
"""
    process = subprocess.run(
        [
            sys.executable,
            "-c",
            script,
            str(jobs.store.path.parent),
            job["id"],
            str(committed),
        ],
        env={**os.environ, "PYTHONPATH": ".:pylib:out/pylib"},
        check=False,
    )
    assert process.returncode == (75 if committed else 74)
    restored = Jobs(Store(jobs.store.path.parent))
    assert restored.get(job["id"])["state"] == (
        "completed" if committed else "result_ready"
    )
    restored.run_once(FixtureProvider())
    assert restored.get(job["id"])["state"] == "completed"
    assert len(restored.store.snapshot()["bank_updates"][payload["skill_id"]]) == 1
