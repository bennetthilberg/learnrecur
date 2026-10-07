# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Read generation outcomes and accounting without showing exercises."""

from __future__ import annotations

import re
from html import escape
from typing import TYPE_CHECKING
from uuid import UUID

import requests

from anki.learnrecur_skill_import import MAX_BYTES, SkillImportError, _text, decode
from aqt import gui_hooks
from aqt.learnrecur_import import companion_connection
from aqt.operations import QueryOp
from aqt.qt import (
    QAbstractItemView,
    QDialog,
    QDialogButtonBox,
    QHeaderView,
    QLabel,
    Qt,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
)
from aqt.utils import disable_help_button, showWarning

if TYPE_CHECKING:
    from aqt.main import AnkiQt

PAGE_SIZE = 50
STATES = {
    "queued": "Waiting",
    "running": "Generating",
    "provider_pending": "Generating",
    "result_ready": "Ready to save",
    "retry_wait": "Retry pending",
    "waiting_budget": "Budget paused",
    "needs_attention": "Needs attention",
    "failed": "Failed",
    "obsolete": "Outdated",
    "completed": "Completed",
}
ACTIONS = {"create": "Add skill", "edit": "Edit skill", "refill": "Refill"}


def validate_history(value: object) -> dict:
    def number(item, *, minimum=0):
        if type(item) is not int or not minimum <= item <= 2**63 - 1:
            raise ValueError()

    try:
        if not isinstance(value, dict) or set(value) != {
            "source_id",
            "jobs",
            "next_before",
            "budget",
            "pause",
        }:
            raise ValueError()
        if str(UUID(value["source_id"])) != value["source_id"]:
            raise ValueError()
        if not isinstance(value["jobs"], list) or len(value["jobs"]) > PAGE_SIZE:
            raise ValueError()
        identities = set()
        for job in value["jobs"]:
            if not isinstance(job, dict) or set(job) != {
                "id",
                "title",
                "action",
                "state",
                "attempts",
                "estimated_spend_microusd",
                "reserved_microusd",
                "reason",
                "interrupted",
            }:
                raise ValueError()
            if not isinstance(job["id"], str) or not re.fullmatch(
                r"[0-9a-f]{32}", job["id"]
            ):
                raise ValueError()
            if job["id"] in identities:
                raise ValueError()
            identities.add(job["id"])
            _text(job["title"], 256)
            if job["action"] not in ACTIONS or job["state"] not in STATES:
                raise ValueError()
            for key in ("attempts", "estimated_spend_microusd", "reserved_microusd"):
                number(job[key])
            if type(job["interrupted"]) is not bool:
                raise ValueError()
            if job["reason"]:
                _text(job["reason"], 512)
            elif job["reason"] != "":
                raise ValueError()
        cursor = value["next_before"]
        if cursor is not None:
            number(cursor, minimum=1)
            if len(value["jobs"]) != PAGE_SIZE:
                raise ValueError()
        budget = value["budget"]
        if not isinstance(budget, dict) or set(budget) != {
            "month",
            "limit_microusd",
            "estimated_spend_microusd",
            "reserved_microusd",
        }:
            raise ValueError()
        if not isinstance(budget["month"], str) or not re.fullmatch(
            r"[0-9]{4}-(0[1-9]|1[0-2])", budget["month"]
        ):
            raise ValueError()
        for key in ("limit_microusd", "estimated_spend_microusd", "reserved_microusd"):
            number(budget[key])
        if value["pause"]:
            _text(value["pause"], 256)
        elif value["pause"] != "":
            raise ValueError()
    except (ValueError, TypeError, KeyError, AttributeError, SkillImportError):
        raise SkillImportError(
            "The companion returned invalid generation history."
        ) from None
    return value


