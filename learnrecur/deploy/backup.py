# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Encrypted backups of stopped, marked LearnRecur backend stores."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import tarfile
import tempfile
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

MARKER = ".learnrecur-backend"
VERSION = "learnrecur-backend-v1\n"
STORES = {
    "sync": (".learnrecur-sync", "learnrecur-sync-v1\n"),
    "companion": (".learnrecur-companion", "learnrecur-companion-v1\n"),
}
MAX_BYTES = 10 * 1024**3
MAX_FILES = 100000


def safe_path(path: Path) -> Path:
    path = Path(os.path.abspath(path.expanduser()))
    if any(p.casefold() in {"anki", "anki2", ".anki"} for p in path.parts):
        raise ValueError("Use separate LearnRecur storage.")
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError("Storage must not follow symbolic links.")
    return path


def validate_root(root: Path) -> Path:
    root = safe_path(root)
    marker = root / MARKER
    if marker.is_symlink() or not marker.is_file() or marker.read_text() != VERSION:
        raise ValueError("Use a marked LearnRecur backend directory.")
    for name, (marker_name, version) in STORES.items():
        folder = root / name
        if folder.is_symlink() or not folder.is_dir():
            raise ValueError("Both backend stores are required.")
        marker = folder / marker_name
        if marker.is_symlink() or not marker.is_file() or marker.read_text() != version:
            raise ValueError("Unrecognized backend store.")
        for path in folder.rglob("*"):
            if path.is_symlink() or not (path.is_dir() or path.is_file()):
                raise ValueError("Backend storage must contain only regular files.")
    return root


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def sqlite_file(path):
    with path.open("rb") as source:
        return source.read(16) == b"SQLite format 3\x00"


def check_database(path):
    if sqlite_file(path):
        if path.name == "collection.anki2":
            # Anki's indexed names use its pinned Rust unicase comparison.
            binary = shutil.which("anki-sync-server") or str(
                Path(__file__).resolve().parents[2] / "target/debug/anki-sync-server"
            )
            subprocess.run([binary, "--check-backup-database", str(path)], check=True)
            return
        with closing(sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)) as db:
            if db.execute("pragma integrity_check").fetchall() != [("ok",)]:
                raise ValueError("A backed-up database failed its integrity check.")


def create_archive(root: Path, output: Path, revision: str):
    # The caller must stop every writer before entering this function.
    root = validate_root(root)
    if not revision or len(revision) > 100:
        raise ValueError("A matching build revision is required.")
    with tempfile.TemporaryDirectory(dir=output.parent) as temporary:
        stage = Path(temporary)
        total = 0
        count = 0
        # Copy all sidecars with their databases before opening the private copy.
        for name in STORES:
            for source in sorted((root / name).rglob("*")):
                if not source.is_file():
                    continue
                total += source.stat().st_size
                count += 1
                if total > MAX_BYTES or count > MAX_FILES:
                    raise ValueError("Backend backup exceeds the size limit.")
                destination = stage / source.relative_to(root)
                destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                shutil.copyfile(source, destination)
                destination.chmod(0o600)
        if not (stage / "companion/skills.sqlite3").is_file():
            raise ValueError("Start the companion before creating its first backup.")
        # Reading the copied stores recovers any SQLite journal left by a stop.
        for path in list(stage.rglob("*")):
            if path.is_file() and sqlite_file(path):
                with closing(sqlite3.connect(path)) as db:
                    db.execute("pragma wal_checkpoint(truncate)")
                check_database(path)
        files = {
            str(p.relative_to(stage)): {"size": p.stat().st_size, "sha256": digest(p)}
            for p in sorted(stage.rglob("*"))
            if p.is_file()
        }
        manifest = {
            "format": 1,
            "revision": revision,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "files": files,
        }
        (stage / "manifest.json").write_text(json.dumps(manifest, sort_keys=True))
        with tarfile.open(output, "w:gz") as archive:
            for path in sorted(stage.rglob("*")):
                if path.is_file():
                    archive.add(
                        path, arcname=str(path.relative_to(stage)), recursive=False
                    )
        output.chmod(0o600)


