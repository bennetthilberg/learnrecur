"""Check the Claude batch adapter against a fake API, without network or real keys."""

import copy
import json
import os
import subprocess
import sys

import pytest

from learnrecur.companion.anthropic_provider import (
    CONFIG,
    MODEL,
    NAME,
    POLL_SECONDS,
    AnthropicProvider,
    request_body,
)
from learnrecur.companion.jobs import FixtureProvider, Jobs, RetryableFailure
from learnrecur.companion.openai_provider import (
    OpenAIProvider,
    ReadFailure,
    identity,
)
from learnrecur.companion.server import Store
from learnrecur.companion.tests.test_jobs import ROOT, example, jobs, payload
from learnrecur.companion.tests.test_openai_provider import Transport, openai_job

__all__ = ["jobs", "payload"]
SYNTHETIC_KEY = "sk-ant-synthetic-secret-for-tests-only"
NOW = 1790888400


def exercises(count):
    return FixtureProvider().generate(
        {
            "provider": "fixture-spanish-v1",
            "skill": json.loads(
                (ROOT / "learnrecur/fixtures/spanish-import.json").read_text()
            )["skills"][0],
            "count": count,
        }
    )["exercises"]


class Batches:
    """A fake Message Batches API holding one batch."""

    def __init__(self, *, polls=1, outcome="succeeded", extra=0, **message):
        self.calls = []
        self.polls = polls
        self.outcome = outcome
        self.extra = extra
        self.message = message
        self.failure = None
        self.custom_id = None
        self.count = 3

    def batch(self, status):
        return {
            "id": "msgbatch_test",
            "type": "message_batch",
            "processing_status": status,
            "request_counts": {},
        }

    def __call__(self, method, path, body=None, trace=None):
        self.calls.append((method, path, copy.deepcopy(body), trace))
        if self.failure:
            raise self.failure()
        if method == "POST":
            request = body["requests"][0]
            self.custom_id = request["custom_id"]
            self.count = json.loads(request["params"]["messages"][0]["content"])[
                "count"
            ]
            return self.batch("in_progress")
        if path.endswith("/results"):
            items = exercises(self.count)
            items += [dict(items[0], prompt=f"Extra {n}") for n in range(self.extra)]
            message = {
                "id": "msg_test",
                "type": "message",
                "model": MODEL,
                "stop_reason": "end_turn",
                "content": [
                    {"type": "thinking", "thinking": ""},
                    {"type": "text", "text": json.dumps({"exercises": items})},
                ],
                "usage": {
                    "input_tokens": 500,
                    "output_tokens": 100,
                    "cache_creation_input_tokens": 0,
                    "cache_read_input_tokens": 0,
                },
                **self.message,
            }
            result = (
                {"type": "succeeded", "message": message}
                if self.outcome == "succeeded"
                else {"type": self.outcome}
            )
            return [{"custom_id": self.custom_id, "result": result}]
        self.polls -= 1
        return self.batch("ended" if self.polls <= 0 else "in_progress")


def claude_job(jobs, payload):
    return jobs.enqueue({**payload, "provider": "anthropic", "examples": [example()]})


def finish(jobs, provider):
    """Submit, then poll after the provider's wait until the job settles."""
    jobs.run_once(provider)
    for step in range(1, 5):
        jobs.clock = lambda step=step: NOW + step * POLL_SECONDS
        jobs.run_once(provider)


def test_one_batch_request_with_frozen_settings_and_no_stored_key(jobs, payload):
    job = claude_job(jobs, payload)
    assert job["context"]["provider"] == NAME
    assert job["context"]["provider_config"] == CONFIG
    api = Batches()
    jobs.run_once(AnthropicProvider(SYNTHETIC_KEY, transport=api))
    method, path, body, trace = api.calls[0]
    assert (method, path) == ("POST", "/v1/messages/batches")
    [request] = body["requests"]
    assert request["custom_id"] == identity(job["id"], 1)["learnrecur_request_id"]
    assert trace == request["custom_id"]
    params = request["params"]
    assert params["model"] == "claude-sonnet-5-5"
    assert params["output_config"]["effort"] == "high"
    assert params["thinking"] == {"type": "adaptive"}
    assert params["max_tokens"] == 300000
    assert "Return exactly count exercises" in params["system"]
    schema = params["output_config"]["format"]["schema"]
    # Claude rejects array length limits; the count is checked on import.
    assert "minItems" not in json.dumps(schema)
    assert "maxItems" not in json.dumps(schema)
    guidance = json.loads(params["messages"][0]["content"])
    assert guidance["examples"] == [example()]
    assert guidance["count"] == 3
    # Saved before waiting, and polled gently instead of every two seconds.
    saved = jobs.get(job["id"])
    assert saved["state"] == "provider_pending"
    assert saved["provider_response_id"] == "msgbatch_test"
    with jobs.store.connect() as db:
        assert (
            db.execute(
                "select next_run from generation_jobs where id=?", (job["id"],)
            ).fetchone()[0]
            == NOW + POLL_SECONDS
        )
        serialized = "".join(str(row) for row in db.iterdump())
    assert SYNTHETIC_KEY not in serialized


