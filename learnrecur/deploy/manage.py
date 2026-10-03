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

from learnrecur.companion.credentials import load_key
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

    def generation_settings(self):
        path = safe_path(self.credentials / "generation.json")
        if not path.exists():
            return {"provider": "fixture"}
        if (
            not path.is_file()
            or path.stat().st_mode & 0o077
            or path.stat().st_uid != self.uid
            or path.stat().st_size > 1024
        ):
            raise ValueError("Use a private generation configuration.")
        value = json.loads(path.read_text())
        if (
            not isinstance(value, dict)
            or set(value) != {"provider", "monthly_limit_microusd"}
            or value["provider"] != "openai"
            or type(value["monthly_limit_microusd"]) is not int
            or not 0 <= value["monthly_limit_microusd"] <= 5000000
        ):
            raise ValueError("Invalid generation configuration.")
        return value

    def openai_key(self):
        return safe_path(self.credentials / "openai/openai-api-key")

    def configure_openai(self, limit):
        validate_root(self.state)
        self.verify_containers()
        if self.running():
            raise ValueError("Stop the deployment before changing providers.")
        if type(limit) is not int or not 0 <= limit <= 5000000:
            raise ValueError("Specify an authorized allowance of at most $5.")
        if any(
            (self.state / "companion" / name).exists()
            for name in (".restore-pending", ".paid-restore-pending")
        ):
            raise ValueError("Restored paid generation must stay paused.")
        load_key(self.openai_key())
        # Set the allowance before enabling refills, retaining all prior accounting.
        self.compose(
            "run",
            "--rm",
            "--no-deps",
            "--entrypoint",
            "python",
            "worker",
            "-c",
            "from pathlib import Path; from learnrecur.companion.server import Store; from learnrecur.companion.jobs import Jobs; Jobs(Store(Path('/state/companion'))).configure_budget("
            + str(limit)
            + ")",
        )
        path = self.credentials / "generation.json"
        temporary = self.credentials / ".generation-new.json"
        fd = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
        )
        try:
            with os.fdopen(fd, "w") as stream:
                json.dump(
                    {"provider": "openai", "monthly_limit_microusd": limit}, stream
                )
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def compose(self, *arguments):
        settings = self.generation_settings()
        files = ["-f", str(COMPOSE)]
        env = {**self.env, "LEARNRECUR_GENERATION_PROVIDER": "fixture"}
        if settings["provider"] == "openai":
            files += ["-f", str(COMPOSE.with_name("compose.openai.yaml"))]
            env.update(
                LEARNRECUR_GENERATION_PROVIDER="openai",
                LEARNRECUR_GENERATION_LIMIT=str(settings["monthly_limit_microusd"]),
            )
        return subprocess.run(
            [
                "docker",
                "compose",
                *files,
                "-p",
                self.project,
                "--profile",
                "worker",
                *arguments,
            ],
            env=env,
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
        if worker and self.generation_settings()["provider"] == "openai":
            if (self.state / "companion/.paid-restore-pending").exists():
                raise ValueError("Restored paid generation must stay paused.")
            load_key(self.openai_key())
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
            "--label",
            "io.learnrecur.deployment-helper=" + self.project,
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

    def stop_helpers(self):
        # Manager locking prevents stopping a helper from a concurrent operation.
        ids = subprocess.run(
            [
                "docker",
                "ps",
                "--quiet",
                "--filter",
                "label=io.learnrecur.deployment-helper=" + self.project,
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.split()
        if not ids:
            return
        items = json.loads(
            subprocess.run(
                ["docker", "inspect", *ids],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        )
        for item in items:
            if item["Config"]["Image"] != self.image or not any(
                mount.get("Source") == str(self.state)
                and mount.get("Destination") == "/state"
                and not mount.get("RW")
                for mount in item["Mounts"]
            ):
                raise ValueError("An abandoned helper belongs to another deployment.")
        subprocess.run(["docker", "stop", *ids], check=True, capture_output=True)

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

    def reconcile_openai(self, job_id, response_id):
        validate_root(self.state)
        self.verify_containers()
        if self.running():
            raise ValueError("Stop the deployment before reconciling a response.")
        key = self.openai_key()
        load_key(key)
        # This command uses the existing response's GET path, never the worker loop.
        subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--read-only",
                "--user",
                f"{self.uid}:{self.uid}",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--tmpfs",
                "/tmp:size=64m,mode=1777",
                "--mount",
                f"type=bind,src={self.state / 'companion'},dst=/state/companion",
                "--mount",
                f"type=bind,src={key.parent},dst=/run/learnrecur-openai,readonly",
                "--entrypoint",
                "python",
                self.image,
                "-m",
                "learnrecur.companion.jobs",
                "--data-dir",
                "/state/companion",
                "--provider",
                "openai",
                "--allow-paid-generation",
                "--key-file",
                "/run/learnrecur-openai/openai-api-key",
                "--reconcile-job",
                job_id,
                "--response-id",
                response_id,
            ],
            check=True,
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
            "configure-openai",
            "inspect-generation",
            "publish-ready",
            "reconcile-openai",
        ),
    )
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--recipient")
    parser.add_argument("--identity", type=Path)
    parser.add_argument("--monthly-limit-microusd", type=int)
    parser.add_argument("--job-id")
    parser.add_argument("--response-id")
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
            elif args.command in ("allow-fixture-worker", "publish-ready"):
                validate_root(deployment.state)
                deployment.verify_containers()
                if deployment.running():
                    raise ValueError(
                        "Stop the restored deployment before inspecting jobs."
                    )
                deployment.helper(
                    [(deployment.state, "/state", False)],
                    args.command,
                    "--root",
                    "/state",
                )
            elif args.command == "configure-openai":
                deployment.configure_openai(args.monthly_limit_microusd)
            elif args.command == "inspect-generation":
                validate_root(deployment.state)
                deployment.helper(
                    [(deployment.state, "/state", True)],
                    "inspect-generation",
                    "--root",
                    "/state",
                )
            elif (
                args.command == "reconcile-openai" and args.job_id and args.response_id
            ):
                deployment.reconcile_openai(args.job_id, args.response_id)
            else:
                raise ValueError(
                    "Supply the archive and recipient or identity options."
                )
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Deployment operation failed: {type(error).__name__}.\n")


if __name__ == "__main__":
    main()
