"""Resume paid generation on a restored copy after losing the original host."""

import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import Mock

import pytest

from learnrecur.companion.jobs import HOST_LOSS_ERROR, JobConflict, Jobs
from learnrecur.companion.openai_provider import OpenAIProvider, UncertainResponse
from learnrecur.companion.server import Store
from learnrecur.companion.tests.test_openai_provider import SYNTHETIC_KEY, Transport
from learnrecur.deploy import backup
from learnrecur.deploy.backup import create_archive, inspect_generation, restore_archive
from learnrecur.deploy.manage import Deployment
from learnrecur.deploy.recovery import (
    PAID_PAUSE,
    RECEIPT,
    RETIRED,
    RecoveryRefused,
    release_paid_after_loss,
)
from learnrecur.deploy.tests.test_backup import REVISION, state, tables

__all__ = ["state"]

LATER = datetime(2030, 1, 15, tzinfo=timezone.utc).timestamp()


def clock():
    return LATER


def job(jobs, name):
    return jobs.enqueue(
        {
            "request_id": name,
            "skill_id": "spanish-ar-preterite-yo",
            "revision": 1,
            "count": 3,
            "provider": "openai",
        }
    )


def restore(source, tmp_path, name="restored"):
    archive = tmp_path / (name + ".tar.gz")
    create_archive(source, archive, REVISION)
    target = tmp_path / name
    restore_archive(archive, target, REVISION)
    return target


def paused(target):
    return [
        (target / "companion" / name).exists()
        for name in (".restore-pending", PAID_PAUSE)
    ]


def adjustments(target):
    with sqlite3.connect(target / "companion/skills.sqlite3") as db:
        return db.execute(
            "select month,gross_actual,net_actual from generation_attempts where job_id like 'host-loss-%'"
        ).fetchall()


@pytest.mark.parametrize(
    "problem", ["confirmation", "usage", "handoff", "active", "retired"]
)
def test_refuses_without_every_condition_and_changes_nothing(state, tmp_path, problem):
    target = restore(state, tmp_path)
    confirmed, usage = True, 0
    if problem == "confirmation":
        confirmed = False
    elif problem == "usage":
        usage = -1
    elif problem == "handoff":
        (target / RECEIPT).write_text("{}")
    elif problem == "active":
        target = state
    else:
        (target / "companion" / RETIRED).write_text("a" * 32)
    before = tables(target / "companion/skills.sqlite3")
    markers = paused(target)
    with pytest.raises(RecoveryRefused):
        release_paid_after_loss(target, usage, confirmed, clock=clock)
    assert tables(target / "companion/skills.sqlite3") == before
    assert paused(target) == markers


def test_saved_response_must_be_reconciled_first(state, tmp_path):
    transport = Transport(pending=True)
    provider = OpenAIProvider(SYNTHETIC_KEY, transport=transport)
    pending = job(Jobs(Store(state / "companion")), "pending")
    Jobs(Store(state / "companion")).run_once(provider)
    target = restore(state, tmp_path)
    with pytest.raises(RecoveryRefused, match="reconcile-openai.*resp_test"):
        release_paid_after_loss(target, 0, True, clock=clock)
    assert paused(target) == [True, True]
    assert adjustments(target) == []
    restored = Jobs(Store(target / "companion"))
    assert restored.reconcile(pending["id"], "resp_test", provider)["state"] == (
        "completed"
    )
    release_paid_after_loss(target, 0, True, clock=clock)
    assert paused(target) == [False, False]
    assert [call[0] for call in transport.calls] == ["POST", "GET"]
    assert restored.get(pending["id"])["attempts"] == 1


