"""History is bounded, read-only, and separates charges from reservations."""

import json
from uuid import uuid4

import pytest

from anki.learnrecur_skill_import import encode
from learnrecur.companion.jobs import FixtureProvider, Jobs
from learnrecur.companion.tests.test_server import request


@pytest.fixture
def jobs(server, batch):
    server.store.import_batch(batch)
    return Jobs(server.store, clock=lambda: 1790888400)


def enqueue(jobs):
    skill = jobs.store.snapshot()["skills"][0]
    return jobs.enqueue(
        {
            "request_id": uuid4().hex,
            "skill_id": skill["id"],
            "revision": skill["bank"]["revision"],
            "count": 1,
        }
    )


def dump(store):
    with store.connect() as db:
        return list(db.iterdump())


def test_authenticated_http_history_never_writes_or_runs_recovery(
    jobs, server, monkeypatch
):
    enqueue(jobs)
    before = dump(jobs.store)
    monkeypatch.setattr(
        Jobs, "_recover", lambda *_: pytest.fail("History ran recovery")
    )
    monkeypatch.setattr(Jobs, "claim", lambda *_: pytest.fail("History claimed a job"))
    for _ in range(2):
        status, history = request(server, path="/v1/generation-history")
        assert status == 200 and len(history["jobs"]) == 1
    assert request(server, token=None, path="/v1/generation-history")[0] == 401
    assert (
        request(server, token="wrong", path="/v1/generation-history?limit=bad")[0]
        == 401
    )
    assert request(server, body={}, path="/v1/generation-history")[0] == 404
    assert dump(jobs.store) == before


def test_newest_first_paging_survives_a_new_job_and_store_restart(jobs):
    ids = [enqueue(jobs)["id"] for _ in range(7)]
    first = jobs.history(limit=3)
    assert [row["id"] for row in first["jobs"]] == ids[::-1][:3]
    enqueue(jobs)
    second = Jobs(jobs.store).history(limit=3, before=first["next_before"])
    third = jobs.history(limit=3, before=second["next_before"])
    assert [row["id"] for row in second["jobs"] + third["jobs"]] == ids[::-1][3:]
    assert third["next_before"] is None
    assert jobs.history(before=1)["jobs"] == []


@pytest.mark.parametrize(
    "query",
    [
        "limit=0",
        "limit=101",
        "limit=2&limit=3",
        "before=0",
        "before=9223372036854775808",
        "limit=50&x=1",
        "limit=1&before=2&x=3",
        "limit=",
        "limit=true",
        "limit=1.5",
    ],
)
def test_invalid_queries_do_not_change_history(jobs, server, query):
    before = dump(jobs.store)
    assert request(server, path="/v1/generation-history?" + query)[0] == 400
    assert dump(jobs.store) == before


def test_creation_edit_and_refill_keep_their_requested_titles(jobs):
    original = jobs.store.snapshot()["skills"][0]
    created = jobs.create_skill(
        {
            "request_id": uuid4().hex,
            "source_id": jobs.store.snapshot()["source_id"],
            "title": "First title",
            "description": original["description"],
            "examples": [],
        },
        "fixture",
    )
    jobs.run_once(FixtureProvider())
    skill = next(
        s for s in jobs.store.snapshot()["skills"] if s["title"] == "First title"
    )
    jobs.edit_skill(
        {
            "request_id": uuid4().hex,
            "source_id": jobs.store.snapshot()["source_id"],
            "skill_id": skill["id"],
            "base_revision": 1,
            "title": "Edited title",
            "description": skill["description"],
            "examples": [],
        },
        "fixture",
    )
    jobs.run_once(FixtureProvider())
    jobs.enqueue(
        {"request_id": uuid4().hex, "skill_id": skill["id"], "revision": 2, "count": 1}
    )
    rows = jobs.history()["jobs"]
    assert [(row["title"], row["action"]) for row in rows] == [
        ("Edited title", "refill"),
        ("Edited title", "edit"),
        ("First title", "create"),
    ]
    assert rows[-1]["id"] == created["id"]


class PricedFixture(FixtureProvider):
    def estimate(self, context):
        return 500

    def generate(self, context):
        result = super().generate(context)
        result["usage"] = {
            "input_tokens": 0,
            "output_tokens": 0,
            "gross_cost_microusd": 300,
        }
        return result