def test_a_finished_batch_publishes_and_records_the_batch_price(jobs, payload):
    job = claude_job(jobs, payload)
    api = Batches(polls=2)
    finish(jobs, AnthropicProvider(SYNTHETIC_KEY, transport=api))
    assert jobs.get(job["id"])["state"] == "completed"
    # 500 input tokens at $1/M and 100 output tokens at $5/M.
    with jobs.store.connect() as db:
        assert db.execute(
            "select gross_actual,net_actual from generation_attempts"
        ).fetchone() == (1000, 1000)
    paths = [path for _, path, _, _ in api.calls]
    assert paths.count("/v1/messages/batches/msgbatch_test") == 2
    assert paths[-1] == "/v1/messages/batches/msgbatch_test/results"


def test_extra_exercises_are_trimmed_to_the_requested_count(jobs, payload):
    job = claude_job(jobs, payload)
    finish(jobs, AnthropicProvider(SYNTHETIC_KEY, transport=Batches(extra=2)))
    assert jobs.get(job["id"])["state"] == "completed"
    with jobs.store.connect() as db:
        published = [
            json.loads(row[0])
            for row in db.execute("select payload from exercise_batches")
        ]
    assert [len(batch["exercises"]) for batch in published] == [3]


@pytest.mark.parametrize("outcome", ["errored", "expired", "canceled"])
def test_unbilled_batch_outcomes_fail_at_no_charge(jobs, payload, outcome):
    job = claude_job(jobs, payload)
    finish(jobs, AnthropicProvider(SYNTHETIC_KEY, transport=Batches(outcome=outcome)))
    assert jobs.get(job["id"])["state"] == "failed"
    with jobs.store.connect() as db:
        assert db.execute(
            "select gross_actual,net_actual from generation_attempts"
        ).fetchone() == (0, 0)
        assert not db.execute(
            "select 1 from generation_jobs where state='needs_attention'"
        ).fetchone()


@pytest.mark.parametrize("stop_reason", ["max_tokens", "refusal"])
def test_unfinished_output_is_charged_but_not_published(jobs, payload, stop_reason):
    job = claude_job(jobs, payload)
    api = Batches(stop_reason=stop_reason)
    finish(jobs, AnthropicProvider(SYNTHETIC_KEY, transport=api))
    assert jobs.get(job["id"])["state"] == "failed"
    with jobs.store.connect() as db:
        assert db.execute("select net_actual from generation_attempts").fetchone() == (
            1000,
        )
        assert not db.execute("select 1 from exercise_batches").fetchone()


def test_another_requests_result_leaves_the_charge_uncertain(jobs, payload):
    job = claude_job(jobs, payload)
    api = Batches()
    provider = AnthropicProvider(SYNTHETIC_KEY, transport=api)
    jobs.run_once(provider)
    api.custom_id = "lr-someone-else-1"
    jobs.clock = lambda: NOW + POLL_SECONDS
    jobs.run_once(provider)
    assert jobs.get(job["id"])["state"] == "needs_attention"


@pytest.mark.parametrize(
    "failure,state",
    [(RetryableFailure, "retry_wait"), (ReadFailure, "provider_pending")],
)
def test_rejections_and_read_failures_stay_out_of_needs_attention(
    jobs, payload, failure, state
):
    job = claude_job(jobs, payload)
    api = Batches()
    provider = AnthropicProvider(SYNTHETIC_KEY, transport=api)
    if failure is ReadFailure:
        jobs.run_once(provider)
        jobs.clock = lambda: NOW + POLL_SECONDS
    api.failure = failure
    jobs.run_once(provider)
    assert jobs.get(job["id"])["state"] == state


