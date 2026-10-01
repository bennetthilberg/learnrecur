# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Check skill links after native sync, without deleting conflicting copies."""

from collections.abc import Callable

from anki.learnrecur_skill_links import validate_skill_links
from aqt.operations import QueryOp
from aqt.utils import showWarning


def finish_skill_sync(mw, on_done: Callable[[], None]) -> None:
    def failure(error):
        showWarning(str(error), parent=mw)
        on_done()

    QueryOp(parent=mw, op=validate_skill_links, success=lambda _: on_done()).failure(
        failure
    ).run_in_background()
