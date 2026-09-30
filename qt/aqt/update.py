# Copyright: Ankitects Pty Ltd and contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""The upstream updater is disabled until LearnRecur has its own releases."""

from __future__ import annotations

from typing import Callable

import aqt
from anki.collection import GithubRelease
from aqt.operations import QueryOp
from aqt.qt import QWidget


def check_for_update() -> None:
    return


def prompt_to_update(mw: aqt.AnkiQt, ver: str) -> None:
    raise RuntimeError("LearnRecur does not install Anki updates.")


def prompt_and_install_github_update(mw: aqt.AnkiQt, release: GithubRelease) -> None:
    raise RuntimeError("LearnRecur does not install Anki updates.")


def get_latest_release_op(
    parent: QWidget,
    include_prerelease: bool,
    on_success: Callable[[GithubRelease], None],
) -> QueryOp:
    raise RuntimeError("LearnRecur update checks are not available yet.")
