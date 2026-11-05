# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Save a worker key outside the repository, without echoing it or using shell history."""

from __future__ import annotations

import getpass
import os
import re
import stat
import sys
from pathlib import Path


def key_path(provider="openai"):
    return Path.home() / f".config/learnrecur/secrets/{provider}-api-key"


def _path(path):
    path = Path(os.path.abspath(Path(path).expanduser()))
    repo = Path(__file__).resolve().parents[2]
    folded = Path(str(path).casefold())
    if (
        any(
            folded.is_relative_to(Path(str(folder).casefold()))
            for folder in (repo, Path.home() / "Library/Application Support")
        )
        or any(p.casefold() in {"anki", "anki2", ".anki"} for p in path.parts)
        or any(p.is_symlink() for p in (path, *path.parents))
    ):
        raise ValueError(
            "Keep the key outside repositories and desktop profiles, without links."
        )
    return path


def _key(value):
    if not re.fullmatch(r"sk-[A-Za-z0-9_-]{20,512}", value):
        raise ValueError("Enter a secret API key on one line.")
    return value


def _private(info, mode):
    if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != mode:
        raise ValueError(
            "The key folder must be private (700) and its file private (600)."
        )


def save_key(path, value):
    path = _path(path)
    value = _key(value)
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    _private(path.parent.stat(), 0o700)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as stream:
        stream.write(value + "\n")
        stream.flush()
        os.fsync(stream.fileno())


def load_key(path):
    path = _path(path)
    _private(path.parent.stat(), 0o700)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "r") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 1024:
            raise ValueError("Use a regular, unlinked key file.")
        _private(info, 0o600)
        return _key(stream.read(1025).strip())


def main():
    provider = sys.argv[1] if len(sys.argv) == 2 else "openai"
    if provider not in ("openai", "anthropic"):
        raise SystemExit("Choose openai or anthropic.")
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        raise SystemExit(
            "Run this in your own interactive terminal; do not pipe the key."
        )
    try:
        save_key(key_path(provider), getpass.getpass(f"{provider} key (hidden): "))
    except (OSError, ValueError):
        raise SystemExit(
            "Key not saved. Check the path, permissions, or existing file."
        ) from None
    print(f"Saved key to {key_path(provider)}")


if __name__ == "__main__":
    main()
