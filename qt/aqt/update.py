# Copyright: Ankitects Pty Ltd and contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Keep clock checks separate from the disabled upstream updater."""

from __future__ import annotations

import time
from email.utils import parsedate_to_datetime
from typing import Callable

import requests

import aqt
from anki.collection import GithubRelease
from aqt.operations import QueryOp
from aqt.qt import Qt, QWidget
from aqt.utils import show_warning, tr

CLOCK_URL = "https://www.cloudflare.com/"


def clock_offset() -> float:
    """Check HTTPS response time without sending profile or collection data."""
    started = time.monotonic()
    with requests.head(
        CLOCK_URL,
        headers={"Cache-Control": "no-cache"},
        timeout=5,
        allow_redirects=False,
        verify=True,
    ) as response:
        if response.status_code != 200:
            raise ValueError("Clock check did not receive a successful response.")
        server_date = parsedate_to_datetime(response.headers["Date"])
        if server_date.tzinfo is None:
            raise ValueError("Clock check received a date without a time zone.")
        age = int(response.headers.get("Age", "0"))
        if age < 0:
            raise ValueError("Clock check received an invalid response age.")
        elapsed = time.monotonic() - started
        # Allow for response travel time and the Date header's one-second precision.
        difference = abs(time.time() - (server_date.timestamp() + age))
        return max(0, difference - elapsed - 1)


def check_system_clock(mw: aqt.AnkiQt) -> None:
    def on_done(difference: float) -> None:
        if difference > 300:
            diff_text = tr.qt_misc_second(count=int(difference))
            warning = (
                tr.qt_misc_in_order_to_ensure_your_collection(val="%s") % diff_text
            )
            show_warning(
                warning,
                parent=mw,
                textFormat=Qt.TextFormat.RichText,
                callback=mw.app.closeAllWindows,
            )

    def on_fail(_exc: Exception) -> None:
        # Offline use remains available, as it did with the upstream update check.
        print("LearnRecur could not check the system clock.")

    QueryOp(parent=mw, op=lambda _col: clock_offset(), success=on_done).failure(
        on_fail
    ).without_collection().run_in_background()


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
