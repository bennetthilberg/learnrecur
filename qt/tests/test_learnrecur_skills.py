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
from aqt.operations import scheduling
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
