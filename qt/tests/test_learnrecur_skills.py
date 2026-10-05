"""Check the native reviewer and background answer operation together."""

import json
import runpy
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

import anki.lang
from anki.collection import Collection
from anki.learnrecur_skills import BANK_FIELD, SkillReviewError, select_skill_review
from anki.scheduler.v3 import CardAnswer
from aqt import learnrecur_report as report_ui
from aqt.operations import scheduling
from aqt.qt import QApplication, QDialog, QWidget
from aqt.reviewer import Reviewer

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def col(tmp_path):
    collection = Collection(str(tmp_path / "collection.anki2"))
    fixture = runpy.run_path(str(ROOT / "pylib/tests/learnrecur_skill_fixture.py"))
    fixture["seed"](collection)
    yield collection
    collection.close()


@pytest.fixture
def reviewer(col, monkeypatch):
    anki.lang.set_lang("en_US")
    monkeypatch.setattr(
        "aqt.reviewer.theme_manager.body_classes_for_card_ord", lambda _: "card"
    )
    reviewer = object.__new__(Reviewer)
    reviewer.card = col.get_card(col.find_cards('deck:"Spanish skill"')[0])
    reviewer._skill_review = None
    reviewer._skill_error = None
    reviewer._reps = 0
    reviewer.web = MagicMock()
    reviewer.bottom = SimpleNamespace(web=MagicMock())
    reviewer.mw = SimpleNamespace(
        col=col, state="review", web=MagicMock(), moveToState=MagicMock()
    )
    reviewer._mungeQA = lambda text: text
    for name in (
        "_run_state_mutation_hook",
        "_update_flag_icon",
        "_update_mark_icon",
        "_auto_advance_to_answer_if_enabled",
        "_auto_advance_to_question_if_enabled",
        "_showEaseButtons",
    ):
        setattr(reviewer, name, MagicMock())
    reviewer._remaining = lambda: ""
    return reviewer


def test_question_preload_reveal_and_redraw_pair(reviewer):
    reviewer._showQuestion()
    script = reviewer.web.eval.call_args_list[0].args[0]
    assert "Ana" in script and "habl\\u00e9" in script
    selected = reviewer._skill_review
    reviewer.card.load()  # Includes cache invalidation used by flag updates.
    reviewer._showAnswer()
    assert reviewer._skill_review == selected
    assert "Ana" in reviewer.card.answer() and "hablé" in reviewer.card.answer()
    reviewer._redraw_current_card()
    assert reviewer._skill_review == selected
    assert reviewer.mw.col.get_card(reviewer.card.id).reps == 0


def test_empty_bank_blocks_reveal_rating_and_has_exit(reviewer):
    note = reviewer.card.note()
    bank = json.loads(note[BANK_FIELD])
    bank["exercises"] = []
    note[BANK_FIELD] = json.dumps(bank)
    reviewer.mw.col.update_note(note)
    reviewer.card.load()
    reviewer._showQuestion()
    assert "no available exercises" in reviewer.card.question()
    assert "Back to deck" in reviewer.bottom.web.eval.call_args.args[0]
    reviewer._showAnswer()
    reviewer._answerCard(3)
    reviewer._showEaseButtons.assert_not_called()
    assert reviewer.state == "question"
    assert reviewer.mw.col.get_card(reviewer.card.id).reps == 0
    reviewer._linkHandler("skillExit")
    reviewer.mw.moveToState.assert_called_once_with("overview")


def test_edit_during_reveal_blocks_old_answer(reviewer):
    reviewer._showQuestion()
    note = reviewer.card.note()
    bank = json.loads(note[BANK_FIELD])
    bank["revision"] += 1
    note[BANK_FIELD] = json.dumps(bank)
    reviewer.mw.col.update_note(note)
    reviewer.card.load()
    reviewer._showAnswer()
    assert reviewer.state == "question"
    assert "changed" in reviewer.card.question()
    reviewer._showEaseButtons.assert_not_called()


