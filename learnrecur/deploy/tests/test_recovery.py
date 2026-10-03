"""Recover post-backup history only from a stopped, retired source."""

import sqlite3
from unittest.mock import Mock

import pytest

from learnrecur.companion.jobs import FixtureProvider, JobConflict, Jobs
from learnrecur.companion.openai_provider import OpenAIProvider
from learnrecur.companion.server import Server, Store
from learnrecur.companion.tests.test_openai_provider import SYNTHETIC_KEY, Transport
from learnrecur.deploy.backup import create_archive, inspect_generation, restore_archive
from learnrecur.deploy.manage import Deployment
from learnrecur.deploy.recovery import (
    RETIRED,
    allow_paid_worker,
    require_active,
    retire_source,
)
from learnrecur.deploy.run_sync_server import server_environment
from learnrecur.deploy.tests.test_backup import REVISION, state, tables

__all__ = ["state"]


def job(jobs, name="later"):
    return jobs.enqueue(
        {
            "request_id": name,
            "skill_id": "spanish-ar-preterite-yo",
            "revision": 1,
            "count": 3,
            "provider": "openai",
        }
    )


def handoff(state, tmp_path):
    value = retire_source(state)
    archive = tmp_path / "final.tar.gz"
    create_archive(state, archive, REVISION, handoff=True)
    target = tmp_path / "replacement"
    restore_archive(archive, target, REVISION)
    return value, target


def test_later_job_charge_exercises_and_reviews_survive_final_handoff(state, tmp_path):
    old = tmp_path / "old.tar.gz"
    create_archive(state, old, REVISION)
    jobs = Jobs(Store(state / "companion"))
    later = job(jobs)
    transport = Transport()
    jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=transport))
    with sqlite3.connect(state / "sync/user/collection.anki2") as db:
        db.execute("insert into reviews values (124,3)")
    outdated = tmp_path / "outdated"
    restore_archive(old, outdated, REVISION)
    with pytest.raises(JobConflict, match="Unknown"):
        Jobs(Store(outdated / "companion")).get(later["id"])
    with pytest.raises(OSError):
        allow_paid_worker(outdated, "a" * 32, True)
    assert (outdated / "companion/.paid-restore-pending").exists()
    value, replacement = handoff(state, tmp_path)
    assert tables(state / "companion/skills.sqlite3") == tables(
        replacement / "companion/skills.sqlite3"
    )
    assert tables(state / "sync/user/collection.anki2") == tables(
        replacement / "sync/user/collection.anki2"
    )
    report = inspect_generation(replacement)
    assert report["months"][0]["recorded_microusd"] == 91
    assert report["attempts"][0]["response_id"] == "resp_test"
    allow_paid_worker(replacement, value, True)
    allow_paid_worker(replacement, value, True)  # Retry before starting writers.
    assert not (replacement / "companion/.paid-restore-pending").exists()
    assert not (replacement / "companion/.restore-pending").exists()
    assert [call[0] for call in transport.calls] == ["POST"]
    for name in ("sync", "companion"):
        with pytest.raises(ValueError, match="retired"):
            require_active(state / name)
    with pytest.raises(JobConflict, match="paused"):
        jobs.run_once(FixtureProvider())
    with pytest.raises(ValueError, match="retired"):
        server_environment(state / "sync", 45331, "synthetic:password")
    with pytest.raises(ValueError, match="retired"):
        Server(jobs.store, "t" * 32, 0)


@pytest.mark.parametrize("damage", ["confirmation", "id", "changed", "wal", "retired"])
def test_release_refuses_incomplete_or_changed_evidence(state, tmp_path, damage):
    value, target = handoff(state, tmp_path)
    confirmed = True
    if damage == "confirmation":
        confirmed = False
    elif damage == "id":
        value = "0" * 32
    elif damage == "changed":
        with sqlite3.connect(target / "companion/skills.sqlite3") as db:
            db.execute("update generation_budget set monthly_limit=1")
    elif damage == "wal":
        (target / "companion/skills.sqlite3-wal").write_bytes(b"uncheckpointed")
    else:
        (target / "companion" / RETIRED).write_text(value)
    with pytest.raises(ValueError):
        allow_paid_worker(target, value, confirmed)
    assert (target / "companion/.paid-restore-pending").exists()


@pytest.mark.parametrize("pending", [True, False])
def test_pending_or_unknown_provider_charge_stays_paused(state, tmp_path, pending):
    jobs = Jobs(Store(state / "companion"))
    job(jobs)
    transport = Transport(pending=pending)
    if not pending:
        transport.failure = TimeoutError
    jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=transport))
    value, target = handoff(state, tmp_path)
    with pytest.raises(ValueError, match="Unsettled"):
        allow_paid_worker(target, value, True)
    assert (target / "companion/.paid-restore-pending").exists()
    assert [call[0] for call in transport.calls] == ["POST"]


def test_known_response_can_settle_on_retired_source_without_another_call(
    state, tmp_path
):
    jobs = Jobs(Store(state / "companion"))
    later = job(jobs)
    transport = Transport(pending=True)
    provider = OpenAIProvider(SYNTHETIC_KEY, transport=transport)
    jobs.run_once(provider)
    retire_source(state)
    assert jobs.reconcile(later["id"], "resp_test", provider)["state"] == "completed"
    value, target = handoff(state, tmp_path)
    allow_paid_worker(target, value, True)
    assert [call[0] for call in transport.calls] == ["POST", "GET"]
    assert Jobs(Store(target / "companion")).get(later["id"])["attempts"] == 1