def fetch_history(connection: tuple[str, str], before: int | None = None) -> dict:
    url, token = connection
    params = {"limit": PAGE_SIZE}
    if before is not None:
        params["before"] = before
    try:
        with requests.Session() as session:
            session.trust_env = False
            with session.get(
                url + "/v1/generation-history",
                params=params,
                headers={"Authorization": "Bearer " + token},
                timeout=(3, 5),
                allow_redirects=False,
                stream=True,
            ) as response:
                if response.status_code == 401:
                    raise SkillImportError("The companion token was rejected.")
                if response.status_code == 404:
                    raise SkillImportError(
                        "Update the companion to view generation history."
                    )
                if response.status_code != 200:
                    raise SkillImportError(
                        "The companion could not provide generation history."
                    )
                data = bytearray()
                for chunk in response.iter_content(65536):
                    data.extend(chunk)
                    if len(data) > MAX_BYTES:
                        raise SkillImportError(
                            "The generation history response is too large."
                        )
        value = validate_history(decode(bytes(data)))
        if (
            before is not None
            and value["next_before"] is not None
            and value["next_before"] >= before
        ):
            raise SkillImportError("The companion returned an invalid history cursor.")
        return value
    except requests.RequestException:
        raise SkillImportError(
            "Could not reach the companion. Check that it is running."
        ) from None


def dollars(amount: int) -> str:
    fraction = str(amount % 1_000_000).zfill(6).rstrip("0").ljust(2, "0")
    return f"${amount // 1_000_000}.{fraction}"


