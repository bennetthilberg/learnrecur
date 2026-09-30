# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Application identity and storage rules shared by all desktop entry points."""

from __future__ import annotations

import os
import sys
from pathlib import Path

APP_NAME = "LearnRecur"
APP_ID = "io.github.bennetthilberg.learnrecur.anki"
DATA_MARKER = ".learnrecur-data"
DATA_VERSION = "learnrecur-data-v1\n"


def default_base() -> Path:
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support/LearnRecur"
    if sys.platform == "win32":
        from aqt.winpaths import get_appdata

        return Path(get_appdata()) / APP_NAME
    return (
        Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local/share")) / APP_NAME
    )


def ensure_data_folder(path_override: str | None = None) -> Path:
    """Use only LearnRecur storage, never adopt an existing Anki profile."""
    path = Path(path_override or os.environ.get("LEARNRECUR_BASE") or default_base())
    path = path.expanduser().resolve()
    if any(part.casefold() in {"anki2", ".anki", "anki"} for part in path.parts):
        raise ValueError(
            "LearnRecur cannot use an Anki data folder. Choose a separate folder."
        )

    marker = path / DATA_MARKER
    if marker.is_symlink():
        raise ValueError("The LearnRecur data marker must not be a symbolic link.")
    if marker.exists():
        if marker.read_text(encoding="utf-8") != DATA_VERSION:
            raise ValueError("Unrecognized LearnRecur data folder.")
    else:
        if path.exists() and any(path.iterdir()):
            raise ValueError(
                "LearnRecur needs an empty folder or its own existing data folder."
            )
        path.mkdir(parents=True, exist_ok=True)
        marker.write_text(DATA_VERSION, encoding="utf-8")
    return path


def storage_path(base: str, path: str) -> str:
    """Reject profile paths or symbolic links that leave LearnRecur storage."""
    resolved = Path(path).resolve()
    if not resolved.is_relative_to(Path(base).resolve()):
        raise ValueError("LearnRecur data must stay inside its own folder.")
    return str(resolved)