def test_records_usage_once_settles_in_flight_jobs_and_keeps_ceiling(state, tmp_path):
    jobs = Jobs(Store(state / "companion"))
    failing = Transport()
    failing.failure = TimeoutError
    uncertain = job(jobs, "uncertain")
    jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=failing))
    assert jobs.get(uncertain["id"])["state"] == "needs_attention"
    unused = OpenAIProvider(SYNTHETIC_KEY, transport=Transport())
    unsubmitted = job(jobs, "unsubmitted")
    assert jobs.claim(unused)[0] == unsubmitted["id"]
    submitted = job(jobs, "submitted")
    claimed = jobs.claim(unused)
    assert claimed[0] == submitted["id"] and jobs.calling(*claimed[:2])
    target = restore(state, tmp_path)
    report = inspect_generation(target)
    assert report["backup_created_at"] and report["paid_restore_paused"]

    result = release_paid_after_loss(target, 1234, True, clock=clock)

    assert result["month"] == "2030-01" and result["usage_microusd"] == 1234
    assert paused(target) == [False, False]
    assert adjustments(target) == [("2030-01", 1234, 1234)]
    restored = Jobs(Store(target / "companion"), clock=clock)
    assert restored.get(unsubmitted["id"])["state"] == "queued"
    with restored.store.connect() as db:
        rows = dict(
            (row[0], row[1:])
            for row in db.execute(
                "select job_id,state,month,gross_reserved,net_actual from generation_attempts"
            )
        )
        logged = db.execute(
            "select recorded_at,backup_created_at,usage_microusd from generation_recoveries"
        ).fetchall()
    assert rows[unsubmitted["id"]][0] == "abandoned"
    assert rows[unsubmitted["id"]][3] == 0
    for item in (uncertain, submitted):
        assert restored.get(item["id"])["state"] == "failed"
        state_, month, reserved, actual = rows[item["id"]]
        # Uncertain attempts keep their month and count at their full hold.
        assert state_ == "settled" and month != "2030-01" and actual == reserved > 0
    assert logged == [(LATER, report["backup_created_at"], 1234)]
    assert inspect_generation(target)["host_loss_releases"][0]["month"] == "2030-01"
    reasons = {entry["id"]: entry["reason"] for entry in restored.history()["jobs"]}
    assert reasons[uncertain["id"]] == "Stopped during backend recovery."
    with restored.store.connect() as db:
        assert db.execute(
            "select count(*) from generation_jobs where error=?", (HOST_LOSS_ERROR,)
        ).fetchone() == (2,)

    # The stated usage counts toward this month's ceiling.
    transport = Transport()
    provider = OpenAIProvider(SYNTHETIC_KEY, transport=transport)
    estimate = provider.estimate(restored.get(unsubmitted["id"])["context"])
    restored.configure_budget(estimate + 1233)
    restored.run_once(provider)
    assert restored.get(unsubmitted["id"])["state"] == "waiting_budget"
    assert transport.calls == []
    restored.configure_budget(estimate + 1234)
    restored.clock = lambda: LATER + 61
    restored.run_once(provider)
    assert restored.get(unsubmitted["id"])["state"] == "completed"
    # Only the job that never reached the provider runs again, once.
    assert [call[0] for call in transport.calls] == ["POST"]
    for item in (uncertain, submitted):
        assert restored.get(item["id"])["state"] == "failed"


