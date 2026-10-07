# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Run one backend process inside the private deployment network."""

import os
import sys
from pathlib import Path

from learnrecur.deploy.recovery import require_active
from learnrecur.deploy.run_sync_server import server_environment


def read_secret(name):
    path = Path("/run/secrets") / name
    if (
        not path.is_file()
        or path.is_symlink()
        or path.stat().st_mode & 0o077
        or path.stat().st_size > 4096
    ):
        raise ValueError("Missing private deployment credential.")
    return path.read_text().strip()


def main():
    os.umask(0o077)
    mode = sys.argv[1] if len(sys.argv) == 2 else ""
    require_active(Path("/state/sync" if mode == "sync" else "/state/companion"))
    provider = os.environ.get("LEARNRECUR_GENERATION_PROVIDER", "fixture")
    if provider not in {"fixture", "openai"}:
        raise ValueError("Choose fixture or openai as the generation provider.")
    folder = Path("/state/companion")
    paused = (folder / ".restore-pending").exists() or (
        provider == "openai" and (folder / ".paid-restore-pending").exists()
    )
    if mode == "sync":
        env = server_environment(
            Path("/state/sync"), 45331, read_secret("sync_account")
        )
        # Compose publishes this container port only on the host's loopback.
        env["SYNC_HOST"] = "0.0.0.0"
        binary = "/usr/local/bin/anki-sync-server"
        os.execve(binary, [binary], env)
    elif mode == "companion":
        from learnrecur.companion.server import Server, Store

        store = Store(Path("/state/companion"))
        store.configure_environment_limits()
        server = Server(
            store,
            read_secret("companion_token"),
            45321,
            host="0.0.0.0",
            refill_provider=None if paused else provider,
        )
        server.serve_forever()
    elif mode == "worker":
        if paused:
            raise ValueError(
                "Restored jobs need inspection before starting the worker."
            )
        from learnrecur.companion.server import Store

        Store(folder).configure_environment_limits()
        options = []
        if provider == "openai":
            try:
                limit = int(os.environ["LEARNRECUR_GENERATION_LIMIT"])
            except (KeyError, ValueError):
                raise ValueError("Specify an authorized OpenAI allowance.") from None
            if not 0 <= limit <= 5000000:
                raise ValueError("Specify an authorized allowance of at most $5.")
            options = [
                "--provider",
                "openai",
                "--allow-paid-generation",
                "--key-file",
                "/run/learnrecur-openai/openai-api-key",
                "--monthly-limit-microusd",
                str(limit),
            ]
        os.execv(
            sys.executable,
            [
                sys.executable,
                "-m",
                "learnrecur.companion.jobs",
                "--data-dir",
                "/state/companion",
                *options,
            ],
        )
    else:
        raise ValueError("Choose sync, companion, or worker.")


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        sys.exit(str(error))
