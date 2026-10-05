# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Report the current exercise and return to the same card's question."""

from __future__ import annotations

from typing import TYPE_CHECKING

from anki.learnrecur_skills import report_skill_review
from aqt.operations import CollectionOp
from aqt.qt import QComboBox, QDialog, QDialogButtonBox, QLabel, QVBoxLayout
from aqt.utils import disable_help_button, showWarning

if TYPE_CHECKING:
    from aqt.reviewer import Reviewer


class ReportExerciseDialog(QDialog):
    def __init__(self, parent):
        super().__init__(parent)
        self.setWindowTitle("Report exercise")
        disable_help_button(self)
        self.setMinimumWidth(360)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(24)
        fields = QVBoxLayout()
        fields.setSpacing(8)
        self.reason = QComboBox(self)
        self.reason.setAccessibleName("Reason")
        reason_label = QLabel("&Reason", self)
        reason_label.setBuddy(self.reason)
        for label, code in (
            ("Choose a reason", None),
            ("Incorrect answer", "incorrect"),
            ("Unclear question", "unclear"),
            ("Outside this skill", "out_of_scope"),
            ("Other", "other"),
        ):
            self.reason.addItem(label, code)
        fields.addWidget(reason_label)
        fields.addWidget(self.reason)
        layout.addLayout(fields)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Cancel, self)
        self.report = buttons.addButton(
            "Report and skip", QDialogButtonBox.ButtonRole.AcceptRole
        )
        self.report.setDefault(True)
        self.report.setEnabled(False)
        self.reason.currentIndexChanged.connect(
            lambda _: self.report.setEnabled(self.reason.currentData() is not None)
        )
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)


def report_and_skip(reviewer: Reviewer) -> None:
    if (
        reviewer.state not in ("question", "answer")
        or reviewer._skill_error
        or not (review := reviewer._skill_review)
    ):
        return
    collection = reviewer.mw.col

    def still_reviewing() -> bool:
        return (
            reviewer.mw.col is collection
            and reviewer.mw.state == "review"
            and reviewer.card is not None
            and reviewer.card.id == review.card_id
            and reviewer._skill_review == review
        )

    reviewer._clear_auto_advance_timers()
    dialog = ReportExerciseDialog(reviewer.mw)
    if dialog.exec() != QDialog.DialogCode.Accepted:
        if not still_reviewing():
            return
        if reviewer.state == "answer":
            reviewer._auto_advance_to_question_if_enabled()
        else:
            reviewer._auto_advance_to_answer_if_enabled()
        return
    reason = dialog.reason.currentData()
    reviewer.state = "transition"

    def save_report(col):
        if col is not collection:
            raise ValueError("The collection changed. Report the exercise again.")
        return report_skill_review(col, review, reason)

    def done(_):
        if still_reviewing():
            reviewer.card.load()
            reviewer.card.start_timer()
            reviewer._skill_review = None
            reviewer._showQuestion()

    def failed(error):
        if still_reviewing():
            showWarning(str(error), parent=reviewer.mw)
            reviewer._redraw_current_card()

    CollectionOp(
        parent=reviewer.mw,
        op=save_report,
    ).success(done).failure(failed).run_in_background(initiator=reviewer)
