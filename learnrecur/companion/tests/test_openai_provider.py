"""Check real request parsing and restart behavior without network or real keys."""

import copy
import json
import os
import subprocess
import sys
import threading
from datetime import datetime, timezone

import pytest

from anki.learnrecur_skill_import import SkillImportError
from learnrecur.companion.jobs import FixtureProvider, JobConflict, Jobs
from learnrecur.companion.openai_provider import (
    CONFIG,
    MODEL,
    OpenAIProvider,
    ReadFailure,
    UncertainResponse,
    identity,
)
from learnrecur.companion.server import Store
from learnrecur.companion.tests.test_jobs import ROOT, example, jobs, payload

__all__ = ["jobs", "payload"]
SYNTHETIC_KEY = "sk-synthetic-secret-for-tests-only"


def reply(meta, **changes):
    exercises = FixtureProvider().generate(
        {
            "provider": "fixture-spanish-v1",
            "skill": json.loads(
                (ROOT / "learnrecur/fixtures/spanish-import.json").read_text()
            )["skills"][0],
            "count": 3,
        }
    )["exercises"]
    result = {
        "id": "resp_test",
        "model": MODEL,
        "service_tier": "default",
        "metadata": meta,
        "status": "completed",
        "usage": {
            "input_tokens": 500,
            "output_tokens": 100,
            "total_tokens": 600,
            "input_tokens_details": {"cached_tokens": 100},
            "output_tokens_details": {"reasoning_tokens": 20},
        },
        "output": [
            {
                "type": "message",
                "content": [
                    {
                        "type": "output_text",
                        "text": json.dumps({"exercises": exercises}),
                    }
                ],
            }
        ],
    }
    return {**result, **changes}


class Transport:
    def __init__(self, *, pending=False):
        self.calls = []
        self.meta = None
        self.pending = pending
        self.failure = None

    def __call__(self, method, path, body=None, trace=None):
        self.calls.append((method, path, copy.deepcopy(body), trace))
        if method == "POST":
            self.meta = body["metadata"]
            if self.failure:
                raise self.failure()
            return reply(
                self.meta,
                **(
                    {"status": "queued", "usage": None, "output": []}
                    if self.pending
                    else {}
                ),
            )
        if self.failure:
            raise self.failure()
        return reply(self.meta)


def openai_job(jobs, payload):
    return jobs.enqueue({**payload, "provider": "openai", "examples": [example()]})


def test_request_freezes_settings_and_examples_without_storing_credentials(
    jobs, payload
):
    job = openai_job(jobs, payload)
    transport = Transport()
    jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=transport))
    assert jobs.get(job["id"])["state"] == "completed"
    method, path, body, trace = transport.calls[0]
    assert (method, path) == ("POST", "/v1/responses")
    assert body["model"] == MODEL and body["service_tier"] == "default"
    assert body["background"] is True and body["store"] is True
    assert body["max_output_tokens"] == 16384
    assert body["reasoning"] == {"effort": "xhigh"}
    assert body["prompt_cache_options"] == {"mode": "explicit"}
    assert body["text"]["format"]["strict"] is True
    assert body["text"]["format"]["schema"]["additionalProperties"] is False
    guidance = json.loads(body["input"])
    assert guidance["examples"] == [example()]
    assert guidance["skill"]["description"] == job["context"]["skill"]["description"]
    assert len(guidance["existing_prompts"]) == 3
    assert trace == identity(job["id"], 1)["learnrecur_request_id"]
    assert job["context"]["provider_config"] == CONFIG
    with jobs.store.connect() as db:
        assert db.execute(
            "select gross_actual,net_actual from generation_attempts"
        ).fetchone() == (91, 91)
        serialized = "".join(str(row) for row in db.iterdump())
    assert SYNTHETIC_KEY not in serialized
    assert jobs.get(job["id"])["provider_response_id"] == "resp_test"
    assert jobs.enqueue(job["request"])["provider_response_id"] == "resp_test"


def test_fixture_worker_never_claims_an_openai_job(jobs, payload):
    job = openai_job(jobs, payload)
    assert jobs.run_once(FixtureProvider()) is None
    assert jobs.get(job["id"])["attempts"] == 0


