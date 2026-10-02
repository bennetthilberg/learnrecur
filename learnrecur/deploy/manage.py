# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Start, stop, and back up one isolated Linux backend deployment."""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import secrets
import subprocess
from contextlib import contextmanager
from pathlib import Path

from learnrecur.deploy.backup import MARKER, STORES, VERSION, safe_path, validate_root

COMPOSE = Path(__file__).with_name("compose.yaml")
SERVICES = {"sync", "companion", "worker"}


class Deployment:
    def __init__(self, state, credentials, image, project="learnrecur", uid=None):
        self.state = safe_path(state)
        self.credentials = safe_path(credentials)
        self.uid = os.getuid() if uid is None else uid
        if self.uid == 0:
            raise ValueError("Run deployment management as a dedicated non-root user.")
        if not re.fullmatch(r"[a-z][a-z0-9-]{0,40}", project) or not re.fullmatch(
            r"[a-zA-Z0-9._/:@-]+", image
        ):
            raise ValueError("Use a valid project and explicit image tag or digest.")
        if self.state.is_relative_to(
            self.credentials
        ) or self.credentials.is_relative_to(self.state):
            raise ValueError("Keep credentials separate from backend state.")
        self.image = image
        self.project = project
        self.env = {
            **os.environ,
            "LEARNRECUR_IMAGE": image,
            "LEARNRECUR_STATE": str(self.state),
            "LEARNRECUR_SECRETS": str(self.credentials),
            "LEARNRECUR_UID": str(self.uid),
        }

    def compose(self, *arguments):
        return subprocess.run(
            [
                "docker",
                "compose",
                "-f",
                str(COMPOSE),
                "-p",
                self.project,
                "--profile",
                "worker",
                *arguments,
            ],
            env=self.env,
            check=True,
            capture_output=True,
            text=True,
        ).stdout

    def verify_containers(self):
        ids = self.compose("ps", "--all", "--quiet").split()
        if not ids:
            return
        result = subprocess.run(
            ["docker", "inspect", *ids], check=True, capture_output=True, text=True
        )
        for item in json.loads(result.stdout):
            service = item["Config"]["Labels"].get("com.docker.compose.service")
            folder = "sync" if service == "sync" else "companion"
            if service not in SERVICES or not any(
                mount.get("Source") == str(self.state / folder)
                and mount.get("Destination") == "/state/" + folder
                for mount in item["Mounts"]
            ):
                raise ValueError("This project name belongs to another deployment.")

    def running(self):
        names = set(self.compose("ps", "--status", "running", "--services").split())
        if not names <= SERVICES:
            raise ValueError("Unexpected service in this deployment.")
        return names

    @contextmanager
    def lock(self):
        lock = safe_path(
            self.state.parent / ("." + self.state.name + ".deployment-lock")
        )
        fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            yield
        finally:
            os.close(fd)

    def initialize(self):
        if self.state.exists() or self.credentials.exists():
            raise ValueError(
                "Initialization requires new state and credential directories."
            )
        for folder in (self.state, self.credentials):
            folder.mkdir(mode=0o700)
        (self.state / MARKER).write_text(VERSION)
        for name, (marker, version) in STORES.items():
            folder = self.state / name
            folder.mkdir(mode=0o700)
            (folder / marker).write_text(version)
        (self.credentials / "sync-account").write_text(
            "learnrecur:" + secrets.token_urlsafe(32) + "\n"
        )
        (self.credentials / "companion-token").write_text(
            secrets.token_urlsafe(32) + "\n"
        )
        for path in self.credentials.iterdir():
            path.chmod(0o600)

    def start(self, worker=False):
        validate_root(self.state)
        self.verify_containers()
        for name in ("sync-account", "companion-token"):
            path = safe_path(self.credentials / name)
            if (
                not path.is_file()
                or path.stat().st_mode & 0o077
                or path.stat().st_uid != self.uid
            ):
                raise ValueError("Use private credentials owned by the service user.")
        if worker and (self.state / "companion/.restore-pending").exists():
            raise ValueError("Inspect restored jobs before enabling the worker.")
        self.compose(
            "up",
            "-d",
            *(["sync", "companion", "worker"] if worker else ["sync", "companion"]),
        )

    def helper(self, mounts, *arguments):
        command = [
            "docker",
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--user",
            f"{self.uid}:{self.uid}",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--tmpfs",
            "/tmp:size=64m,mode=1777",
            "--entrypoint",
            "python",
        ]
        for source, destination, readonly in mounts:
            command += [
                "--mount",
                f"type=bind,src={source},dst={destination}"
                + (",readonly" if readonly else ""),
            ]
        subprocess.run(
            [*command, self.image, "-m", "learnrecur.deploy.backup", *arguments],
            check=True,
        )

    def backup(self, archive, recipient):
        validate_root(self.state)
        self.verify_containers()
        archive = safe_path(archive)
        if (
            archive.exists()
            or archive.is_relative_to(self.state)
            or archive.is_relative_to(self.credentials)
        ):
            raise ValueError("Choose a new backup file outside state and credentials.")
        archive.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        running = self.running()
        try:
            if running:
                self.compose("stop", *sorted(running))
            if self.running():
                raise ValueError("Every backend writer must stop before backup.")
            self.helper(
                [(self.state, "/state", True), (archive.parent, "/backups", False)],
                "create",
                "--root",
                "/state",
                "--archive",
                "/backups/" + archive.name,
                "--recipient",
                recipient,
            )
        finally:
            if running:
                self.compose("start", *sorted(running))

    def restore(self, archive, identity):
        if self.state.exists():
            raise ValueError("Restore into a new state directory.")
        self.verify_containers()
        if self.running():
            raise ValueError("Do not restore into a running deployment.")
        archive, identity = safe_path(archive), safe_path(identity)
        self.helper(
            [
                (self.state.parent, "/restore", False),
                (archive, "/backup.age", True),
                (identity, "/identity", True),
            ],
            "restore",
            "--root",
            "/restore/" + self.state.name,
            "--archive",
            "/backup.age",
            "--identity",
            "/identity",
        )


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--secrets", type=Path, required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--project", default="learnrecur")
    parser.add_argument(
        "command",
        choices=(
            "init",
            "start",
            "start-worker",
            "stop",
            "backup",
            "restore",
            "allow-fixture-worker",
        ),
    )
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--recipient")
    parser.add_argument("--identity", type=Path)
    args = parser.parse_args()
    try:
        deployment = Deployment(args.state, args.secrets, args.image, args.project)
        with deployment.lock():
            if args.command == "init":
                deployment.initialize()
            elif args.command in ("start", "start-worker"):
                deployment.start(worker=args.command == "start-worker")
            elif args.command == "stop":
                validate_root(deployment.state)
                deployment.verify_containers()
                deployment.compose("stop")
            elif args.command == "backup" and args.archive and args.recipient:
                deployment.backup(args.archive, args.recipient)
            elif args.command == "restore" and args.archive and args.identity:
                deployment.restore(args.archive, args.identity)
            elif args.command == "allow-fixture-worker":
                validate_root(deployment.state)
                deployment.verify_containers()
                if deployment.running():
                    raise ValueError(
                        "Stop the restored deployment before inspecting jobs."
                    )
                deployment.helper(
                    [(deployment.state, "/state", False)],
                    "allow-fixture-worker",
                    "--root",
                    "/state",
                )
            else:
                raise ValueError(
                    "Supply the archive and recipient or identity options."
                )
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Deployment operation failed: {type(error).__name__}.\n")


if __name__ == "__main__":
    main()
