"""Deleted skills leave the snapshot and stop generation, keeping recorded spending."""

import copy
from uuid import uuid4

import pytest

from anki.learnrecur_skill_import import validate_snapshot
from learnrecur.companion.jobs import FixtureProvider, JobConflict, Jobs
from learnrecur.companion.retirements import Retirements
from learnrecur.companion.server import Conflict, Store
from learnrecur.companion.tests.test_server import batch, request, server

__all__ = ["batch", "server"]

SKILL = "spanish-ar-preterite-yo"
OTHER = "spanish-ar-preterite-other"


@pytest.fixture
def two_skills(batch):
    other = copy.deepcopy(batch["skills"][0])
    other["id"] = other["bank"]["skill_id"] = OTHER
    return {"skills": [batch["skills"][0], other]}


@pytest.fixture
def jobs(tmp_path, two_skills):
    store = Store(tmp_path / "companion")
    store.import_batch(two_skills)
    return Jobs(store, clock=lambda: 1790888400)


def retirement(store, skill_id=SKILL, **changes):
    snapshot = store.snapshot()
    identity = snapshot["identities"][skill_id]
    return {
        "retirement_id": uuid4().hex,
        "version": 1,
        "active": True,
        "source_id": snapshot["source_id"],
        "skill_id": skill_id,
        "guid": identity["guid"],
        "native_id": identity["native_id"],
        **changes,
    }


def checkpoint(store, skill_id=SKILL):
    return {
        "source_id": store.snapshot()["source_id"],
        "skill_id": skill_id,
        "revision": 1,
        "bank_sequence": 0,
        "remaining": 2,
    }


class Costly(FixtureProvider):
    """A synthetic charge, so tests can check that spending is kept."""

    def __init__(self, during_call=None):
        self.during_call = during_call

    def estimate(self, context):
        return 10

    def generate(self, context):
        if self.during_call:
            self.during_call()
        result = super().generate(context)
        result["usage"]["gross_cost_microusd"] = 7
        return result


def test_retired_skill_leaves_the_snapshot_and_stays_out_after_restart(
    jobs, two_skills
):
    store = jobs.store
    assert jobs.request_refill(checkpoint(store), "fixture")["job_id"]
    assert jobs.run_once(FixtureProvider())
    value = retirement(store)
    receipt = Retirements(store).receive(value)
    assert receipt == {
        "retirement_id": value["retirement_id"],
        "version": 1,
        "active": True,
        "status": "retired",
    }
    for current in (store, Store(store.path.parent)):
        snapshot = current.snapshot()
        validate_snapshot(snapshot)
        assert [s["id"] for s in snapshot["skills"]] == [OTHER]
        assert set(snapshot["identities"]) == {OTHER}
        assert SKILL not in snapshot.get("bank_updates", {})
    # Identical retries succeed and still leave it out; a new revision can't revive it.
    assert [s["id"] for s in store.import_batch(two_skills)["skills"]] == [OTHER]
    revised = copy.deepcopy(two_skills["skills"][0])
    revised["bank"]["revision"] = 2
    with pytest.raises(Conflict, match="deleted"):
        store.import_batch({"skills": [revised]})
    # The stored rows remain, and the existing quotas still count them.
    with store.connect() as db:
        assert db.execute("select count(*) from skills").fetchone()[0] == 2
        assert db.execute("select count(*) from exercise_batches").fetchone()[0] == 1


def test_refills_reports_and_edits_are_refused_after_retirement(jobs):
    store = jobs.store
    Retirements(store).receive(retirement(store))
    with pytest.raises(JobConflict, match="deleted"):
        jobs.request_refill(checkpoint(store), "fixture")
    with pytest.raises(JobConflict, match="deleted"):
        jobs.enqueue(
            {"request_id": "manual", "skill_id": SKILL, "revision": 1, "count": 1}
        )
    with pytest.raises(JobConflict, match="no longer available"):
        jobs.definition(SKILL)
    # Other skills keep working.
    other = jobs.request_refill(checkpoint(store, OTHER), "fixture")
    assert jobs.run_once(FixtureProvider()) == other["job_id"]
    assert jobs.get(other["job_id"])["state"] == "completed"


def test_reports_for_a_retired_skill_get_a_distinct_refusal(jobs):
    from learnrecur.companion.reports import Reports
    from learnrecur.companion.retirements import RETIRED_ERROR
    from learnrecur.companion.tests.test_reports import value as report_value

    store = jobs.store
    report = report_value(store)
    Retirements(store).receive(retirement(store, report["skill_id"]))
    with pytest.raises(JobConflict) as error:
        Reports(store).receive(report, "fixture")
    # The client treats exactly this message as final for that one report.
    assert str(error.value) == RETIRED_ERROR
    with store.connect() as db:
        assert db.execute("select count(*) from exercise_reports").fetchone()[0] == 0