def test_pending_response_resumes_after_restart_with_get_only(jobs, payload):
    job = openai_job(jobs, payload)
    transport = Transport(pending=True)
    provider = OpenAIProvider(SYNTHETIC_KEY, transport=transport)
    jobs.run_once(provider)
    assert jobs.get(job["id"])["state"] == "provider_pending"
    restored = Jobs(Store(jobs.store.path.parent), clock=lambda: 1790888410)
    restored.run_once(provider)
    restored.run_once(provider)
    assert [c[0] for c in transport.calls] == ["POST", "GET"]
    assert restored.get(job["id"])["attempts"] == 1
    assert len(restored.store.snapshot()["bank_updates"][payload["skill_id"]]) == 1


def test_only_one_worker_can_poll_the_same_response(jobs, payload):
    job = openai_job(jobs, payload)
    transport = Transport(pending=True)
    jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=transport))
    jobs.clock = lambda: 1790888410
    claims = []
    workers = [
        threading.Thread(
            target=lambda: claims.append(jobs._resume(OpenAIProvider(SYNTHETIC_KEY)))
        )
        for _ in range(4)
    ]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join()
    assert sum(c is not None for c in claims) == 1
    assert jobs.get(job["id"])["attempts"] == 1


def test_timeout_does_not_resubmit_and_can_reconcile_a_confirmed_id(jobs, payload):
    job = openai_job(jobs, payload)
    transport = Transport()
    transport.failure = TimeoutError
    provider = OpenAIProvider(SYNTHETIC_KEY, transport=transport)
    jobs.run_once(provider)
    assert jobs.get(job["id"])["state"] == "needs_attention"
    jobs.clock = lambda: 1790888600
    jobs.run_once(provider)
    assert len(transport.calls) == 1
    with jobs.store.connect() as db:
        assert db.execute("select net_actual from generation_attempts").fetchone() == (
            None,
        )
    transport.failure = None
    assert jobs.reconcile(job["id"], "resp_test", provider)["state"] == "completed"
    assert [c[0] for c in transport.calls] == ["POST", "GET"]
    assert jobs.get(job["id"])["attempts"] == 1


def test_reconciliation_refuses_an_unrelated_response(jobs, payload):
    job = openai_job(jobs, payload)
    transport = Transport()
    transport.failure = TimeoutError
    provider = OpenAIProvider(SYNTHETIC_KEY, transport=transport)
    jobs.run_once(provider)
    transport.failure = None
    transport.meta = identity("other-job", 1)
    with pytest.raises(UncertainResponse):
        jobs.reconcile(job["id"], "resp_test", provider)
    assert jobs.get(job["id"])["state"] == "needs_attention"
    assert "bank_updates" not in jobs.store.snapshot()


@pytest.mark.parametrize(
    "status", ["incomplete", "failed", "cancelled", "refusal", "bad_json"]
)
def test_known_charged_failure_records_usage_without_publishing(jobs, payload, status):
    job = openai_job(jobs, payload)

    def transport(method, path, body=None, trace=None):
        response = reply(body["metadata"])
        if status in {"refusal", "bad_json"}:
            response["output"][0]["content"] = (
                [{"type": "refusal", "refusal": "private response"}]
                if status == "refusal"
                else [{"type": "output_text", "text": "invalid"}]
            )
        else:
            response["status"] = status
        return response

    jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=transport))
    result = jobs.get(job["id"])
    assert result["state"] == "failed" and result["usage"]["gross_cost_microusd"] == 91
    assert "private" not in str(result)
    assert "bank_updates" not in jobs.store.snapshot()