def test_retry_after_interruption_records_usage_once(state, tmp_path, monkeypatch):
    target = restore(state, tmp_path)
    original = Path.unlink

    def interrupted(path, *args, **kwargs):
        if path.name == PAID_PAUSE:
            raise OSError("interrupted")
        return original(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", interrupted)
        with pytest.raises(OSError):
            release_paid_after_loss(target, 500, True, clock=clock)
    assert (target / "companion" / PAID_PAUSE).exists()
    with pytest.raises(JobConflict, match="paused"):
        Jobs(Store(target / "companion")).run_once(
            OpenAIProvider(SYNTHETIC_KEY, transport=Transport())
        )
    with pytest.raises(RecoveryRefused, match="already recorded 500"):
        release_paid_after_loss(target, 600, True, clock=clock)
    release_paid_after_loss(target, 500, True, clock=clock)
    assert paused(target) == [False, False]
    assert adjustments(target) == [("2030-01", 500, 500)]
    with pytest.raises(RecoveryRefused, match="isn't paused"):
        release_paid_after_loss(target, 500, True, clock=clock)
    assert adjustments(target) == [("2030-01", 500, 500)]


def test_older_marker_gets_an_id_before_anything_is_recorded(
    state, tmp_path, monkeypatch
):
    target = restore(state, tmp_path)
    marker = target / "companion" / PAID_PAUSE
    marker.write_text(
        "Paid calls after this backup may be missing. Keep paid generation paused.\n"
    )
    original = Jobs.settle_after_host_loss

    def crash(self, *args):
        raise OSError("interrupted")

    monkeypatch.setattr(Jobs, "settle_after_host_loss", crash)
    with pytest.raises(OSError):
        release_paid_after_loss(target, 42, True, clock=clock)
    saved = marker.read_text().split("restore_id=")[1].strip()
    monkeypatch.setattr(Jobs, "settle_after_host_loss", original)
    result = release_paid_after_loss(target, 42, True, clock=clock)
    assert result["restore_id"] == saved
    assert result["backup_created_at"] is None
    assert adjustments(target) == [("2030-01", 42, 42)]


def test_each_restore_records_its_own_usage(state, tmp_path):
    first = restore(state, tmp_path)
    release_paid_after_loss(first, 100, True, clock=clock)
    second = restore(first, tmp_path, "second")
    assert paused(second) == [True, True]
    release_paid_after_loss(second, 7, True, clock=clock)
    assert sorted(adjustments(second)) == [("2030-01", 7, 7), ("2030-01", 100, 100)]


def test_helper_prints_a_plain_refusal(state, tmp_path, monkeypatch, capsys):
    target = restore(state, tmp_path)
    monkeypatch.setattr(
        "sys.argv",
        [
            "backup",
            "release-paid-after-loss",
            "--root",
            str(target),
            "--post-backup-usage-microusd",
            "0",
        ],
    )
    with pytest.raises(SystemExit) as exit:
        backup.main()
    assert exit.value.code == 1
    assert "--confirm-original-host-lost" in capsys.readouterr().err
    assert paused(target) == [True, True]


def test_manager_refuses_while_running_and_never_starts_the_worker(state, tmp_path):
    deployment = Deployment(state, tmp_path / "credentials", "learnrecur:synthetic")
    deployment.verify_containers = Mock()
    deployment.running = Mock(return_value={"companion"})
    deployment.helper = Mock()
    deployment.compose = Mock()
    for usage, confirmed in ((0, False), (None, True), (0, True)):
        with pytest.raises(RecoveryRefused):
            deployment.release_paid_after_loss(usage, confirmed)
    deployment.helper.assert_not_called()
    deployment.running.return_value = set()
    deployment.release_paid_after_loss(250, True)
    mounts, *arguments = deployment.helper.call_args.args
    assert mounts == [(deployment.state, "/state", False)]
    assert arguments == [
        "release-paid-after-loss",
        "--root",
        "/state",
        "--post-backup-usage-microusd",
        "250",
        "--confirm-original-host-lost",
    ]
    deployment.compose.assert_not_called()
    deployment.release_paid_after_loss(0, True, ["a" * 32])
    assert deployment.helper.call_args.args[-2:] == (
        "--settle-unretrievable-job",
        "a" * 32,
    )
    with pytest.raises(RecoveryRefused, match="job ID"):
        deployment.release_paid_after_loss(0, True, ["not-a-job"])


def unretrievable(state, tmp_path):
    """Restore a pending paid job whose saved response OpenAI no longer has."""
    pending = job(Jobs(Store(state / "companion")), "expired")
    Jobs(Store(state / "companion")).run_once(
        OpenAIProvider(SYNTHETIC_KEY, transport=Transport(pending=True))
    )
    target = restore(state, tmp_path)
    gone = Transport()
    gone.failure = UncertainResponse
    restored = Jobs(Store(target / "companion"))
    with pytest.raises(UncertainResponse):
        restored.reconcile(
            pending["id"], "resp_test", OpenAIProvider(SYNTHETIC_KEY, transport=gone)
        )
    assert restored.get(pending["id"])["state"] == "provider_pending"
    return target, restored, pending["id"]


def test_unretrievable_response_blocks_until_named(state, tmp_path):
    target, restored, job_id = unretrievable(state, tmp_path)
    before = tables(target / "companion/skills.sqlite3")
    with pytest.raises(RecoveryRefused, match="--settle-unretrievable-job"):
        release_paid_after_loss(target, 0, True, clock=clock)
    # Naming a job that isn't waiting on a saved response settles nothing.
    other = job(restored, "queued")["id"]
    before = tables(target / "companion/skills.sqlite3")
    for names in ([other], [job_id, other], ["f" * 32]):
        with pytest.raises(RecoveryRefused, match="Nothing changed"):
            release_paid_after_loss(target, 0, True, unretrievable=names, clock=clock)
    assert tables(target / "companion/skills.sqlite3") == before
    assert paused(target) == [True, True]


def test_named_unretrievable_response_settles_at_full_hold_once(
    state, tmp_path, monkeypatch
):
    target, restored, job_id = unretrievable(state, tmp_path)
    bank = restored.store.snapshot().get("bank_updates")
    original = Path.unlink

    def interrupted(path, *args, **kwargs):
        if path.name == PAID_PAUSE:
            raise OSError("interrupted")
        return original(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", interrupted)
        with pytest.raises(OSError):
            release_paid_after_loss(
                target, 300, True, unretrievable=[job_id], clock=clock
            )
    assert (target / "companion" / PAID_PAUSE).exists()
    result = release_paid_after_loss(
        target, 300, True, unretrievable=[job_id], clock=clock
    )
    assert paused(target) == [False, False]
    assert result["settled"][0]["action"] == "settled_unretrievable"
    assert result["settled"][0]["response_id"] == "resp_test"
    assert restored.get(job_id)["state"] == "failed"
    with restored.store.connect() as db:
        assert db.execute(
            "select state,gross_reserved,net_actual,gross_reserved=net_actual from generation_attempts where job_id=?",
            (job_id,),
        ).fetchone()[3]
        logged = db.execute("select settled from generation_recoveries").fetchall()
    assert len(logged) == 1 and job_id in logged[0][0]
    assert adjustments(target) == [("2030-01", 300, 300)]
    # No batch was published from the unknown output.
    assert restored.store.snapshot().get("bank_updates") == bank
    transport = Transport()
    restored.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=transport))
    assert restored.get(job_id)["state"] == "failed"
    assert transport.calls == []
