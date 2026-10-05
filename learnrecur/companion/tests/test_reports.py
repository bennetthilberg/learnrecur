"""Delivery retries and report Undo cannot duplicate generation work."""

import copy
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest

from learnrecur.companion.jobs import FixtureProvider, JobConflict, Jobs
from learnrecur.companion.reports import Reports
from learnrecur.companion.server import Store
from learnrecur.companion.tests.test_server import request


def value(store):
    snapshot = store.snapshot()
    skill = snapshot["skills"][0]
    exercise = skill["bank"]["exercises"][0]
    return {
        "report_id": uuid4().hex,
        "source_id": snapshot["source_id"],
        "skill_id": skill["id"],
        "guid": snapshot["identities"][skill["id"]]["guid"],
        "revision": 1,
        "exercise_id": exercise["id"],
        "exercise": exercise,
        "reason": "incorrect",
        "created_at_ms": 123,
        "bank_sequence": 0,
        "version": 1,
        "active": True,
    }


@pytest.fixture
def store(tmp_path, batch):
    store = Store(tmp_path / "companion")
    store.import_batch(batch)
    return store


def test_retry_restart_and_report_versions_share_one_job(store):
    report = value(store)
    original = copy.deepcopy(store.snapshot())
    with ThreadPoolExecutor(max_workers=8) as pool:
        replies = list(
            pool.map(lambda _: Reports(store).receive(report, "fixture"), range(8))
        )
    assert all(r == replies[0] for r in replies)
    job_id = replies[0]["job_id"]
    assert job_id
    job = Jobs(store).get(job_id)
    assert job["context"]["examples"][0]["prompt"] != report["exercise"]["prompt"]
    assert store.snapshot() == original  # Reports don't mutate immutable banks.
    restored = Store(store.path.parent)
    canceled = {**report, "version": 2, "active": False}
    assert not Reports(restored).receive(canceled, "fixture")["active"]
    assert not Reports(restored).receive(report, "fixture")["active"]
    assert (
        Reports(restored).receive({**report, "version": 3}, "fixture")["job_id"]
        == job_id
    )
    Jobs(restored).run_once(FixtureProvider())
    replay = {**report, "version": 3, "bank_sequence": 1}
    assert Reports(restored).receive(replay, "fixture")["job_id"] == job_id
    with restored.connect() as db:
        assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 1
        assert db.execute("select count(*) from generation_attempts").fetchone()[0] == 1


def test_undo_arrives_first_cannot_be_reactivated_by_delayed_report(store):
    report = value(store)
    canceled = {**report, "version": 2, "active": False}
    Reports(store).receive(canceled, "fixture")
    result = Reports(store).receive(report, "fixture")
    assert (result["version"], result["active"], result["job_id"]) == (2, False, None)
    with store.connect() as db:
        assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 0


def test_two_client_reports_keep_independent_undo_and_share_checkpoint(store):
    a, b = value(store), value(store)
    first = Reports(store).receive(a, "fixture")
    second = Reports(store).receive(b, "fixture")
    assert first["job_id"] == second["job_id"]
    Reports(store).receive({**a, "active": False, "version": 2}, "fixture")
    with store.connect() as db:
        assert db.execute("select sum(active) from exercise_reports").fetchone()[0] == 1


@pytest.mark.parametrize(
    "field,wrong",
    [
        ("source_id", "wrong"),
        ("guid", "f" * 32),
        ("revision", 2),
        ("exercise", {}),
        ("exercise_id", "missing"),
    ],
)
def test_forged_or_stale_reports_do_not_enqueue(store, field, wrong):
    report = {**value(store), field: wrong}
    with pytest.raises(JobConflict):
        Reports(store).receive(report, "fixture")
    with store.connect() as db:
        assert db.execute("select count(*) from exercise_reports").fetchone()[0] == 0
        assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 0


def test_conflicting_version_rolls_back_and_old_revision_records_without_work(store):
    report = value(store)
    Reports(store).receive(report, None)
    with pytest.raises(JobConflict):
        Reports(store).receive({**report, "active": False}, "fixture")
    new = copy.deepcopy(store.snapshot()["skills"][0])
    new["bank"]["revision"] = 2
    new["description"] += " Revised."
    store.import_batch({"skills": [new]})
    report["report_id"] = uuid4().hex
    assert Reports(store).receive(report, "fixture")["job_id"] is None


def test_authentication_and_disabled_generation_still_record(server, batch):
    server.store.import_batch(batch)
    report = value(server.store)
    assert request(server, report, token=None, path="/v1/exercise-reports")[0] == 401
    status, receipt = request(server, report, path="/v1/exercise-reports")
    assert (
        status == 200 and receipt["status"] == "disabled" and receipt["job_id"] is None
    )
    server.refill_provider = "fixture"
    assert request(server, report, path="/v1/exercise-reports")[1]["job_id"]


def test_uncertain_job_does_not_erase_report_or_bypass_guard(store):
    report = value(store)
    jobs = Jobs(store)
    existing = jobs.enqueue(
        {
            "request_id": "uncertain",
            "skill_id": report["skill_id"],
            "revision": 1,
            "count": 3,
        }
    )
    with store.connect() as db:
        db.execute(
            "update generation_jobs set state='needs_attention' where id=?",
            (existing["id"],),
        )
    result = Reports(store).receive(report, "fixture")
    assert result["status"] == "needs_attention"
    assert result["job_id"] == existing["id"]
    with store.connect() as db:
        assert db.execute("select count(*) from exercise_reports").fetchone()[0] == 1
        assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 1


def test_another_skills_uncertain_job_blocks_without_owning_replacement(store):
    report = value(store)
    other = copy.deepcopy(store.snapshot()["skills"][0])
    other["id"] = other["bank"]["skill_id"] = "other-skill"
    store.import_batch({"skills": [other]})
    job = Jobs(store).enqueue(
        {
            "request_id": "other-uncertain",
            "skill_id": other["id"],
            "revision": 1,
            "count": 3,
        }
    )
    with store.connect() as db:
        db.execute(
            "update generation_jobs set state='needs_attention' where id=?",
            (job["id"],),
        )
    result = Reports(store).receive(report, "fixture")
    assert result["status"] == "needs_attention" and result["job_id"] is None
    with store.connect() as db:
        assert db.execute("select job_id from exercise_reports").fetchone()[0] is None
        # Simulate completed operator recovery of the unrelated charge.
        db.execute(
            "update generation_jobs set state='obsolete' where id=?", (job["id"],)
        )
    result = Reports(store).receive(report, "fixture")
    assert result["status"] == "queued" and result["job_id"] != job["id"]
    assert (
        Jobs(store).get(result["job_id"])["context"]["skill"]["id"]
        == report["skill_id"]
    )


def test_replacement_capacity_failure_still_saves_report(store, monkeypatch):
    report = value(store)

    def full(*args, **kwargs):
        raise JobConflict("The companion is full.")

    monkeypatch.setattr(Jobs, "_enqueue", full)
    result = Reports(store).receive(report, "fixture")
    assert result["status"] == "blocked" and result["job_id"] is None
    with store.connect() as db:
        assert db.execute("select active from exercise_reports").fetchone()[0] == 1
    result = Reports(store).receive(
        {**report, "version": 2, "active": False}, "fixture"
    )
    assert not result["active"]