@pytest.mark.parametrize(
    "damage",
    [
        "model",
        "tier",
        "metadata",
        "usage",
        "cache",
        "output_bound",
        "input_bound",
        "total",
        "writes",
    ],
)
def test_uncertain_accounting_retains_reservation(jobs, payload, damage):
    job = openai_job(jobs, payload)

    def transport(method, path, body=None, trace=None):
        response = reply(body["metadata"])
        if damage == "model":
            response["model"] = "different-model"
        if damage == "tier":
            response["service_tier"] = "priority"
        if damage == "metadata":
            response["metadata"] = {}
        if damage == "usage":
            response["usage"] = None
        if damage == "cache":
            response["usage"]["input_tokens_details"]["cached_tokens"] = 501
        if damage == "writes":
            response["usage"]["input_tokens_details"]["cache_write_tokens"] = 401
        if damage == "output_bound":
            response["usage"].update(output_tokens=16385, total_tokens=16885)
        if damage == "input_bound":
            response["usage"].update(input_tokens=100000, total_tokens=100100)
        if damage == "total":
            response["usage"]["total_tokens"] = 0
        return response

    jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=transport))
    assert jobs.get(job["id"])["state"] == "needs_attention"
    with jobs.store.connect() as db:
        assert (
            db.execute(
                "select net_reserved,net_actual from generation_attempts"
            ).fetchone()[0]
            > 0
        )
        assert (
            db.execute("select net_actual from generation_attempts").fetchone()[0]
            is None
        )


def test_repeated_read_failure_keeps_response_id_for_manual_recovery(jobs, payload):
    job = openai_job(jobs, payload)
    transport = Transport(pending=True)
    provider = OpenAIProvider(SYNTHETIC_KEY, transport=transport)
    jobs.run_once(provider)
    transport.failure = ReadFailure
    for n in range(3):
        jobs.clock = lambda n=n: 1790888410 + n * 30
        jobs.run_once(provider)
    assert jobs.get(job["id"])["state"] == "needs_attention"
    assert jobs.get(job["id"])["provider_response_id"] == "resp_test"
    assert [c[0] for c in transport.calls] == ["POST", "GET", "GET", "GET"]
    transport.failure = None
    assert jobs.reconcile(job["id"], "resp_test", provider)["state"] == "completed"


def test_description_change_while_pending_records_cost_and_retires_output(
    jobs, payload
):
    job = openai_job(jobs, payload)
    transport = Transport(pending=True)
    provider = OpenAIProvider(SYNTHETIC_KEY, transport=transport)
    jobs.run_once(provider)
    jobs.store.import_batch(
        json.loads((ROOT / "learnrecur/fixtures/spanish-revision.json").read_text())
    )
    jobs.clock = lambda: 1790888410
    jobs.run_once(provider)
    assert jobs.get(job["id"])["state"] == "obsolete"
    assert jobs.get(job["id"])["usage"]["gross_cost_microusd"] == 91
    assert "bank_updates" not in jobs.store.snapshot()


def test_budget_blocks_submission_before_transport_is_called(jobs, payload):
    jobs.configure_budget(1)
    job = openai_job(jobs, payload)
    transport = Transport()
    assert jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=transport)) is None
    assert jobs.get(job["id"])["state"] == "waiting_budget" and not transport.calls


def test_oversized_guidance_is_rejected_before_a_job_is_saved(jobs, payload):
    with pytest.raises(SkillImportError):
        jobs.enqueue(
            {
                **payload,
                "provider": "openai",
                "examples": [
                    {
                        "prompt": "p" * 8192,
                        "answer": "a" * 8192,
                        "explanation": "e" * 8192,
                    }
                ]
                * 2,
            }
        )
    with jobs.store.connect() as db:
        assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 0


@pytest.mark.parametrize("saved", [False, True])
def test_process_death_around_response_id_commit_never_resubmits(jobs, payload, saved):
    job = openai_job(jobs, payload)
    script = """
import os,sys
from pathlib import Path
from learnrecur.companion.server import Store
from learnrecur.companion.jobs import Jobs
from learnrecur.companion.openai_provider import OpenAIProvider,MODEL
jobs=Jobs(Store(Path(sys.argv[1])),clock=lambda:1790888400)
original=jobs.submitted
def die(job,token,response):
    if sys.argv[2]=='True': original(job,token,response)
    os._exit(74)
jobs.submitted=die
def transport(method,path,body=None,trace=None):
    return {'id':'resp_test','model':MODEL,'service_tier':'default','metadata':body['metadata'],'status':'queued'}
jobs.run_once(OpenAIProvider('synthetic',transport=transport))
"""
    process = subprocess.run(
        [sys.executable, "-c", script, str(jobs.store.path.parent), str(saved)],
        env={**os.environ, "PYTHONPATH": ".:pylib:out/pylib"},
        check=False,
    )
    assert process.returncode == 74
    restored = Jobs(Store(jobs.store.path.parent), clock=lambda: 1790888470)
    transport = Transport()
    transport.meta = identity(job["id"], 1)
    restored.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=transport))
    assert restored.get(job["id"])["state"] == (
        "completed" if saved else "needs_attention"
    )
    assert [c[0] for c in transport.calls] == (["GET"] if saved else [])


