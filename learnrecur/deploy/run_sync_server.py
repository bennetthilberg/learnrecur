# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Run the pinned sync binary on loopback in separate LearnRecur storage."""

from __future__ import annotations

import argparse
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MARKER = ".learnrecur-sync"
VERSION = "learnrecur-sync-v1\n"


def server_environment(folder: Path, port: int, account: str) -> dict[str, str]:
    name, separator, password = account.partition(":")
    if not separator or not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", name) or not password:
        raise ValueError(
            "Set LEARNRECUR_SYNC_ACCOUNT to username:password; use letters, numbers, hyphens, or underscores in the username."
        )
    if not 1 <= port <= 65535:
        raise ValueError("Choose a port from 1 to 65535.")
    folder = Path(os.path.abspath(folder.expanduser()))
    if any(
        part.casefold() in {"anki", "anki2", ".anki"} for part in folder.parts
    ) or any(path.is_symlink() for path in (folder, *folder.parents)):
        raise ValueError("Use separate sync storage without symbolic links.")
    marker = folder / MARKER
    if marker.is_symlink():
        raise ValueError("The sync marker must not be a symbolic link.")
    if marker.exists():
        if marker.read_text() != VERSION:
            raise ValueError("Unrecognized sync folder.")
        if any(path.is_symlink() for path in folder.rglob("*")):
            raise ValueError("Sync storage must not contain symbolic links.")
    elif folder.exists() and any(folder.iterdir()):
        raise ValueError("Use an empty folder or existing LearnRecur sync storage.")
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    marker.write_text(VERSION)
    env = {
        key: value
        for key, value in os.environ.items()
        if not key.startswith("SYNC_")
        and key
        not in {
            "PASSWORDS_HASHED",
            "MAX_SYNC_PAYLOAD_MEGS",
            "ANKI_BASE",
            "ANKI_SYNC_ENDPOINT",
            "ANKI_SYNC_ENDPOINT2",
        }
    }
    env.update(
        SYNC_HOST="127.0.0.1",
        SYNC_PORT=str(port),
        SYNC_BASE=str(folder),
        SYNC_USER1=account,
    )
    return env


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=45331)
    parser.add_argument(
        "--binary", type=Path, default=ROOT / "target/debug/anki-sync-server"
    )
    args = parser.parse_args()
    try:
        binary = args.binary.resolve(strict=True)
        env = server_environment(
            args.data_dir, args.port, os.environ.get("LEARNRECUR_SYNC_ACCOUNT", "")
        )
    except (ValueError, OSError) as error:
        parser.error(str(error))
    os.execve(binary, [str(binary)], env)


if __name__ == "__main__":
    main()