def test_claim_before_retirement_cannot_start_a_call_afterward(state, tmp_path):
    jobs = Jobs(Store(state / "companion"))
    job(jobs)
    claimed = jobs.claim(OpenAIProvider(SYNTHETIC_KEY, transport=Transport()))
    retire_source(state)
    with pytest.raises(JobConflict, match="retired"):
        jobs.calling(claimed[0], claimed[1])
    with pytest.raises(JobConflict, match="retired"):
        job(jobs, "another")
    assert jobs.get(claimed[0])["state"] == "queued"
    with jobs.store.connect() as db:
        assert db.execute(
            "select state,gross_actual,credit_actual,net_actual from generation_attempts"
        ).fetchone() == ("abandoned", 0, 0, 0)
    value, target = handoff(state, tmp_path)
    allow_paid_worker(target, value, True)
    transport = Transport()
    restored = Jobs(Store(target / "companion"))
    restored.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=transport))
    assert restored.get(claimed[0])["state"] == "completed"
    assert [call[0] for call in transport.calls] == ["POST"]


def test_retirement_keeps_attempts_that_might_have_called_held(state, tmp_path):
    jobs = Jobs(Store(state / "companion"))
    job(jobs)
    claimed = jobs.claim(OpenAIProvider(SYNTHETIC_KEY, transport=Transport()))
    assert jobs.calling(claimed[0], claimed[1])
    value, target = handoff(state, tmp_path)
    with pytest.raises(ValueError, match="Unsettled"):
        allow_paid_worker(target, value, True)
    with jobs.store.connect() as db:
        assert db.execute(
            "select state,net_actual from generation_attempts"
        ).fetchone() == ("calling", None)


def test_handoff_metadata_requires_matching_source_fences(state, tmp_path):
    with pytest.raises(OSError):
        create_archive(state, tmp_path / "missing.tar.gz", REVISION, handoff=True)
    retire_source(state)
    (state / "sync" / RETIRED).write_text("0" * 32)
    with pytest.raises(ValueError, match="same retirement"):
        create_archive(state, tmp_path / "conflict.tar.gz", REVISION, handoff=True)


def test_retirement_retries_after_one_store_was_fenced(state):
    (state / "sync" / RETIRED).write_text("b" * 32)
    assert retire_source(state) == "b" * 32
    assert retire_source(state) == "b" * 32


def test_interrupted_marker_release_still_blocks_paid_calls(
    state, tmp_path, monkeypatch
):
    from pathlib import Path

    value, target = handoff(state, tmp_path)
    original = Path.unlink

    def interrupted(path, *args, **kwargs):
        if path.name == ".paid-restore-pending":
            raise OSError("interrupted")
        return original(path, *args, **kwargs)

    with monkeypatch.context() as patch:
        patch.setattr(Path, "unlink", interrupted)
        with pytest.raises(OSError):
            allow_paid_worker(target, value, True)
    assert (target / "companion/.paid-restore-pending").exists()
    jobs = Jobs(Store(target / "companion"))
    with pytest.raises(JobConflict, match="paused"):
        jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=Transport()))
    allow_paid_worker(target, value, True)


def test_manager_retires_before_stopping_and_never_restarts_source(state, tmp_path):
    deployment = Deployment(state, tmp_path / "credentials", "learnrecur:synthetic")
    deployment.verify_containers = Mock()
    deployment.running = Mock(return_value=set())
    calls = []
    deployment.helper = lambda mounts, command, *args: calls.append(command)
    deployment.compose = lambda *args: calls.append(args)
    deployment.handoff_backup(tmp_path / "final.age", "age1synthetic")
    assert calls == ["retire-source", ("down",), "create-handoff"]
    assert not any(
        isinstance(call, tuple) and call[0] in {"start", "up"} for call in calls
    )


def test_manager_refuses_export_when_source_is_still_running(state, tmp_path):
    deployment = Deployment(state, tmp_path / "credentials", "learnrecur:synthetic")
    deployment.verify_containers = Mock()
    deployment.running = Mock(return_value={"worker"})
    deployment.helper = Mock()
    deployment.compose = Mock()
    with pytest.raises(ValueError, match="Every source writer"):
        deployment.handoff_backup(tmp_path / "final.age", "age1synthetic")
    assert deployment.helper.call_count == 1


def test_retirement_between_claim_check_and_transaction_prevents_reservation(
    state, monkeypatch
):
    jobs = Jobs(Store(state / "companion"))
    later = job(jobs)
    original = jobs.check_restore
    checks = 0

    def retire_after_check(provider):
        nonlocal checks
        checks += 1
        original(provider)
        if checks == 1:
            retire_source(state)

    monkeypatch.setattr(jobs, "check_restore", retire_after_check)
    with pytest.raises(JobConflict, match="paused"):
        jobs.claim(OpenAIProvider(SYNTHETIC_KEY, transport=Transport()))
    assert jobs.get(later["id"])["attempts"] == 0


def test_retirement_during_call_transaction_abandons_only_unsubmitted_claim(
    state, monkeypatch
):
    jobs = Jobs(Store(state / "companion"))
    job(jobs)
    claimed = jobs.claim(OpenAIProvider(SYNTHETIC_KEY, transport=Transport()))
    original = jobs._owned

    def retire_after_ownership(db, job_id, token):
        attempt = original(db, job_id, token)
        (state / "companion" / RETIRED).write_text("a" * 32)
        return attempt

    monkeypatch.setattr(jobs, "_owned", retire_after_ownership)
    assert jobs.calling(claimed[0], claimed[1]) is False
    assert jobs.get(claimed[0])["state"] == "queued"
    with jobs.store.connect() as db:
        assert db.execute(
            "select state,net_actual from generation_attempts"
        ).fetchone() == ("abandoned", 0)