def test_late_worker_cannot_attach_or_settle_an_expired_claim(jobs, payload):
    job = openai_job(jobs, payload)
    provider = OpenAIProvider(SYNTHETIC_KEY)
    claimed = jobs.claim(provider)
    jobs.calling(claimed[0], claimed[1])
    jobs.clock = lambda: 1790888470
    with pytest.raises(JobConflict):
        jobs.submitted(claimed[0], claimed[1], reply(identity(job["id"], 1)))
    jobs.run_once(provider)
    assert jobs.get(job["id"])["state"] == "needs_attention"


@pytest.mark.parametrize(
    "method,status,exception",
    [
        ("POST", 400, "TerminalFailure"),
        ("POST", 401, "TerminalFailure"),
        ("POST", 403, "TerminalFailure"),
        ("POST", 429, "RetryableFailure"),
        ("POST", 500, "UncertainResponse"),
        ("POST", 302, "UncertainResponse"),
        ("GET", 429, "ReadFailure"),
        ("GET", 503, "ReadFailure"),
        ("GET", 401, "UncertainResponse"),
        ("GET", 404, "UncertainResponse"),
    ],
)
def test_http_statuses_never_follow_redirects_or_retry_implicitly(
    monkeypatch, method, status, exception
):
    import http.client

    from learnrecur.companion.jobs import RetryableFailure, TerminalFailure

    errors = {
        "TerminalFailure": TerminalFailure,
        "RetryableFailure": RetryableFailure,
        "UncertainResponse": UncertainResponse,
        "ReadFailure": ReadFailure,
    }
    calls = []

    class Connection:
        def __init__(self, host, timeout):
            assert host == "api.openai.com" and timeout == 20

        def request(self, *args, **kwargs):
            calls.append((args, kwargs))

        def getresponse(self):
            return type("Reply", (), {"status": status})()

        def close(self):
            calls.append("closed")

    monkeypatch.setattr(http.client, "HTTPSConnection", Connection)
    monkeypatch.setenv("HTTPS_PROXY", "http://example.invalid:4321")
    with pytest.raises(errors[exception]):
        OpenAIProvider(SYNTHETIC_KEY)._http(
            method, "/v1/responses", {"input": "synthetic"}, "test-trace"
        )
    assert len(calls) == 2 and calls[-1] == "closed"
    assert calls[0][1]["headers"]["Authorization"] == "Bearer " + SYNTHETIC_KEY
    assert calls[0][1]["headers"]["X-Client-Request-Id"] == "test-trace"


@pytest.mark.parametrize("method", ["POST", "GET"])
def test_transport_timeout_is_uncertain_for_post_and_retryable_for_get(
    monkeypatch, method
):
    import http.client

    class Connection:
        def __init__(self, host, timeout):
            pass

        def request(self, *args, **kwargs):
            raise TimeoutError("private details")

        def close(self):
            pass

    monkeypatch.setattr(http.client, "HTTPSConnection", Connection)
    with pytest.raises(
        UncertainResponse if method == "POST" else ReadFailure
    ) as failure:
        OpenAIProvider(SYNTHETIC_KEY)._http(method, "/v1/responses")
    assert str(failure.value) == ""