def test_switching_providers_moves_only_jobs_that_never_called_the_old_one(
    jobs, payload
):
    first = openai_job(jobs, payload)
    second = openai_job(jobs, {**payload, "request_id": "second"})
    # The worker submits one OpenAI job, which then waits on OpenAI's response.
    jobs.run_once(
        OpenAIProvider(
            "sk-synthetic-secret-for-tests-only", transport=Transport(pending=True)
        )
    )
    submitted, unstarted = sorted(
        (jobs.get(first["id"]), jobs.get(second["id"])),
        key=lambda job: job["state"] != "provider_pending",
    )
    assert (submitted["state"], unstarted["state"]) == ("provider_pending", "queued")
    api = Batches()
    jobs.run_once(AnthropicProvider(SYNTHETIC_KEY, transport=api))
    moved = jobs.get(unstarted["id"])
    assert moved["context"]["provider"] == NAME
    assert moved["context"]["provider_config"] == CONFIG
    assert moved["state"] == "provider_pending"
    assert moved["provider_response_id"] == "msgbatch_test"
    # The submitted OpenAI response stays with OpenAI, which can still bill it.
    kept = jobs.get(submitted["id"])
    assert kept["context"]["provider"] == "openai-responses-v1"
    assert kept["provider_response_id"] == "resp_test"
    assert [path for _, path, _, _ in api.calls] == ["/v1/messages/batches"]


def test_a_job_saved_with_old_settings_runs_with_the_current_ones(jobs, payload):
    # The first deployment saved Haiku at max effort with a 32K cap, which spent
    # every token thinking. A job that hasn't called Claude yet picks up the
    # current model, effort, and cap instead of repeating that.
    job = claude_job(jobs, payload)
    old = {
        **CONFIG,
        "model": "claude-haiku-5-5",
        "max_tokens": 32000,
        "effort": "max",
        "input_usd_per_million": "0.05",
        "cache_write_usd_per_million": "0.0625",
        "cache_read_usd_per_million": "0.005",
        "output_usd_per_million": "0.25",
    }
    del old["beta"]
    with jobs.store.connect() as db:
        context = json.loads(
            db.execute(
                "select context from generation_jobs where id=?", (job["id"],)
            ).fetchone()[0]
        )
        context["provider_config"] = old
        db.execute(
            "update generation_jobs set context=? where id=?",
            (json.dumps(context), job["id"]),
        )
    api = Batches()
    jobs.run_once(AnthropicProvider(SYNTHETIC_KEY, transport=api))
    params = api.calls[0][2]["requests"][0]["params"]
    assert params["model"] == "claude-sonnet-5-5"
    assert params["output_config"]["effort"] == "high"
    assert params["max_tokens"] == 300000
    saved = jobs.get(job["id"])
    assert saved["context"]["provider_config"] == CONFIG
    assert saved["state"] == "provider_pending"


def test_a_batch_submitted_with_old_settings_is_read_and_charged(jobs, payload):
    # A Haiku batch still pending across the upgrade keeps its saved settings,
    # because it's billed at them, and settles instead of needing attention.
    job = claude_job(jobs, payload)
    api = Batches(model="claude-haiku-5-5")
    provider = AnthropicProvider(SYNTHETIC_KEY, transport=api)
    jobs.run_once(provider)
    old = {
        key: value
        for key, value in {
            **CONFIG,
            "model": "claude-haiku-5-5",
            "max_tokens": 32000,
            "effort": "max",
            "input_usd_per_million": "0.05",
            "cache_write_usd_per_million": "0.0625",
            "cache_read_usd_per_million": "0.005",
            "output_usd_per_million": "0.25",
        }.items()
        if key != "beta"
    }
    with jobs.store.connect() as db:
        context = json.loads(
            db.execute(
                "select context from generation_jobs where id=?", (job["id"],)
            ).fetchone()[0]
        )
        context["provider_config"] = old
        db.execute(
            "update generation_jobs set context=? where id=?",
            (json.dumps(context), job["id"]),
        )
    finish(jobs, provider)
    saved = jobs.get(job["id"])
    assert saved["state"] == "completed"
    assert saved["context"]["provider_config"] == old
    # 500 input tokens at $0.05/M and 100 output tokens at $0.25/M.
    with jobs.store.connect() as db:
        assert db.execute(
            "select gross_actual,net_actual from generation_attempts"
        ).fetchone() == (50, 50)