def test_waiting_jobs_become_obsolete_and_spending_is_kept(jobs):
    store = jobs.store
    first = jobs.request_refill(checkpoint(store), "fixture")
    assert jobs.run_once(Costly()) == first["job_id"]
    with store.connect() as db:
        # Import of the published batch moves the checkpoint forward.
        sequence = db.execute(
            "select max(sequence) from exercise_batches where skill_id=?", (SKILL,)
        ).fetchone()[0]
    queued = jobs.request_refill(
        {**checkpoint(store), "bank_sequence": sequence}, "fixture"
    )
    assert jobs.get(queued["job_id"])["state"] == "queued"
    before = jobs.history()["budget"]
    Retirements(store).receive(retirement(store))
    assert jobs.get(queued["job_id"])["state"] == "obsolete"
    history = {job["id"]: job for job in jobs.history()["jobs"]}
    assert history[queued["job_id"]]["reason"] == (
        "The skill was deleted before this job finished."
    )
    # Generation history still shows the earlier, settled charge.
    assert history[first["job_id"]]["estimated_spend_microusd"] == 7
    assert jobs.history()["budget"] == before
    assert jobs.run_once(Costly()) is None


def test_running_job_finishes_its_call_but_never_publishes(jobs):
    store = jobs.store
    job = jobs.request_refill(checkpoint(store), "fixture")
    value = retirement(store)
    provider = Costly(during_call=lambda: Retirements(store).receive(value))
    assert jobs.run_once(provider) == job["job_id"]
    assert jobs.get(job["job_id"])["state"] == "obsolete"
    assert jobs.get(job["job_id"])["error"] == "The skill was deleted."
    with store.connect() as db:
        assert db.execute("select count(*) from exercise_batches").fetchone()[0] == 0
        assert db.execute(
            "select state,net_actual from generation_attempts"
        ).fetchall() == [("settled", 7)]


def test_claimed_job_abandons_its_reservation_before_calling(jobs):
    store = jobs.store
    job = jobs.request_refill(checkpoint(store), "fixture")
    job_id, token, _ = jobs.claim(Costly())
    assert job_id == job["job_id"]
    Retirements(store).receive(retirement(store))
    assert not jobs.calling(job_id, token)
    assert jobs.get(job_id)["state"] == "obsolete"
    with store.connect() as db:
        assert db.execute(
            "select state,net_actual from generation_attempts"
        ).fetchall() == [("abandoned", 0)]


def test_versions_withdrawal_and_identity_checks(jobs):
    store = jobs.store
    queued = jobs.request_refill(checkpoint(store), "fixture")
    value = retirement(store)
    receiver = Retirements(store)
    assert receiver.receive(value)["status"] == "retired"
    assert receiver.receive(value)["status"] == "retired"  # A lost reply retries.
    with pytest.raises(JobConflict, match="different state"):
        receiver.receive({**value, "active": False})
    # Undo on the client withdraws it with a newer version.
    withdrawn = {**value, "version": 2, "active": False}
    assert receiver.receive(withdrawn) == {
        "retirement_id": value["retirement_id"],
        "version": 2,
        "active": False,
        "status": "active",
    }
    # A delayed copy of the first request can't retire it again.
    assert receiver.receive(value)["version"] == 2
    assert SKILL in {s["id"] for s in store.snapshot()["skills"]}
    # The obsolete refill resumes in the same row instead of a new job.
    resumed = jobs.request_refill(checkpoint(store), "fixture")
    assert resumed == {"status": "queued", "job_id": queued["job_id"]}
    assert jobs.run_once(FixtureProvider()) == queued["job_id"]
    assert jobs.get(queued["job_id"])["state"] == "completed"
    with pytest.raises(JobConflict, match="another skill"):
        receiver.receive({**value, "version": 3, "skill_id": "unknown-skill"})
    with pytest.raises(JobConflict, match="different identity"):
        receiver.receive(retirement(store, guid="f" * 32))
    with pytest.raises(JobConflict, match="this companion"):
        receiver.receive(retirement(store, source_id=str(uuid4())))
    # A request for a skill this store doesn't have changes nothing.
    unknown = retirement(store, skill_id=OTHER)
    unknown["skill_id"] = "unknown-skill"
    assert receiver.receive(unknown)["status"] == "unknown"
    assert len(store.snapshot()["skills"]) == 2


def test_endpoint_is_authenticated_and_validates_requests(server, batch):
    assert request(server, batch)[0] == 200
    value = retirement(server.store)
    path = "/v1/skill-retirements"
    assert request(server, value, token="wrong", path=path)[0] == 401
    assert request(server, {**value, "version": 0}, path=path)[0] == 400
    assert request(server, {**value, "extra": 1}, path=path)[0] == 400
    status, receipt = request(server, value, path=path)
    assert (status, receipt["status"]) == (200, "retired")
    assert request(server)[1]["skills"] == []
