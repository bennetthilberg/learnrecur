"""Restore both backend stores without losing identities or job accounting."""

import io
import json
import sqlite3
import tarfile
from pathlib import Path
from unittest.mock import Mock

import pytest

from learnrecur.companion.jobs import FixtureProvider, Jobs
from learnrecur.companion.server import Store
from learnrecur.deploy.backup import (
    MARKER,
    VERSION,
    allow_fixture_worker,
    create_archive,
    inspect_generation,
    publish_ready,
    restore_archive,
    validate_root,
)
from learnrecur.deploy.manage import Deployment
from learnrecur.deploy.run_sync_server import server_environment

ROOT = Path(__file__).resolve().parents[3]
REVISION = "synthetic-matching-build"


@pytest.fixture
def state(tmp_path):
    root = tmp_path / "source"
    root.mkdir()
    (root / MARKER).write_text(VERSION)
    server_environment(root / "sync", 45331, "synthetic:synthetic-password")
    store = Store(root / "companion")
    store.import_batch(
        json.loads((ROOT / "learnrecur/fixtures/spanish-import.json").read_text())
    )
    user = root / "sync/user"
    user.mkdir()
    with sqlite3.connect(user / "collection.anki2") as db:
        db.execute("create table reviews (id integer primary key, rating integer)")
        db.execute("insert into reviews values (123,1)")
    (user / "media").mkdir()
    (user / "media/synthetic.svg").write_text("<svg>Synthetic media</svg>")
    # Unknown files outside the stores, including credentials, are not backed up.
    (root / "excluded-key").write_text("not a real credential")
    return root


def tables(path):
    with sqlite3.connect(path) as db:
        return {
            name: db.execute('select * from "' + name + '"').fetchall()
            for (name,) in db.execute(
                "select name from sqlite_master where type='table'"
            ).fetchall()
        }


def test_both_stores_identities_usage_budgets_and_pending_jobs_survive(state, tmp_path):
    store = Store(state / "companion")
    configured = store.configure_limits(
        max_jobs=2000, max_exercises=240, max_snapshot_bytes=16 * 1024 * 1024
    )
    jobs = Jobs(store)

    def enqueue(request_id, provider="fixture"):
        return jobs.enqueue(
            {
                "request_id": request_id,
                "skill_id": "spanish-ar-preterite-yo",
                "revision": 1,
                "count": 3,
                "provider": provider,
            }
        )

    completed = enqueue("completed")
    jobs.run_once(FixtureProvider())
    from learnrecur.companion.reports import Reports
    from learnrecur.companion.tests.test_reports import value

    report = value(store)
    Reports(store).receive(report, None)
    Reports(store).receive({**report, "version": 2, "active": False}, None)
    enqueue("queued")
    uncertain = enqueue("uncertain", "openai")
    with store.connect() as db:
        db.execute(
            "update generation_jobs set state='needs_attention' where id=?",
            (uncertain["id"],),
        )
        db.execute(
            "insert into generation_attempts (job_id,attempt,month,state,gross_reserved,credit_reserved,net_reserved) values (?,1,'2026-10','calling',900,200,700)",
            (uncertain["id"],),
        )
        db.execute(
            "update generation_budget set credit_total=20000,credit_expires=1791000000"
        )
    before = tables(store.path)
    archive = tmp_path / "backup.tar.gz"
    create_archive(state, archive, REVISION)
    restored = tmp_path / "restored"
    restore_archive(archive, restored, REVISION)
    assert tables(restored / "companion/skills.sqlite3") == before
    assert Store(restored / "companion").snapshot() == store.snapshot()
    with Store(restored / "companion").connect() as db:
        assert Store.limits(db) == configured
    assert jobs.get(completed["id"])["state"] == "completed"
    assert (restored / "sync/user/media/synthetic.svg").read_bytes() == (
        state / "sync/user/media/synthetic.svg"
    ).read_bytes()
    assert tables(restored / "sync/user/collection.anki2") == tables(
        state / "sync/user/collection.anki2"
    )
    assert (restored / "companion/.restore-pending").exists()
    assert not (restored / "excluded-key").exists()
    with pytest.raises(ValueError, match="Paid job history"):
        allow_fixture_worker(restored)
    assert (restored / "companion/.restore-pending").exists()


def test_committed_wal_rows_are_captured(state, tmp_path):
    path = state / "sync/user/collection.anki2"
    db = sqlite3.connect(path)
    db.execute("pragma journal_mode=wal")
    db.execute("pragma wal_autocheckpoint=0")
    db.execute("insert into reviews values (124,4)")
    db.commit()
    # Keep the WAL present, with no writes during the backup.
    try:
        archive = tmp_path / "backup.tar.gz"
        create_archive(state, archive, REVISION)
        restored = tmp_path / "restored"
        restore_archive(archive, restored, REVISION)
        assert tables(restored / "sync/user/collection.anki2")["reviews"] == [
            (123, 1),
            (124, 4),
        ]
    finally:
        db.close()


