"""Verify upload recovery, conservative retention, and failure status."""

import json
from datetime import datetime, timedelta, timezone
from unittest.mock import Mock

import pytest

from learnrecur.deploy.scheduled_backup import (
    MAX_REMOTE,
    ScheduledBackup,
    digest,
    healthy,
    retained,
    settings,
)

NOW = datetime(2026, 10, 3, tzinfo=timezone.utc)


def name(day, number=0):
    return f"backend-{day:%Y%m%dT%H%M%SZ}-{number:032x}.age"


class Remote:
    def __init__(self):
        self.files = {}
        self.calls = []
        self.fail = None

    def list(self):
        return {
            key: {"size": len(data), "etag": key} for key, data in self.files.items()
        }

    def put(self, key, path, sha, image):
        self.calls.append(("put", key))
        self.files.setdefault(key, path.read_bytes())
        if self.fail == "put":
            raise OSError("Lost upload acknowledgement")

    def verify(self, key, size, sha):
        self.calls.append(("verify", key))
        import hashlib

        if (
            self.fail == "verify"
            or len(self.files[key]) != size
            or hashlib.sha256(self.files[key]).hexdigest() != sha
        ):
            raise ValueError("Corrupt upload")

    def delete(self, key, etag):
        self.calls.append(("delete", key))
        del self.files[key]


@pytest.fixture
def runner(tmp_path):
    config = {
        "directory": str(tmp_path / "automatic"),
        "state": str(tmp_path / "state"),
        "secrets": str(tmp_path / "secrets"),
        "image": "learnrecur:synthetic",
        "project": "learnrecur-test",
        "recipient": "age1synthetic",
        "account": "syntheticaccount",
        "container": "backups",
    }
    deployment = Mock()
    deployment.running.return_value = {"sync", "companion"}
    deployment.state = tmp_path / "state"
    deployment.lock.return_value.__enter__ = Mock()
    deployment.lock.return_value.__exit__ = Mock(return_value=False)
    deployment.backup.side_effect = lambda path, recipient: path.write_bytes(
        b"age-encryption.org/v1\nsynthetic-encrypted-data"
    )
    result = ScheduledBackup(config, Remote(), deployment)
    result.initialize()

    # Production umask is 077. Fixture creation must use the same privacy.
    def backup(path, recipient):
        path.write_bytes(b"age-encryption.org/v1\nsynthetic-encrypted-data")
        path.chmod(0o600)

    deployment.backup.side_effect = backup
    return result


def test_retention_keeps_daily_and_weekly_recovery_points():
    names = [name(NOW - timedelta(days=i)) for i in range(60)]
    keep = retained(names)
    assert set(names[:7]) <= keep
    assert len(keep) <= 11
    assert (
        len(
            {
                datetime.strptime(n[8:24], "%Y%m%dT%H%M%SZ").isocalendar()[:2]
                for n in keep
            }
        )
        == 4
    )
    duplicate = name(NOW, 1)
    assert name(NOW) not in retained([*names, duplicate])
    assert duplicate in retained([*names, duplicate])


def test_success_is_recorded_only_after_readback_and_retention(runner):
    for i in range(50):
        runner.remote.files[name(NOW - timedelta(days=i + 1))] = b"old encrypted copy"
    runner.run(NOW)
    status = runner.status()
    assert healthy(status, NOW) and not healthy(status, NOW + timedelta(hours=37))
    assert len(runner.remote.files) <= 11
    assert status["pending"] is None and status["sha256"] == digest(
        runner.folder / status["archive"]
    )
    operations = [c[0] for c in runner.remote.calls]
    assert operations.index("verify") < operations.index("delete")
    assert healthy({**status, "result": "failed"}, NOW) is False


@pytest.mark.parametrize("failure", ["put", "verify"])
def test_failed_upload_preserves_old_backups_and_retries_same_archive(runner, failure):
    old = name(NOW - timedelta(days=60))
    runner.remote.files[old] = b"old"
    runner.remote.fail = failure
    with pytest.raises((OSError, ValueError)):
        runner.run(NOW)
    status = runner.status()
    pending = status["pending"]
    assert status["result"] == "failed" and old in runner.remote.files
    assert not any(c[0] == "delete" for c in runner.remote.calls)
    assert not healthy(status, NOW)
    runner.remote.fail = None
    runner.run(NOW + timedelta(hours=1))
    assert runner.status()["archive"] == pending
    assert runner.deployment.backup.call_count == 1


def test_interruption_after_verified_upload_uses_same_object(runner, monkeypatch):
    original = runner.remote.verify

    def interrupted(*args):
        original(*args)
        raise KeyboardInterrupt()

    monkeypatch.setattr(runner.remote, "verify", interrupted)
    with pytest.raises(KeyboardInterrupt):
        runner.run(NOW)
    assert runner.status()["result"] == "running"
    pending = runner.status()["pending"]
    monkeypatch.setattr(runner.remote, "verify", original)
    runner.run(NOW + timedelta(hours=1))
    assert runner.status()["archive"] == pending
    assert len(runner.remote.files) == 1 and runner.deployment.backup.call_count == 1