@pytest.mark.parametrize("stale", [False, True])
def test_background_operation_validates_then_answers(col, monkeypatch, stale):
    queued = col.sched.get_queued_cards().cards[0]
    card = col.get_card(queued.card.id)
    card.start_timer()
    queued.states.current.custom_data = card.custom_data
    answer = col.sched.build_answer(
        card=card, states=queued.states, rating=CardAnswer.AGAIN
    )
    review = select_skill_review(card)
    monkeypatch.setattr(
        scheduling, "CollectionOp", lambda parent, op: SimpleNamespace(op=op)
    )
    operation = scheduling.answer_card(parent=None, answer=answer, skill_review=review)
    if stale:
        note = card.note()
        note[BANK_FIELD] = "{}"
        col.update_note(note)
        with pytest.raises(SkillReviewError):
            operation.op(col)
        assert col.get_card(card.id).reps == 0
        assert col.db.scalar("select count(*) from revlog") == 0
    else:
        operation.op(col)
        assert select_skill_review(col.get_card(card.id)).exercise.id == "trabajar"
        col.undo()
        assert select_skill_review(col.get_card(card.id)) == review


def test_ordinary_review_keeps_native_typed_answer(reviewer):
    reviewer.card = reviewer.mw.col.get_card(
        reviewer.mw.col.find_cards('deck:"Ordinary sample"')[0]
    )
    reviewer._prepare_skill_review()
    assert reviewer._skill_review is None
    assert reviewer._skill_error is None
    assert "[[type:Back]]" in reviewer.card.question()


def test_skill_error_stops_auto_advance_timer(reviewer):
    reviewer._skill_error = "This skill has no available exercises."
    reviewer.auto_advance_enabled = True
    timer = MagicMock()
    reviewer._show_answer_timer = timer
    reviewer._show_question_timer = None
    reviewer.mw.progress = MagicMock()
    Reviewer._auto_advance_to_answer_if_enabled(reviewer)
    timer.deleteLater.assert_called_once()
    assert reviewer._show_answer_timer is None
    reviewer.mw.progress.timer.assert_not_called()


@pytest.fixture
def app():
    return QApplication.instance() or QApplication([])


def report_operation(monkeypatch, *, accepted=True, reason="incorrect"):
    operations = []
    dialog = MagicMock()
    dialog.exec.return_value = (
        QDialog.DialogCode.Accepted if accepted else QDialog.DialogCode.Rejected
    )
    dialog.reason.currentData.return_value = reason
    monkeypatch.setattr(report_ui, "ReportExerciseDialog", lambda _: dialog)

    def operation(**kwargs):
        operations.append(kwargs)
        mock = MagicMock()
        mock.success.side_effect = lambda callback: (
            kwargs.update(success=callback) or mock
        )
        mock.failure.side_effect = lambda callback: (
            kwargs.update(failure=callback) or mock
        )
        return mock

    monkeypatch.setattr(report_ui, "CollectionOp", operation)
    return operations


def test_report_dialog_requires_reason_and_has_native_cancel(app):
    parent = QWidget()
    dialog = report_ui.ReportExerciseDialog(parent)
    assert dialog.reason.accessibleName() == "Reason"
    assert not dialog.report.isEnabled()
    dialog.reason.setCurrentIndex(1)
    assert dialog.report.isEnabled()
    assert dialog.reason.currentData() == "incorrect"
    dialog.reason.setCurrentIndex(0)
    assert not dialog.report.isEnabled()
    dialog.close()
    parent.close()


