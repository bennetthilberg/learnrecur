# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Make, verify, and retain encrypted off-host backups."""

from __future__ import annotations

import argparse
import fcntl
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from learnrecur.deploy.backup import digest, safe_path, validate_root
from learnrecur.deploy.manage import SERVICES, Deployment

MARKER = ".learnrecur-automatic-backups"
VERSION = "learnrecur-automatic-backups-v1\n"
PREFIX = "learnrecur/v1/"
NAME = re.compile(r"backend-(\d{8}T\d{6}Z)-[a-f0-9]{32}\.age")
MAX_ARCHIVE = 32 * 1024**2
MAX_REMOTE = 512 * 1024**2


class OversizedArchive(ValueError):
    """An encrypted snapshot needs inspection before it can be replaced."""


def instant():
    return datetime.now(timezone.utc)


def timestamp(name):
    match = NAME.fullmatch(name)
    if not match:
        raise ValueError("Unrecognized automatic backup name.")
    return datetime.strptime(match[1], "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)


def retained(names):
    """Keep the newest snapshot from seven distinct days and four ISO weeks."""
    keep, days, weeks = set(), set(), set()
    for name in sorted(names, key=lambda name: (timestamp(name), name), reverse=True):
        created = timestamp(name)
        day, week = created.date(), created.isocalendar()[:2]
        if day not in days and len(days) < 7:
            keep.add(name)
            days.add(day)
        if week not in weeks and len(weeks) < 4:
            keep.add(name)
            weeks.add(week)
    return keep


def save(path, value):
    temporary = path.with_suffix(".new")
    fd = os.open(
        temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600
    )
    with os.fdopen(fd, "w") as stream:
        json.dump(value, stream, sort_keys=True)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def private_file(path):
    path = safe_path(path)
    info = path.stat()
    if not path.is_file() or info.st_mode & 0o077 or info.st_uid != os.getuid():
        raise ValueError("Use a private file owned by the service user.")
    if info.st_size > 65536:
        raise ValueError("Configuration or status file is too large.")
    return path


def settings(path):
    value = json.loads(private_file(path).read_text())
    required = {
        "state",
        "secrets",
        "image",
        "project",
        "directory",
        "recipient",
        "account",
        "container",
    }
    if (
        not isinstance(value, dict)
        or set(value) != required
        or not all(isinstance(v, str) for v in value.values())
    ):
        raise ValueError("Invalid backup configuration.")
    if not re.fullmatch(r"[a-z0-9]{3,24}", value["account"]):
        raise ValueError("Use an Azure storage account name.")
    if (
        not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", value["container"])
        or not 3 <= len(value["container"]) <= 63
    ):
        raise ValueError("Use an Azure container name.")
    if not value["recipient"].startswith("age1") or len(value["recipient"]) > 200:
        raise ValueError("Use an age public recipient.")
    for field in ("directory", "state", "secrets"):
        if not Path(value[field]).is_absolute():
            raise ValueError("Use absolute deployment paths.")
        safe_path(Path(value[field]))
    folder = Path(value["directory"])
    for field in ("state", "secrets"):
        other = Path(value[field])
        if folder.is_relative_to(other) or other.is_relative_to(folder):
            raise ValueError("Keep automatic backups separate from state and secrets.")
    return value


class AzureBlobs:
    """Use only this VM's identity, scoped to a dedicated private container."""

    def __init__(self, account, container):
        from azure.identity import ManagedIdentityCredential
        from azure.storage.blob import ContainerClient

        self.client = ContainerClient(
            f"https://{account}.blob.core.windows.net",
            container,
            credential=ManagedIdentityCredential(),
            retry_total=2,
            connection_timeout=10,
            read_timeout=60,
        )

    def list(self):
        result = {}
        for blob in self.client.list_blobs(name_starts_with=PREFIX):
            name = blob.name.removeprefix(PREFIX)
            timestamp(name)  # Never delete unrelated or unrecognized objects.
            result[name] = {"size": blob.size, "etag": blob.etag}
            if len(result) > 1000:
                raise ValueError("Too many backup objects; inspect retention.")
        return result

    def put(self, name, path, sha, image):
        from azure.core.exceptions import ResourceExistsError

        blob = self.client.get_blob_client(PREFIX + name)
        try:
            with path.open("rb") as stream:
                blob.upload_blob(
                    stream,
                    overwrite=False,
                    max_concurrency=1,
                    metadata={"sha256": sha, "image": image},
                    timeout=60,
                )
        except ResourceExistsError:
            # A lost acknowledgement may leave a complete blob. Verify it below.
            pass

    def verify(self, name, size, sha):
        blob = self.client.get_blob_client(PREFIX + name)
        props = blob.get_blob_properties()
        if props.size != size or props.metadata.get("sha256") != sha:
            raise ValueError("Uploaded backup properties do not match.")
        actual, total = hashlib.sha256(), 0
        for chunk in blob.download_blob(max_concurrency=1, timeout=60).chunks():
            total += len(chunk)
            if total > MAX_ARCHIVE:
                raise ValueError("Remote backup exceeds the archive limit.")
            actual.update(chunk)
        if total != size or actual.hexdigest() != sha:
            raise ValueError("Uploaded backup failed its read-back check.")

    def delete(self, name, etag):
        from azure.core import MatchConditions

        self.client.delete_blob(
            PREFIX + name, etag=etag, match_condition=MatchConditions.IfNotModified
        )


class ScheduledBackup:
    def __init__(self, config, remote, deployment=None):
        self.config, self.remote = config, remote
        self.folder = safe_path(Path(config["directory"]))
        self.deployment = deployment or Deployment(
            Path(config["state"]),
            Path(config["secrets"]),
            config["image"],
            config["project"],
        )
        self.status_path = self.folder / "status.json"

    def initialize(self):
        self.folder.mkdir(mode=0o700)  # Refuse to adopt an existing folder.
        (self.folder / MARKER).write_text(VERSION)
        (self.folder / MARKER).chmod(0o600)
        save(
            self.status_path,
            {"last_success": None, "pending": None, "result": "never_run"},
        )

    def status(self):
        if safe_path(self.folder / MARKER).read_text() != VERSION:
            raise ValueError("Use a marked automatic backup directory.")
        if (
            self.folder.stat().st_mode & 0o077
            or self.folder.stat().st_uid != os.getuid()
        ):
            raise ValueError(
                "Use a private backup directory owned by the service user."
            )
        return json.loads(private_file(self.status_path).read_text())

    def resume(self, status):
        running = status.get("resume_services", [])
        if not running:
            return
        if not isinstance(running, list) or not set(running) <= SERVICES:
            raise ValueError("Unrecognized services in backup recovery.")
        fingerprint = hashlib.sha256(
            json.dumps(self.config, sort_keys=True).encode()
        ).hexdigest()
        if status.get("pending_config") != fingerprint:
            raise ValueError(
                "Recover the stopped deployment before changing its configuration."
            )
        validate_root(self.deployment.state)
        self.deployment.verify_containers()
        self.deployment.stop_helpers()
        if "worker" in running and any(
            (self.deployment.state / "companion" / marker).exists()
            for marker in (".restore-pending", ".paid-restore-pending")
        ):
            raise ValueError("Restored generation must stay paused.")
        self.deployment.compose("start", *running)
        status["resume_services"] = []
        save(self.status_path, status)

    def recover(self):
        fd = os.open(
            safe_path(self.folder / ".lock"),
            os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW,
            0o600,
        )
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.deployment.lock():
                self.resume(self.status())
        finally:
            os.close(fd)

    def replace_oversized(self, name):
        """Preserve an unuploaded oversized archive and allow a fresh snapshot."""
        timestamp(name)
        fd = os.open(
            safe_path(self.folder / ".lock"),
            os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW,
            0o600,
        )
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            status = self.status()
            if status["pending"] != name:
                raise ValueError("Specify the current pending archive name.")
            fingerprint = hashlib.sha256(
                json.dumps(self.config, sort_keys=True).encode()
            ).hexdigest()
            if status.get("pending_config") != fingerprint:
                raise ValueError("Use the pending backup's original configuration.")
            with self.deployment.lock():
                self.resume(status)
                path = safe_path(self.folder / name)
                info = path.stat()
                if (
                    not path.is_file()
                    or info.st_mode & 0o077
                    or info.st_uid != os.getuid()
                    or info.st_size <= MAX_ARCHIVE
                ):
                    raise ValueError(
                        "Only an oversized private archive can be replaced."
                    )
                with path.open("rb") as stream:
                    if stream.read(22) != b"age-encryption.org/v1\n":
                        raise ValueError("Only an encrypted archive can be replaced.")
                if name in self.remote.list():
                    raise ValueError("The pending archive exists remotely; retry it.")
                preserved = safe_path(self.folder / (".oversized-" + name))
                try:
                    os.link(path, preserved)
                except FileExistsError:
                    if not preserved.is_file() or not os.path.samefile(path, preserved):
                        raise ValueError(
                            "The preserved archive has different content."
                        ) from None
                status.update(
                    result="failed",
                    pending=None,
                    pending_config=None,
                    oversized_archive=preserved.name,
                    error="Oversized archive preserved; a fresh snapshot is required.",
                )
                save(self.status_path, status)
        finally:
            os.close(fd)

    def run(self, now=None):
        now = now or instant()
        status = self.status()
        lock = safe_path(self.folder / ".lock")
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            status = self.status()
            status.update(result="running", last_attempt=now.isoformat(), error=None)
            fingerprint = hashlib.sha256(
                json.dumps(self.config, sort_keys=True).encode()
            ).hexdigest()
            if (
                status["pending"] is not None
                and status.get("pending_config") != fingerprint
            ):
                raise ValueError(
                    "Finish the pending backup before changing its configuration."
                )
            if status["pending"] is None:
                status["pending_config"] = fingerprint
                status["pending"] = (
                    "backend-"
                    + now.strftime("%Y%m%dT%H%M%SZ")
                    + "-"
                    + uuid4().hex
                    + ".age"
                )
            timestamp(status["pending"])
            save(self.status_path, status)
            try:
                self._run(status, now)
            except Exception as error:
                status.update(result="failed", error=type(error).__name__)
                save(self.status_path, status)
                raise
        finally:
            os.close(fd)

    def _run(self, status, now):
        name = status["pending"]
        path = safe_path(self.folder / name)
        with self.deployment.lock():
            self.resume(status)
            if not path.exists():
                self.deployment.verify_containers()
                status["resume_services"] = sorted(self.deployment.running())
                save(self.status_path, status)
                self.deployment.backup(path, self.config["recipient"])
                status["resume_services"] = []
                save(self.status_path, status)
        size = path.stat().st_size
        if not path.is_file() or path.stat().st_mode & 0o077:
            raise ValueError("Use a private encrypted archive within the size limit.")
        # Reject plaintext even when an interrupted run left a file behind.
        with path.open("rb") as stream:
            if stream.read(22) != b"age-encryption.org/v1\n":
                raise ValueError("Only age-encrypted archives may leave this host.")
        if size > MAX_ARCHIVE:
            raise OversizedArchive(
                "Encrypted archive exceeds the size limit; inspect it before replacement."
            )
        sha = digest(path)
        before = self.remote.list()
        if (
            sum(item["size"] for item in before.values())
            + (0 if name in before else size)
            > MAX_REMOTE
        ):
            raise ValueError(
                "Remote storage limit reached; inspect backups before deleting any."
            )
        self.remote.put(name, path, sha, self.config["image"])
        self.remote.verify(name, size, sha)
        objects = self.remote.list()
        if name not in objects:
            raise ValueError("Verified backup is missing from the remote listing.")
        keep = retained(objects)
        keep.add(name)  # Retain this verified run even when timestamps tie.
        for old, item in objects.items():
            if old not in keep:
                self.remote.delete(old, item["etag"])
        # Prune local copies only after verified off-host upload and retention.
        local = []
        for candidate in self.folder.iterdir():
            if NAME.fullmatch(candidate.name):
                safe_path(candidate)
                if not candidate.is_file():
                    raise ValueError("Unexpected local backup entry.")
                local.append(candidate)
        for old in sorted(local, key=lambda p: timestamp(p.name), reverse=True)[3:]:
            if old != path:
                old.unlink()
        status.update(
            result="ok",
            last_success=now.isoformat(),
            archive=name,
            sha256=sha,
            bytes=size,
            image=self.config["image"],
            pending=None,
            error=None,
        )
        save(self.status_path, status)


def healthy(status, now=None):
    now = now or instant()
    saved = status.get("last_success")
    if status.get("result") != "ok" or not saved:
        return False
    completed = min(datetime.fromisoformat(saved), timestamp(status["archive"]))
    return timedelta(0) <= now - completed <= timedelta(hours=36)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    parser.add_argument(
        "command", choices=("init", "run", "status", "recover", "replace-oversized")
    )
    parser.add_argument("--archive", help="Exact pending archive name to replace")
    args = parser.parse_args()
    if (args.command == "replace-oversized") != (args.archive is not None):
        parser.error("Use --archive only with replace-oversized.")
    try:
        config = settings(args.config)
        runner = ScheduledBackup(config, None)
        if args.command == "init":
            runner.initialize()
        elif args.command == "recover":
            runner.recover()
        elif args.command == "status":
            status = runner.status()
            print(json.dumps(status, indent=2))
            return 0 if healthy(status) else 1
        else:
            runner.remote = AzureBlobs(config["account"], config["container"])
            if args.command == "replace-oversized":
                runner.replace_oversized(args.archive)
                print(
                    "Oversized archive preserved; run a fresh backup after reducing its size."
                )
            else:
                runner.run()
                print("Encrypted backup verified off-host; retention completed.")
        return 0
    except Exception as error:
        # SDK exceptions may contain tokens or private request details.
        print(f"Automatic backup failed: {type(error).__name__}.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