@pytest.mark.parametrize("location", ["root", "store", "file"])
def test_symlinks_are_rejected_without_following_them(state, tmp_path, location):
    external = tmp_path / "external"
    external.write_text("untouched")
    if location == "root":
        link = tmp_path / "linked"
        link.symlink_to(state, target_is_directory=True)
        state = link
    elif location == "store":
        (state / "sync/.learnrecur-sync").unlink()
        (state / "sync/.learnrecur-sync").symlink_to(external)
    else:
        (state / "companion/link").symlink_to(external)
    with pytest.raises(ValueError):
        validate_root(state)
    assert external.read_text() == "untouched"


@pytest.mark.parametrize("name", ["Anki", "Anki2", ".anki"])
def test_personal_anki_named_paths_are_rejected(tmp_path, name):
    with pytest.raises(ValueError):
        validate_root(tmp_path / name)
    assert not (tmp_path / name).exists()


def rewrite(archive, change):
    with tarfile.open(archive) as source:
        entries = [(entry, source.extractfile(entry).read()) for entry in source]
    with tarfile.open(archive, "w:gz") as target:
        for entry, data in change(entries):
            entry.size = len(data)
            target.addfile(entry, io.BytesIO(data))


@pytest.mark.parametrize(
    "damage",
    [
        "content",
        "manifest",
        "traversal",
        "absolute",
        "symlink",
        "duplicate",
        "missing_store",
    ],
)
def test_bad_archives_leave_destination_absent(state, tmp_path, damage):
    archive = tmp_path / "backup.tar.gz"
    create_archive(state, archive, REVISION)

    def change(entries):
        if damage == "content":
            entries[-1] = (entries[-1][0], b"changed")
        elif damage == "manifest":
            for i, (entry, data) in enumerate(entries):
                if entry.name == "manifest.json":
                    manifest = json.loads(data)
                    manifest["files"].pop(next(iter(manifest["files"])))
                    entries[i] = (entry, json.dumps(manifest).encode())
        elif damage == "missing_store":
            entries = [
                (entry, data)
                for entry, data in entries
                if not entry.name.startswith("sync/")
            ]
        elif damage == "duplicate":
            entries.append(entries[-1])
        else:
            entry = tarfile.TarInfo(
                {
                    "traversal": "sync/../../escape",
                    "absolute": "/escape",
                    "symlink": "sync/link",
                }[damage]
            )
            if damage == "symlink":
                entry.type = tarfile.SYMTYPE
                entry.linkname = "/escape"
            entries.append((entry, b"x"))
        return entries

    rewrite(archive, change)
    destination = tmp_path / "restored"
    with pytest.raises(ValueError):
        restore_archive(archive, destination, REVISION)
    assert not destination.exists()
    assert not (tmp_path / "escape").exists()


def test_build_mismatch_and_existing_target_leave_data_intact(state, tmp_path):
    archive = tmp_path / "backup.tar.gz"
    create_archive(state, archive, REVISION)
    target = tmp_path / "restored"
    with pytest.raises(ValueError, match="matching"):
        restore_archive(archive, target, "another-build")
    assert not target.exists()
    target.mkdir()
    (target / "keep").write_text("keep")
    with pytest.raises(ValueError, match="existing data"):
        restore_archive(archive, target, REVISION)
    assert (target / "keep").read_text() == "keep"


def test_fixture_worker_needs_explicit_resume(state, tmp_path):
    archive = tmp_path / "backup.tar.gz"
    create_archive(state, archive, REVISION)
    restored = tmp_path / "restored"
    restore_archive(archive, restored, REVISION)
    allow_fixture_worker(restored)
    assert not (restored / "companion/.restore-pending").exists()
    assert (restored / "companion/.paid-restore-pending").exists()
    report = inspect_generation(restored)
    assert not report["restore_paused"] and report["paid_restore_paused"]
    from learnrecur.companion.jobs import JobConflict
    from learnrecur.companion.openai_provider import OpenAIProvider

    provider = OpenAIProvider("sk-synthetic-secret-for-tests-only", transport=Mock())
    with pytest.raises(JobConflict, match="paused"):
        Jobs(Store(restored / "companion")).run_once(provider)
    provider._transport.assert_not_called()


def test_restore_inspection_keeps_unknown_spending_held(state, tmp_path):
    jobs = Jobs(Store(state / "companion"))
    job = jobs.enqueue(
        {
            "request_id": "uncertain",
            "skill_id": "spanish-ar-preterite-yo",
            "revision": 1,
            "count": 3,
            "provider": "openai",
        }
    )
    from learnrecur.companion.openai_provider import OpenAIProvider

    provider = OpenAIProvider(
        "sk-synthetic-secret-for-tests-only", transport=Mock(side_effect=TimeoutError)
    )
    jobs.run_once(provider)
    before = tables(jobs.store.path)
    report = inspect_generation(state)
    assert report["months"][0]["held_microusd"] > 0
    assert report["attempts"][0]["job_id"] == job["id"]
    assert report["attempts"][0]["actual_microusd"] is None
    assert tables(jobs.store.path) == before


