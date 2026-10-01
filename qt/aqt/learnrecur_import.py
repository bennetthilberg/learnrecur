# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Fetch a local companion snapshot, preview it, and import native skill cards."""

from __future__ import annotations

import os
import re
from typing import TYPE_CHECKING

import requests

from anki.learnrecur_skill_import import (
    MAX_BYTES,
    SkillImportError,
    decode,
    import_snapshot,
    validate_snapshot,
)
from aqt.operations import CollectionOp, QueryOp
from aqt.qt import QDialog, QDialogButtonBox, QTextEdit, QVBoxLayout
from aqt.utils import showWarning, tooltip

if TYPE_CHECKING:
    from aqt.main import AnkiQt


def fetch_snapshot() -> object:
    url = os.environ.get("LEARNRECUR_COMPANION_URL", "http://127.0.0.1:45321")
    token = os.environ.get("LEARNRECUR_COMPANION_TOKEN", "")
    match = re.fullmatch(r"http://127\.0\.0\.1:([0-9]{1,5})", url)
    if not match or not 1 <= int(match[1]) <= 65535:
        raise SkillImportError(
            "Use a local companion URL such as http://127.0.0.1:45321."
        )
    if not token.isascii() or len(token) < 32 or any(char.isspace() for char in token):
        raise SkillImportError(
            "Set LEARNRECUR_COMPANION_TOKEN before launching LearnRecur."
        )
    try:
        with requests.Session() as session:
            session.trust_env = (
                False  # Do not send the token through an environment proxy.
            )
            with session.get(
                url + "/v1/skills",
                headers={"Authorization": "Bearer " + token},
                timeout=(3, 5),
                allow_redirects=False,
                stream=True,
            ) as response:
                if response.status_code == 401:
                    raise SkillImportError("The companion token was rejected.")
                if response.status_code != 200:
                    raise SkillImportError(
                        "The companion could not provide skills. Retry later."
                    )
                data = bytearray()
                for chunk in response.iter_content(65536):
                    data.extend(chunk)
                    if len(data) > MAX_BYTES:
                        raise SkillImportError("The skill batch is too large.")
        snapshot = decode(bytes(data))
        validate_snapshot(snapshot)
        return snapshot
    except requests.RequestException:
        # requests errors can include URLs or headers; keep credentials out of UI/logs.
        raise SkillImportError(
            "Could not reach the local companion. Check that it is running."
        ) from None


def confirm_import(parent: AnkiQt, skills: list[dict]) -> bool:
    dialog = QDialog(parent)
    dialog.setWindowTitle("Import skills")
    layout = QVBoxLayout(dialog)
    preview = QTextEdit(dialog)
    preview.setReadOnly(True)
    preview.setPlainText(
        "\n\n".join(f"{skill['title']}\n{skill['description']}" for skill in skills)
    )
    layout.addWidget(preview)
    buttons = QDialogButtonBox(
        QDialogButtonBox.StandardButton.Ok | QDialogButtonBox.StandardButton.Cancel,
        parent=dialog,
    )
    buttons.button(QDialogButtonBox.StandardButton.Ok).setText("Import")
    buttons.accepted.connect(dialog.accept)
    buttons.rejected.connect(dialog.reject)
    layout.addWidget(buttons)
    dialog.resize(500, 350)
    return dialog.exec() == QDialog.DialogCode.Accepted


def import_skills(mw: AnkiQt) -> None:
    if mw.state not in ("deckBrowser", "overview") or not mw.col:
        showWarning("Return to the deck list before importing skills.", parent=mw)
        return
    collection = mw.col

    def received(snapshot: object) -> None:
        if mw.col is not collection or mw.state not in ("deckBrowser", "overview"):
            return
        _, skills = validate_snapshot(snapshot)
        if not skills:
            tooltip("No skills to import.", parent=mw)
            return
        if not confirm_import(mw, skills):
            return

        def apply(col):
            if col is not collection:
                raise SkillImportError("The profile changed. Import skills again.")
            return import_snapshot(col, snapshot)

        CollectionOp(parent=mw, op=apply).success(
            lambda result: tooltip(
                f"Added {result.added} skills; {result.existing} already imported.",
                parent=mw,
            )
        ).failure(lambda error: showWarning(str(error), parent=mw)).run_in_background()

    QueryOp(parent=mw, op=lambda _: fetch_snapshot(), success=received).failure(
        lambda error: showWarning(str(error), parent=mw)
    ).with_progress().run_in_background()