@pytest.mark.parametrize("side", ["question", "answer"])
def test_report_cancel_preserves_exercise_and_resumes_auto_advance(
    reviewer, monkeypatch, side
):
    operations = report_operation(monkeypatch, accepted=False)
    reviewer._showQuestion()
    reviewer.state = side
    pinned = reviewer._skill_review
    reviewer._clear_auto_advance_timers = MagicMock()
    reviewer._auto_advance_to_answer_if_enabled.reset_mock()
    report_ui.report_and_skip(reviewer)
    assert reviewer._skill_review == pinned and reviewer.state == side
    assert not operations
    reviewer._clear_auto_advance_timers.assert_called_once()
    if side == "question":
        reviewer._auto_advance_to_answer_if_enabled.assert_called_once()
    else:
        reviewer._auto_advance_to_question_if_enabled.assert_called_once()


def test_report_on_answer_switches_to_hidden_replacement_and_undo_redraws(
    reviewer, monkeypatch
):
    operations = report_operation(monkeypatch)
    reviewer._showQuestion()
    reviewer._showAnswer()
    reviewer._clear_auto_advance_timers = MagicMock()
    report_ui.report_and_skip(reviewer)
    assert reviewer.state == "transition"
    reviewer._answerCard(3)  # A queued click cannot rate while the report is saving.
    op = operations[0]
    changes = op["op"](reviewer.mw.col)
    op["success"](changes)
    assert reviewer.state == "question"
    assert reviewer._skill_review.exercise.id == "trabajar"
    assert "oficina" in reviewer.card.question()
    assert reviewer.mw.col.get_card(reviewer.card.id).reps == 0
    reviewer._showAnswer()
    assert "trabajé" in reviewer.card.answer()
    reviewer.mw.col.undo()
    reviewer._redraw_current_card()
    assert reviewer.state == "question"
    assert reviewer._skill_review.exercise.id == "hablar"
    reviewer.mw.col.redo()
    reviewer._redraw_current_card()
    assert reviewer.state == "question"
    assert reviewer._skill_review.exercise.id == "trabajar"


def test_reporting_last_exercise_blocks_rating_and_has_native_exit(
    reviewer, monkeypatch
):
    operations = report_operation(monkeypatch)
    reviewer._clear_auto_advance_timers = MagicMock()
    reviewer._showQuestion()
    for _ in range(3):
        report_ui.report_and_skip(reviewer)
        op = operations[-1]
        op["success"](op["op"](reviewer.mw.col))
    assert reviewer._skill_error
    assert "Back to deck" in reviewer.bottom.web.eval.call_args.args[0]
    reviewer._showAnswer()
    reviewer._answerCard(3)
    assert reviewer.mw.col.get_card(reviewer.card.id).reps == 0
    assert reviewer.mw.col.db.scalar("select count(*) from revlog") == 0
    reviewer.mw.col.undo()
    reviewer._redraw_current_card()
    assert not reviewer._skill_error
    assert reviewer._skill_review.exercise.id == "comprar"


def test_report_callback_cannot_redraw_another_collection(reviewer, monkeypatch):
    operations = report_operation(monkeypatch)
    reviewer._showQuestion()
    reviewer._clear_auto_advance_timers = MagicMock()
    report_ui.report_and_skip(reviewer)
    collection = reviewer.mw.col
    reviewer.mw.col = object()
    operations[0]["success"](None)
    assert reviewer.state == "transition"
    with pytest.raises(ValueError, match="collection changed"):
        operations[0]["op"](reviewer.mw.col)
    assert collection.db.scalar("select count(*) from learnrecur_exercise_reports") == 0


def test_report_is_only_in_skill_more_menu(reviewer):
    reviewer.auto_advance_enabled = False
    reviewer.mw.flags = SimpleNamespace(all=lambda: [])
    reviewer._showQuestion()
    assert reviewer._contextMenu()[0][0] == "Report and skip…"
    reviewer.card = reviewer.mw.col.get_card(
        reviewer.mw.col.find_cards('deck:"Ordinary sample"')[0]
    )
    reviewer._skill_review = None
    assert not any(
        row and row[0] == "Report and skip…" for row in reviewer._contextMenu()
    )