def test_http_response_is_bounded_and_key_stays_out_of_body(monkeypatch):
    import http.client

    requests = []

    class Connection:
        def __init__(self, host, timeout):
            pass

        def request(self, *args, **kwargs):
            requests.append(kwargs)

        def getresponse(self):
            return self

        status = 200

        def read(self, limit):
            assert limit == 1048577
            return b"x" * limit

        def close(self):
            pass

    monkeypatch.setattr(http.client, "HTTPSConnection", Connection)
    with pytest.raises(UncertainResponse):
        OpenAIProvider(SYNTHETIC_KEY)._http(
            "POST", "/v1/responses", {"input": "synthetic"}
        )
    assert SYNTHETIC_KEY.encode() not in requests[0]["body"]


def test_saved_batch_from_adapter_imports_and_reviews_through_native_backend(
    jobs, payload, tmp_path
):
    from anki.collection import Collection
    from anki.learnrecur_skill_import import import_snapshot
    from anki.learnrecur_skills import select_skill_review
    from tests.test_learnrecur_skill_import import rate, state

    col = Collection(str(tmp_path / "synthetic.anki2"))
    try:
        import_snapshot(col, jobs.store.snapshot())
        cid = rate(col)
        original = state(col)
        job = openai_job(jobs, payload)
        transport = Transport(pending=True)
        provider = OpenAIProvider(SYNTHETIC_KEY, transport=transport)
        jobs.run_once(provider)
        jobs.clock = lambda: 1790888410
        Jobs(Store(jobs.store.path.parent), clock=jobs.clock).run_once(provider)
        assert jobs.get(job["id"])["state"] == "completed"
        assert import_snapshot(col, jobs.store.snapshot()).updated == 1
        assert state(col)[1:] == original[1:]
        after = state(col)
        col.undo()
        assert state(col) == original
        col.redo()
        assert state(col) == after
        rate(col)
        rate(col)
        review = select_skill_review(col.get_card(cid))
        assert review.exercise.answer == "canté"
        rate(col)
        col.undo()
        assert select_skill_review(col.get_card(cid)).exercise.answer == "canté"
        col.redo()
        col.close()
        col.reopen()
        assert select_skill_review(col.get_card(cid)).exercise.answer == "bailé"
        assert col.card_count() == 1
    finally:
        col.close()


def test_cli_requires_paid_flag_before_loading_the_key(monkeypatch, tmp_path):
    from learnrecur.companion import credentials
    from learnrecur.companion.jobs import main

    def unexpected(path):
        pytest.fail("Key must not be loaded before explicit paid opt-in.")

    monkeypatch.setattr(credentials, "load_key", unexpected)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "jobs",
            "--data-dir",
            str(tmp_path / "companion"),
            "--provider",
            "openai",
            "--once",
        ],
    )
    with pytest.raises(SystemExit) as failure:
        main()
    assert failure.value.code == 2


def test_new_jobs_avoid_prompts_from_previous_published_batches(jobs, payload):
    job = openai_job(jobs, payload)
    jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=Transport()))
    assert jobs.get(job["id"])["state"] == "completed"
    next_job = jobs.enqueue({**payload, "request_id": "next-job", "provider": "openai"})
    assert len(next_job["context"]["existing_prompts"]) == 6
    assert any("canción" in p for p in next_job["context"]["existing_prompts"])


def test_unknown_charges_keep_budget_reserved_across_months(jobs, payload):
    transport = Transport()
    transport.failure = TimeoutError
    provider = OpenAIProvider(SYNTHETIC_KEY, transport=transport)
    job = openai_job(jobs, payload)
    jobs.configure_budget(provider.estimate(job["context"]))
    jobs.run_once(provider)
    jobs.clock = lambda: 1793653200
    another = jobs.enqueue({**payload, "request_id": "november", "provider": "openai"})
    jobs.run_once(provider)
    assert jobs.get(another["id"])["state"] == "waiting_budget"
    assert len(transport.calls) == 1