def test_reconcile_reads_a_known_batch_without_resubmitting(jobs, payload):
    job = claude_job(jobs, payload)
    api = Batches()
    provider = AnthropicProvider(SYNTHETIC_KEY, transport=api)
    claimed = jobs.claim(provider)
    jobs.calling(claimed[0], claimed[1])
    jobs.clock = lambda: NOW + 3600
    jobs.run_once(provider)  # The lost claim leaves the charge uncertain.
    assert jobs.get(job["id"])["state"] == "needs_attention"
    api.custom_id = identity(job["id"], 1)["learnrecur_request_id"]
    jobs.reconcile(job["id"], "msgbatch_test", provider)
    assert jobs.get(job["id"])["state"] == "completed"
    assert all(method == "GET" for method, *_ in api.calls)


def test_request_size_and_saved_settings_are_checked(jobs, payload):
    job = claude_job(jobs, payload)
    context = copy.deepcopy(job["context"])
    context["provider_config"]["model"] = "claude-opus-5-5"
    with pytest.raises(ValueError):
        request_body(context)


@pytest.mark.parametrize("status,state", [(401, "failed"), (529, "retry_wait")])
def test_worker_entry_point_treats_rejections_as_rejections(
    jobs, payload, tmp_path, status, state
):
    jobs.configure_budget(2_000_000)
    job = claude_job(jobs, payload)
    keys = tmp_path / "anthropic"
    keys.mkdir(mode=0o700)
    key = keys / "anthropic-api-key"
    key.write_text(SYNTHETIC_KEY)
    key.chmod(0o600)
    script = f"""
import http.client, runpy, sys

class Response:
    status = {status}
    def read(self, *args):
        return b"{{}}"

class Connection:
    def __init__(self, host, *args, **kwargs):
        assert host == "api.anthropic.com"
    def request(self, method, path, body=None, headers=None):
        assert headers["anthropic-version"] == "2026-10-21"
    def getresponse(self):
        return Response()
    def close(self):
        pass

http.client.HTTPSConnection = Connection
sys.argv = ["jobs", "--data-dir", sys.argv[1], "--provider", "anthropic",
            "--allow-paid-generation", "--key-file", sys.argv[2], "--once"]
runpy.run_module("learnrecur.companion.jobs", run_name="__main__", alter_sys=True)
"""
    subprocess.run(
        [sys.executable, "-c", script, str(jobs.store.path.parent), str(key)],
        env={**os.environ, "PYTHONPATH": ".:pylib:out/pylib"},
        check=True,
    )
    reopened = Jobs(Store(jobs.store.path.parent), clock=lambda: NOW + 70)
    assert reopened.get(job["id"])["state"] == state


def test_openai_credits_never_pay_for_claude(jobs, payload):
    # No out-of-pocket allowance, but unexpired OpenAI credits.
    jobs.configure_budget(0, 1_000_000, NOW + 86400)
    job = openai_job(jobs, payload)
    api = Batches()
    jobs.run_once(AnthropicProvider(SYNTHETIC_KEY, transport=api))
    assert jobs.get(job["id"])["context"]["provider"] == NAME
    assert jobs.get(job["id"])["state"] == "waiting_budget"
    assert api.calls == []
    with jobs.store.connect() as db:
        assert not db.execute(
            "select 1 from generation_attempts where credit_reserved>0"
        ).fetchone()


def test_claude_credits_pay_for_claude(jobs, payload):
    jobs.configure_budget(0, 2_000_000, NOW + 86400, credit_provider=NAME)
    job = claude_job(jobs, payload)
    finish(jobs, AnthropicProvider(SYNTHETIC_KEY, transport=Batches()))
    assert jobs.get(job["id"])["state"] == "completed"
    with jobs.store.connect() as db:
        assert db.execute(
            "select gross_actual,credit_actual,net_actual from generation_attempts"
        ).fetchone() == (1000, 1000, 0)