class GenerationHistory(QDialog):
    def __init__(self, mw: AnkiQt):
        super().__init__(mw)
        self.mw = mw
        self.collection = mw.col
        self.connection = companion_connection()
        self.closed = False
        self.busy = False
        self.source_id = None
        self.cursors = [None]
        self.next_before = None
        self.setWindowTitle("Generation history")
        self.setWindowModality(Qt.WindowModality.NonModal)
        disable_help_button(self)
        layout = QVBoxLayout(self)
        self.table = QTreeWidget(self)
        self.table.setHeaderLabels(
            ["Skill", "Action", "Status", "Attempts", "Est. spend", "Reserved"]
        )
        self.table.setRootIsDecorated(False)
        self.table.setAlternatingRowColors(True)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setAccessibleName("Generation history")
        header = self.table.header()
        header.setStretchLastSection(False)
        header.setSectionResizeMode(0, QHeaderView.ResizeMode.Stretch)
        for column in range(1, 6):
            header.setSectionResizeMode(column, QHeaderView.ResizeMode.Interactive)
        self.table.currentItemChanged.connect(self.selection_changed)
        layout.addWidget(self.table)
        self.detail = QLabel(self)
        self.detail.setTextFormat(Qt.TextFormat.PlainText)
        self.detail.setWordWrap(True)
        self.detail.hide()
        layout.addWidget(self.detail)
        self.budget = QLabel(self)
        self.budget.setTextFormat(Qt.TextFormat.PlainText)
        self.budget.setWordWrap(True)
        self.budget.setToolTip(
            "Usage-based estimates in USD after configured credits. Reserved amounts are not confirmed charges. The month is in UTC."
        )
        layout.addWidget(self.budget)
        self.status = QLabel(self)
        self.status.setTextFormat(Qt.TextFormat.PlainText)
        self.status.setWordWrap(True)
        layout.addWidget(self.status)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Close, parent=self)
        self.refresh_button = buttons.addButton(
            "Refresh", QDialogButtonBox.ButtonRole.ActionRole
        )
        self.newer_button = buttons.addButton(
            "Newer", QDialogButtonBox.ButtonRole.ActionRole
        )
        self.older_button = buttons.addButton(
            "Older", QDialogButtonBox.ButtonRole.ActionRole
        )
        self.refresh_button.clicked.connect(lambda: self.load("refresh"))
        self.newer_button.clicked.connect(lambda: self.load("newer"))
        self.older_button.clicked.connect(lambda: self.load("older"))
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)
        self.finished.connect(self.finished_history)
        gui_hooks.profile_will_close.append(self.reject)
        self.resize(940, 440)
        self.setMinimumSize(640, 280)
        self.load("refresh")

    def finished_history(self, _result):
        if self.closed:
            return
        self.closed = True
        gui_hooks.profile_will_close.remove(self.reject)
        if getattr(self.mw, "_learnrecur_generation_history", None) is self:
            self.mw._learnrecur_generation_history = None

    def current(self) -> bool:
        if self.closed:
            return False
        if self.mw.col is not self.collection:
            self.reject()
            return False
        try:
            same_connection = companion_connection() == self.connection
        except SkillImportError:
            same_connection = False
        if not same_connection:
            self.table.clear()
            self.budget.clear()
            self.set_busy(False)
            self.refresh_button.setEnabled(False)
            self.newer_button.setEnabled(False)
            self.older_button.setEnabled(False)
            self.message("The connection changed. Close and reopen generation history.")
            return False
        return True

    def message(self, text):
        self.status.setText(text)
        self.status.setVisible(bool(text))

    def set_busy(self, busy):
        self.busy = busy
        self.refresh_button.setEnabled(not busy)
        self.newer_button.setEnabled(not busy and len(self.cursors) > 1)
        self.older_button.setEnabled(not busy and self.next_before is not None)

    def load(self, direction):
        if self.busy or not self.current():
            return
        before = None
        if direction == "older":
            if self.next_before is None:
                return
            before = self.next_before
        elif direction == "newer":
            if len(self.cursors) < 2:
                return
            before = self.cursors[-2]
        self.set_busy(True)
        self.message("Loading…")

        def received(value):
            if not self.current():
                return
            if direction != "refresh" and self.source_id != value["source_id"]:
                self.table.clear()
                self.budget.clear()
                self.cursors = [None]
                self.next_before = None
                self.set_busy(False)
                self.message("The companion changed. Refresh generation history.")
                return
            self.source_id = value["source_id"]
            if direction == "refresh":
                self.cursors = [None]
            elif direction == "older":
                self.cursors.append(before)
            else:
                self.cursors.pop()
            self.next_before = value["next_before"]
            self.table.clear()
            for job in value["jobs"]:
                status = (
                    "Awaiting recovery" if job["interrupted"] else STATES[job["state"]]
                )
                item = QTreeWidgetItem(
                    [
                        job["title"],
                        ACTIONS[job["action"]],
                        status,
                        str(job["attempts"]),
                        dollars(job["estimated_spend_microusd"]),
                        dollars(job["reserved_microusd"]),
                    ]
                )
                item.setToolTip(0, f"<qt>{escape(job['title'])}</qt>")
                item.setData(0, Qt.ItemDataRole.UserRole, job["reason"])
                self.table.addTopLevelItem(item)
            for column in range(1, 6):
                self.table.resizeColumnToContents(column)
                self.table.setColumnWidth(column, self.table.columnWidth(column) + 12)
            budget = value["budget"]
            self.budget.setText(
                f"{budget['month']} (UTC): {dollars(budget['estimated_spend_microusd'])} estimated spend · "
                f"{dollars(budget['reserved_microusd'])} reserved · {dollars(budget['limit_microusd'])} limit"
            )
            self.message(
                value["pause"] or ("No generation jobs." if not value["jobs"] else "")
            )
            self.set_busy(False)

        def failed(_error):
            if not self.current():
                return
            self.set_busy(False)
            suffix = (
                " Previously loaded history may be out of date."
                if self.table.topLevelItemCount()
                else ""
            )
            message = (
                str(_error)
                if isinstance(_error, SkillImportError)
                else "Could not load generation history."
            )
            self.message(message + suffix)

        QueryOp(
            parent=self,
            op=lambda _: fetch_history(self.connection, before),
            success=received,
        ).failure(failed).without_collection().run_in_background()

    def selection_changed(self, item, _previous):
        reason = item.data(0, Qt.ItemDataRole.UserRole) if item else ""
        self.detail.setText(reason)
        self.detail.setVisible(bool(reason))


def open_history(mw: AnkiQt) -> None:
    if not mw.col:
        showWarning("Open a profile before viewing generation history.", parent=mw)
        return
    dialog = getattr(mw, "_learnrecur_generation_history", None)
    if not dialog or dialog.closed:
        try:
            dialog = GenerationHistory(mw)
        except SkillImportError as error:
            showWarning(str(error), parent=mw)
            return
        mw._learnrecur_generation_history = dialog
        mw.garbage_collect_on_dialog_finish(dialog)
    dialog.show()
    dialog.raise_()
    dialog.activateWindow()
