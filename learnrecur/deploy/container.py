# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Run one backend process inside the private deployment network."""

import os
import sys
from pathlib import Path

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

        server = Server(
            Store(Path("/state/companion")),
            read_secret("companion_token"),
            45321,
            host="0.0.0.0",
        )
        server.serve_forever()
    elif mode == "worker":
        if Path("/state/companion/.restore-pending").exists():
            raise ValueError(
                "Restored jobs need inspection before starting the worker."
            )
        os.execv(
            sys.executable,
            [
                sys.executable,
                "-m",
                "learnrecur.companion.jobs",
                "--data-dir",
                "/state/companion",
            ],
        )
    else:
        raise ValueError("Choose sync, companion, or worker.")


if __name__ == "__main__":
    try:
        main()
    except ValueError as error:
        sys.exit(str(error))