def test_credit_adjusted_spend_and_old_unconfirmed_reservation_are_separate(jobs):
    jobs.configure_budget(1000, credit_total=100, credit_expires=jobs.clock() + 1000)
    settled = enqueue(jobs)
    jobs.run_once(PricedFixture())
    pending = enqueue(jobs)
    job_id, token, _ = jobs.claim(PricedFixture())
    jobs.calling(job_id, token)
    jobs.clock = lambda: 1790888461
    before = dump(jobs.store)
    rows = {row["id"]: row for row in jobs.history()["jobs"]}
    assert rows[settled["id"]]["estimated_spend_microusd"] == 200
    assert rows[settled["id"]]["reserved_microusd"] == 0
    assert rows[pending["id"]]["estimated_spend_microusd"] == 0
    assert rows[pending["id"]]["reserved_microusd"] == 500
    assert rows[pending["id"]]["interrupted"]
    assert "unconfirmed" in rows[pending["id"]]["reason"]
    assert dump(jobs.store) == before
    assert jobs.get(pending["id"])["state"] == "running"
    jobs.clock = lambda: (
        1793570400
    )  # Next month; the old reservation still blocks spending.
    assert jobs.history()["budget"] == {
        "month": "2026-11",
        "limit_microusd": 1000,
        "estimated_spend_microusd": 0,
        "reserved_microusd": 500,
    }


@pytest.mark.parametrize("stage", ["reserved", "saved_response"])
def test_expired_claim_distinguishes_no_call_from_a_retrievable_response(jobs, stage):
    enqueue(jobs)
    job_id, token, _ = jobs.claim(PricedFixture())
    if stage == "saved_response":
        jobs.calling(job_id, token)
        with jobs.store.connect() as db:
            db.execute("update generation_attempts set response_id='resp_private'")
    jobs.clock = lambda: 1790888461
    row = jobs.history()["jobs"][0]
    assert row["interrupted"]
    assert (
        "before contacting"
        if stage == "reserved"
        else "without another generation call"
    ) in row["reason"]
    assert "resp_private" not in json.dumps(row)


def test_failed_output_and_private_errors_are_not_returned(jobs):
    job = enqueue(jobs)
    with jobs.store.connect() as db:
        context = job["context"]
        context["examples"] = [
            {
                "prompt": "private example",
                "answer": "private answer",
                "explanation": "private lesson",
            }
        ]
        context["provider_key"] = "private credential"
        db.execute(
            "update generation_jobs set context=?,state='failed',error=?,result=? where id=?",
            (
                encode(context),
                "private provider output",
                encode({"exercises": ["private generated answer"]}),
                job["id"],
            ),
        )
    encoded = json.dumps(jobs.history())
    assert "private" not in encoded
    assert (
        jobs.history()["jobs"][0]["reason"]
        == "Generation failed. Check the companion logs."
    )


@pytest.mark.parametrize(
    "kind,state,reason",
    [
        ("retry", "retry_wait", "temporarily"),
        ("terminal", "failed", "rejected"),
        ("uncertain", "needs_attention", "unconfirmed"),
        ("billing", "needs_attention", "balance is exhausted"),
    ],
)
def test_failure_states_keep_their_accounting(jobs, kind, state, reason):
    enqueue(jobs)
    job_id, token, _ = jobs.claim(PricedFixture())
    jobs.calling(job_id, token)
    jobs.failure(job_id, token, kind)
    row = jobs.history()["jobs"][0]
    assert row["state"] == state and reason in row["reason"]
    assert row["reserved_microusd"] == (500 if kind in ("uncertain", "billing") else 0)
    assert row["estimated_spend_microusd"] == 0


def test_budget_pause_and_backup_pause_do_not_release_reservations(jobs):
    jobs.configure_budget(0)
    enqueue(jobs)
    assert jobs.claim(PricedFixture()) is None
    row = jobs.history()["jobs"][0]
    assert row["state"] == "waiting_budget" and "budget" in row["reason"]
    assert row["attempts"] == row["reserved_microusd"] == 0
    (jobs.store.path.parent / ".paid-restore-pending").write_text("paused")
    before = dump(jobs.store)
    assert jobs.history()["pause"] == "Paid generation is paused for backup recovery."
    assert dump(jobs.store) == before