def restore_archive(archive_path: Path, destination: Path, revision: str):
    destination = safe_path(destination)
    if destination.exists():
        raise ValueError(
            "Restore into a new directory; existing data is never replaced."
        )
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        stage = Path(temporary) / "state"
        stage.mkdir(mode=0o700)
        names = set()
        total = 0
        with tarfile.open(archive_path, "r:gz") as archive:
            for member in archive:
                parts = PurePosixPath(member.name).parts
                if (
                    not member.isfile()
                    or member.issparse()
                    or not parts
                    or member.name != str(PurePosixPath(member.name))
                    or any(p in (".", "..") for p in parts)
                    or "\\" in member.name
                    or member.name in names
                    or not (
                        member.name == "manifest.json"
                        or (parts[0] in STORES and len(parts) > 1)
                    )
                ):
                    raise ValueError("Unsafe or duplicate backup entry.")
                total += member.size
                names.add(member.name)
                if (
                    total > MAX_BYTES
                    or len(names) > MAX_FILES
                    or (member.name == "manifest.json" and member.size > 16 * 1024**2)
                ):
                    raise ValueError("Backup exceeds the restore limit.")
                path = stage / member.name
                path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                with archive.extractfile(member) as source, path.open("xb") as target:
                    shutil.copyfileobj(source, target)
                path.chmod(0o600)
        manifest = json.loads((stage / "manifest.json").read_text())
        if (
            not isinstance(manifest, dict)
            or manifest.get("format") != 1
            or manifest.get("revision") != revision
        ):
            raise ValueError("Restore with the matching LearnRecur image revision.")
        files = manifest["files"]
        if not isinstance(files, dict):
            raise ValueError("Invalid backup manifest.")
        if set(files) != names - {"manifest.json"}:
            raise ValueError("The backup manifest does not match its files.")
        for name, expected in files.items():
            if not isinstance(expected, dict):
                raise ValueError("Invalid backup file record.")
            path = stage / name
            if (
                path.stat().st_size != expected["size"]
                or digest(path) != expected["sha256"]
            ):
                raise ValueError("A backup file failed verification.")
        (stage / MARKER).write_text(VERSION)
        validate_root(stage)
        for name in files:
            check_database(stage / name)
        (stage / "manifest.json").unlink()
        # Never resume generation automatically from an older job history.
        (stage / "companion/.restore-pending").write_text(
            "Inspect restored jobs before resuming.\n"
        )
        # Reserve the destination exclusively. An interrupted publication has
        # no root marker and cannot be launched as a complete deployment.
        destination.mkdir(mode=0o700)
        for name in STORES:
            os.rename(stage / name, destination / name)
        (destination / MARKER).write_text(VERSION)
    return manifest


def create(root, output, recipient, revision):
    root = validate_root(root)
    output = safe_path(output)
    if output.exists() or output.is_relative_to(root):
        raise ValueError("Choose a new backup file outside backend storage.")
    if not recipient.startswith("age1") or len(recipient) > 200:
        raise ValueError("Use an age public recipient.")
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.TemporaryDirectory(dir=output.parent) as temporary:
        plain = Path(temporary) / "backend.tar.gz"
        encrypted = Path(temporary) / "backend.age"
        create_archive(root, plain, revision)
        subprocess.run(
            ["age", "-r", recipient, "-o", str(encrypted), str(plain)], check=True
        )
        encrypted.chmod(0o600)
        # link publishes atomically and refuses to overwrite an existing backup.
        os.link(encrypted, output)


def restore(archive, destination, identity, revision):
    destination = safe_path(destination)
    if destination.exists():
        raise ValueError("Restore into a new directory.")
    identity = safe_path(identity)
    if identity.stat().st_mode & 0o077:
        raise ValueError("The backup identity file must be private.")
    with tempfile.TemporaryDirectory(dir=destination.parent) as temporary:
        plain = Path(temporary) / "backend.tar.gz"
        with subprocess.Popen(
            ["age", "-d", "-i", str(identity), str(archive)], stdout=subprocess.PIPE
        ) as process:
            try:
                size = 0
                with plain.open("xb") as output:
                    while chunk := process.stdout.read(1024 * 1024):
                        size += len(chunk)
                        if size > MAX_BYTES:
                            raise ValueError("Decrypted backup exceeds the size limit.")
                        output.write(chunk)
                if process.wait() != 0:
                    raise ValueError("Backup decryption failed.")
            except BaseException:
                process.kill()
                process.wait()
                raise
        return restore_archive(plain, destination, revision)


def allow_fixture_worker(root):
    root = validate_root(root)
    # Paid history can have changed after the backup. It needs external reconciliation.
    with closing(sqlite3.connect(root / "companion/skills.sqlite3")) as db:
        requests = db.execute("select request from generation_jobs").fetchall()
    if any(
        json.loads(row[0]).get("provider", "fixture") != "fixture" for row in requests
    ):
        raise ValueError(
            "Paid job history requires reconciliation; keep the worker stopped."
        )
    (root / "companion/.restore-pending").unlink(missing_ok=True)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("create", "restore", "allow-fixture-worker"):
        child = commands.add_parser(command)
        child.add_argument("--root", type=Path, required=True)
        if command != "allow-fixture-worker":
            child.add_argument("--archive", type=Path, required=True)
            child.add_argument(
                "--revision",
                default=Path("/build-revision").read_text().strip()
                if Path("/build-revision").exists()
                else None,
            )
        if command == "create":
            child.add_argument("--recipient", required=True)
        if command == "restore":
            child.add_argument("--identity", type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.command == "create":
            create(args.root, args.archive, args.recipient, args.revision)
        elif args.command == "restore":
            restore(args.archive, args.root, args.identity, args.revision)
        else:
            allow_fixture_worker(args.root)
    except (
        ValueError,
        OSError,
        sqlite3.Error,
        tarfile.TarError,
        subprocess.CalledProcessError,
        KeyError,
        TypeError,
    ) as error:
        parser.exit(1, f"Backup operation failed: {type(error).__name__}.\n")


if __name__ == "__main__":
    main()