def test_remote_limit_does_not_delete_to_make_space(runner):
    runner.remote.list = lambda: {name(NOW): {"size": MAX_REMOTE, "etag": "one"}}
    with pytest.raises(ValueError, match="limit"):
        runner.run(NOW)
    assert runner.remote.calls == []
    assert runner.status()["pending"] is not None


def test_plaintext_or_symlink_never_uploaded(runner):
    status = runner.status()
    status["pending"] = name(NOW)
    import hashlib

    status["pending_config"] = hashlib.sha256(
        json.dumps(runner.config, sort_keys=True).encode()
    ).hexdigest()
    runner.status_path.write_text(json.dumps(status))
    path = runner.folder / status["pending"]
    path.write_bytes(b"plaintext")
    path.chmod(0o600)
    with pytest.raises(ValueError, match="encrypted"):
        runner.run(NOW)
    path.unlink()
    target = runner.folder / "unrelated"
    target.write_text("private")
    path.symlink_to(target)
    with pytest.raises(ValueError, match="symbolic"):
        runner.run(NOW)
    assert runner.remote.calls == []


def test_local_retention_and_private_configuration(runner, tmp_path):
    for i in range(5):
        runner.run(NOW + timedelta(days=i))
    assert len(list(runner.folder.glob("backend-*.age"))) == 3
    path = tmp_path / "config.json"
    path.write_text(json.dumps(runner.config))
    path.chmod(0o600)
    assert settings(path) == runner.config
    path.chmod(0o644)
    with pytest.raises(ValueError, match="private"):
        settings(path)
    path.chmod(0o600)
    path.write_text(json.dumps({**runner.config, "directory": runner.config["state"]}))
    with pytest.raises(ValueError, match="separate"):
        settings(path)


def test_failed_backup_does_not_reach_remote(runner):
    runner.deployment.backup.side_effect = OSError("Disk full")
    with pytest.raises(OSError):
        runner.run(NOW)
    assert runner.remote.calls == []
    assert runner.status()["result"] == "failed"


def test_pending_backup_refuses_changed_image_or_destination(runner):
    runner.remote.fail = "put"
    with pytest.raises(OSError):
        runner.run(NOW)
    original = runner.status()["pending"]
    runner.config["image"] = "learnrecur:different"
    with pytest.raises(ValueError, match="configuration"):
        runner.run(NOW + timedelta(hours=1))
    assert runner.status()["pending"] == original
    assert runner.deployment.backup.call_count == 1


def test_old_pending_snapshot_does_not_look_fresh_after_retry(runner):
    runner.remote.fail = "put"
    with pytest.raises(OSError):
        runner.run(NOW)
    runner.remote.fail = None
    later = NOW + timedelta(days=3)
    runner.run(later)
    assert not healthy(runner.status(), later)
    runner.run(later)
    assert healthy(runner.status(), later)


def test_crash_while_stopped_recovers_only_previously_running_services(
    runner, monkeypatch
):
    monkeypatch.setattr("learnrecur.deploy.scheduled_backup.validate_root", Mock())
    original = runner.deployment.backup.side_effect
    runner.deployment.backup.side_effect = KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):
        runner.run(NOW)
    assert runner.status()["resume_services"] == ["companion", "sync"]
    runner.deployment.backup.side_effect = original
    runner.recover()
    runner.deployment.stop_helpers.assert_called_once()
    runner.deployment.compose.assert_called_once_with("start", "companion", "sync")
    assert runner.status()["resume_services"] == []
    runner.run(NOW + timedelta(hours=1))
    assert healthy(runner.status(), NOW + timedelta(hours=1))


def test_stopped_service_recovery_refuses_another_configuration(runner):
    runner.deployment.backup.side_effect = KeyboardInterrupt()
    with pytest.raises(KeyboardInterrupt):
        runner.run(NOW)
    runner.config["state"] = "/some/other/state"
    with pytest.raises(ValueError, match="configuration"):
        runner.recover()
    runner.deployment.compose.assert_not_called()


def test_saved_archive_is_not_successful_until_stopped_services_recover(
    runner, monkeypatch
):
    monkeypatch.setattr("learnrecur.deploy.scheduled_backup.validate_root", Mock())
    backup = runner.deployment.backup.side_effect

    def fail_restart(path, recipient):
        backup(path, recipient)
        raise RuntimeError("compose start failed")

    runner.deployment.backup.side_effect = fail_restart
    with pytest.raises(RuntimeError):
        runner.run(NOW)
    pending = runner.status()["pending"]
    assert (runner.folder / pending).exists()
    assert runner.remote.calls == []
    runner.deployment.compose.side_effect = OSError("restart still failing")
    with pytest.raises(OSError):
        runner.run(NOW + timedelta(hours=1))
    assert runner.status()["result"] == "failed"
    assert runner.remote.calls == []
    runner.deployment.compose.side_effect = None
    runner.run(NOW + timedelta(hours=2))
    assert runner.status()["archive"] == pending
    assert runner.deployment.backup.call_count == 1
    assert runner.status()["resume_services"] == []