def test_a_call_after_midnight_uses_the_new_month_budget(jobs, payload):
    start = datetime(2026, 9, 30, 23, 59, 50, tzinfo=timezone.utc).timestamp()
    jobs.clock = lambda: start
    transport = Transport()
    provider = OpenAIProvider(SYNTHETIC_KEY, transport=transport)
    job = openai_job(jobs, payload)
    jobs.configure_budget(provider.estimate(job["context"]))
    job_id, token, context = jobs.claim(provider)
    jobs.clock = lambda: start + 20
    assert jobs.calling(job_id, token)
    meta = identity(job_id, 1)
    response = provider.submit(context, meta)
    jobs.submitted(job_id, token, response)
    jobs.save_result(job_id, token, provider.result(response, context, meta))
    jobs.publish(job_id)
    another = jobs.enqueue({**payload, "request_id": "october", "provider": "openai"})
    jobs.run_once(provider)
    assert jobs.get(another["id"])["state"] == "waiting_budget"
    assert len(transport.calls) == 1
    with jobs.store.connect() as db:
        assert db.execute("select month from generation_attempts").fetchone() == (
            "2026-10",
        )


@pytest.mark.parametrize("contacted_provider", [False, True])
def test_legacy_jobs_upgrade_without_losing_reservations_or_retry_safety(
    jobs, payload, contacted_provider
):
    class PricedFixture(FixtureProvider):
        def estimate(self, context):
            return 100

    provider = PricedFixture()
    jobs.configure_budget(200)
    job = jobs.enqueue(payload)
    claimed = jobs.claim(provider)
    if contacted_provider:
        assert jobs.calling(claimed[0], claimed[1])
    snapshot = jobs.store.snapshot()
    with jobs.store.connect() as db:
        db.execute("drop index generation_response_ids")
        db.execute("alter table generation_attempts drop column response_id")
        db.execute("alter table generation_attempts drop column poll_failures")
        attempts = db.execute("select * from generation_attempts").fetchall()
    restored = Jobs(Store(jobs.store.path.parent), clock=lambda: 1790888461)
    assert restored.store.snapshot() == snapshot
    assert restored.get(job["id"])["request"] == job["request"]
    with restored.store.connect() as db:
        assert [
            row[:10] for row in db.execute("select * from generation_attempts")
        ] == attempts
    restored.run_once(provider)
    result = restored.get(job["id"])
    if contacted_provider:
        assert result["state"] == "needs_attention" and result["attempts"] == 1
        with restored.store.connect() as db:
            assert db.execute(
                "select net_reserved,net_actual from generation_attempts"
            ).fetchone() == (100, None)
    else:
        assert result["state"] == "completed" and result["attempts"] == 2


def test_same_budget_can_be_reused_after_a_restart_without_resetting_spend(
    jobs, payload
):
    jobs.configure_budget(250000)
    openai_job(jobs, payload)
    jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=Transport()))
    jobs.configure_budget(250000)
    with pytest.raises(JobConflict):
        jobs.configure_budget(5000000)
    with jobs.store.connect() as db:
        assert db.execute("select net_actual from generation_attempts").fetchone() == (
            91,
        )


def test_cache_write_tokens_use_their_own_rate_without_double_counting(jobs, payload):
    job = openai_job(jobs, payload)

    def transport(method, path, body=None, trace=None):
        response = reply(body["metadata"])
        response["usage"]["input_tokens_details"]["cache_write_tokens"] = 100
        return response

    jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=transport))
    assert jobs.get(job["id"])["state"] == "completed"
    # 300 ordinary + 100 cached + 100 written + 100 output tokens = $0.0000935.
    assert jobs.get(job["id"])["usage"]["gross_cost_microusd"] == 94


def test_credit_balance_failure_is_actionable_and_never_declared_free(jobs, payload):
    job = openai_job(jobs, payload)
    calls = []

    def transport(method, path, body=None, trace=None):
        calls.append(method)
        return reply(
            body["metadata"],
            status="failed",
            usage=None,
            error={
                "code": "credit_balance_exhausted",
                "message": "private provider details",
            },
        )

    provider = OpenAIProvider(SYNTHETIC_KEY, transport=transport)
    jobs.run_once(provider)
    jobs.run_once(provider)
    result = jobs.get(job["id"])
    assert (
        result["state"] == "needs_attention"
        and "balance is exhausted" in result["error"]
    )
    assert "private provider" not in str(result) and calls == ["POST"]
    with jobs.store.connect() as db:
        assert db.execute("select net_actual from generation_attempts").fetchone() == (
            None,
        )