def test_ready_paid_result_can_publish_on_restored_host_without_a_key(state, tmp_path):
    from learnrecur.companion.openai_provider import OpenAIProvider
    from learnrecur.companion.tests.test_openai_provider import SYNTHETIC_KEY, Transport

    jobs = Jobs(Store(state / "companion"))
    job = jobs.enqueue(
        {
            "request_id": "ready",
            "skill_id": "spanish-ar-preterite-yo",
            "revision": 1,
            "count": 3,
            "provider": "openai",
        }
    )
    transport = Transport()
    jobs.publish = Mock()
    jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=transport))
    assert jobs.get(job["id"])["state"] == "result_ready"
    archive = tmp_path / "ready.tar.gz"
    create_archive(state, archive, REVISION)
    restored = tmp_path / "restored"
    restore_archive(archive, restored, REVISION)
    recovered = Jobs(Store(restored / "companion"))
    before = tables(recovered.store.path)["generation_attempts"]
    publish_ready(restored)
    publish_ready(restored)
    assert recovered.get(job["id"])["state"] == "completed"
    assert (
        len(recovered.store.snapshot()["bank_updates"]["spanish-ar-preterite-yo"]) == 1
    )
    assert tables(recovered.store.path)["generation_attempts"] == before
    assert len(transport.calls) == 1
    assert (restored / "companion/.restore-pending").exists()
    assert (restored / "companion/.paid-restore-pending").exists()


@pytest.mark.parametrize("failure", ["none", "copy", "still_running", "stop"])
def test_backup_stops_all_writers_and_restores_only_previous_services(
    state, tmp_path, failure
):
    deployment = Deployment(
        state, tmp_path / "credentials", "learnrecur:synthetic", uid=10001
    )
    deployment.verify_containers = Mock()
    deployment.running = Mock(
        side_effect=[
            {"sync", "companion"},
            {"worker"} if failure == "still_running" else set(),
        ]
    )

    def compose(*arguments):
        if failure == "stop" and arguments[0] == "stop":
            raise ValueError("stop failed")

    deployment.compose = Mock(side_effect=compose)
    deployment.helper = Mock(
        side_effect=ValueError("copy failed") if failure == "copy" else None
    )
    if failure == "none":
        deployment.backup(tmp_path / "backup.age", "age1synthetic")
        deployment.helper.assert_called_once()
    else:
        with pytest.raises(ValueError):
            deployment.backup(tmp_path / "backup.age", "age1synthetic")
        if failure != "copy":
            deployment.helper.assert_not_called()
    assert deployment.compose.call_args_list[0].args == ("stop", "companion", "sync")
    assert deployment.compose.call_args_list[-1].args == ("start", "companion", "sync")


def test_existing_container_from_other_state_is_not_stopped(
    state, tmp_path, monkeypatch
):
    deployment = Deployment(
        state, tmp_path / "credentials", "learnrecur:synthetic", uid=10001
    )
    deployment.compose = Mock(return_value="container-id\n")
    monkeypatch.setattr(
        "learnrecur.deploy.manage.subprocess.run",
        Mock(
            return_value=Mock(
                stdout=json.dumps(
                    [
                        {
                            "Config": {
                                "Labels": {"com.docker.compose.service": "sync"}
                            },
                            "Mounts": [
                                {"Source": "/other/state", "Destination": "/state/sync"}
                            ],
                        }
                    ]
                )
            )
        ),
    )
    with pytest.raises(ValueError, match="another deployment"):
        deployment.backup(tmp_path / "backup.age", "age1synthetic")
    assert deployment.compose.call_count == 1


@pytest.mark.parametrize("damage", ["missing", "corrupt"])
def test_native_integrity_check_is_read_only(tmp_path, damage):
    import subprocess

    path = tmp_path / "collection.anki2"
    binary = ROOT / "target/debug/anki-sync-server"
    if damage == "corrupt":
        path.write_bytes(b"not a SQLite database")
        before = path.read_bytes()
    result = subprocess.run(
        [str(binary), "--check-backup-database", str(path)],
        capture_output=True,
        check=False,
    )
    assert result.returncode == 1
    if damage == "missing":
        assert not path.exists()
    else:
        assert path.read_bytes() == before


def test_native_integrity_check_handles_anki_collation_without_mutation(tmp_path):
    import subprocess

    from anki.collection import Collection

    path = tmp_path / "collection.anki2"
    col = Collection(str(path))
    col.decks.id("Synthetic café")
    col.close()
    before = path.read_bytes()
    result = subprocess.run(
        [
            str(ROOT / "target/debug/anki-sync-server"),
            "--check-backup-database",
            str(path),
        ],
        capture_output=True,
        check=False,
    )
    assert result.returncode == 0
    assert path.read_bytes() == before
