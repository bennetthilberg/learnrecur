"""Revealing a fill-in-the-blank skill shows each fill in its blank."""

import copy
import json

import pytest

from anki.learnrecur_reports import pending_reports
from anki.learnrecur_skill_import import SkillImportError, import_snapshot
from anki.learnrecur_skills import (
    Exercise,
    exercise_html,
    render_skill_review,
    report_skill_review,
    select_skill_review,
)
from tests.test_learnrecur_batches import appended
from tests.test_learnrecur_revisions import col, revisions
from tests.test_learnrecur_skill_import import rate, state

__all__ = ["col", "revisions"]

ONE = {
    "instruction": "Complete with the preterite.",
    "prompt": "Ayer yo ______ con Ana. (hablar)",
    "context": "A finished action.",
    "answer": "hablé",
    "explanation": "For yo, replace -ar with -é.",
    "blanks": ["hablé"],
}
TWO = {
    "prompt": "Ayer yo ______ y luego ______ la cena. (trabajar, preparar)",
    "answer": "trabajé, preparé",
    "explanation": "Both verbs take -é for yo.",
    "blanks": ["trabajé", "preparé"],
}


def first(snapshot, **fields):
    exercise = snapshot["skills"][0]["bank"]["exercises"][0]
    exercise.update(fields)
    return exercise


def rendered(col):
    card = col.get_card(col.db.scalar("select id from cards"))
    review = select_skill_review(card)
    render_skill_review(card, review)
    output = card.render_output()
    return review, output.question_text, output.answer_text


@pytest.mark.parametrize("fields", [ONE, TWO], ids=["one", "two"])
def test_answer_shows_fills_in_their_blanks(col, revisions, fields):
    original, _ = revisions
    first(original, **fields)
    import_snapshot(col, original)
    before = state(col)
    review, question, answer = rendered(col)
    assert review.exercise.blanks == tuple(fields["blanks"])
    # The question side is unchanged: blanks stay empty.
    assert "lr-fill" not in question
    assert question.count("______") == len(fields["blanks"])
    assert "lr-answer" not in answer and "______" not in answer
    assert answer.count('class="lr-fill"') == len(fields["blanks"])
    if fields is ONE:
        assert (
            '<div class="lr-prompt">Ayer yo <strong class="lr-fill">hablé</strong>'
            " con Ana. (hablar)</div>"
        ) in answer
        assert (
            answer.index('class="lr-instruction"')
            < answer.index('class="lr-prompt"')
            < answer.index('class="lr-context"')
            < answer.index('id="answer"')
            < answer.index('class="lr-explanation"')
        )
    else:
        assert (
            'Ayer yo <strong class="lr-fill">trabajé</strong> y luego '
            '<strong class="lr-fill">preparé</strong> la cena.'
        ) in answer
    assert '<div class="lr-explanation">' in answer
    # Browse and plain Anki templates keep the complete answer.
    assert col.get_card(review.card_id).note()["Answer"] == fields["answer"]
    assert state(col) == before


def test_fill_can_complete_part_of_a_word():
    question, answer = exercise_html(
        Exercise("id", "Yo habl______ ayer.", "hablé", "Add -é.", 0, blanks=("é",))
    )
    assert "habl______ ayer." in question
    assert 'habl<strong class="lr-fill">é</strong> ayer.' in answer


def test_exercises_without_blanks_render_exactly_as_before(col, revisions):
    original, _ = revisions
    import_snapshot(col, original)
    review, question, answer = rendered(col)
    assert review.exercise.blanks == ()
    assert question == '<div class="lr-prompt">Ayer yo ___ con Ana. (hablar)</div>'
    assert answer == (
        question + '<hr id="answer"><strong class="lr-answer">hablé</strong>'
        '<div class="lr-explanation">For yo in the preterite, replace -ar with -é:'
        " hablar → hablé.</div>"
    )


@pytest.mark.parametrize(
    "blanks",
    [
        [],
        ["trabajé"],
        ["trabajé", "preparé", "extra"],
        ["trabajé", ""],
        ["trabajé", "  "],
        ["trabajé", "line\nbreak"],
        ["trabajé", "tab\there"],
        ["trabajé", "é" * 257],
        ["trabajé", 3],
        ["trabajé", None],
        "trabajé, preparé",
        {"0": "trabajé"},
        None,
    ],
)
def test_mismatched_blanks_stop_import(col, revisions, blanks):
    original, _ = revisions
    import_snapshot(col, original)
    before = state(col)
    changed = copy.deepcopy(original)
    first(changed, **{**TWO, "blanks": blanks})
    with pytest.raises(SkillImportError):
        import_snapshot(col, changed)
    refill = appended(original)
    batch = refill["bank_updates"][original["skills"][0]["id"]][0]
    batch["exercises"][0].update({**TWO, "blanks": blanks})
    with pytest.raises(SkillImportError):
        import_snapshot(col, refill)
    assert state(col) == before


def test_too_many_blanks_stop_import(col, revisions):
    original, _ = revisions
    first(
        original,
        prompt=" ".join(["______"] * 17),
        answer="a",
        blanks=["a"] * 17,
    )
    with pytest.raises(SkillImportError):
        import_snapshot(col, original)
    assert col.card_count() == 0


def test_a_bank_with_mismatched_blanks_falls_back_to_the_answer_below(col, revisions):
    # Synced banks skip import validation, so review must not fill some blanks
    # and leave others empty.
    original, _ = revisions
    first(original, **TWO)
    import_snapshot(col, original)
    note = col.get_card(col.db.scalar("select id from cards")).note()
    bank = json.loads(note["LearnRecurSkill"])
    bank["exercises"][0]["blanks"] = ["trabajé"]
    note["LearnRecurSkill"] = json.dumps(bank)
    col.update_note(note)
    review, _, answer = rendered(col)
    assert review.exercise.blanks == ()
    assert "lr-fill" not in answer
    assert answer.count("______") == 2
    assert '<strong class="lr-answer">trabajé, preparé</strong>' in answer


def test_fills_are_plain_text(col, revisions):
    original, _ = revisions
    first(
        original,
        prompt="<i>Yo</i> ______ y ______.",
        answer="answer",
        blanks=["<img src=x onerror=alert(1)>", "[sound:private.mp3] & [type:Answer]"],
    )
    import_snapshot(col, original)
    _, _, answer = rendered(col)
    assert "<img" not in answer and "<i>" not in answer
    assert (
        '&lt;i&gt;Yo&lt;/i&gt; <strong class="lr-fill">'
        "&lt;img src=x onerror=alert(1)&gt;</strong> y "
        '<strong class="lr-fill">&#91;sound:private.mp3] &amp; &#91;type:Answer]'
        "</strong>."
    ) in answer


def test_fills_survive_refill_rating_report_undo_and_restart(col, revisions):
    original, _ = revisions
    first(original, **ONE)
    import_snapshot(col, original)
    cid = col.db.scalar("select id from cards")
    refill = appended(original)
    batch = refill["bank_updates"][original["skills"][0]["id"]][0]
    batch["exercises"][0].update(TWO)
    import_snapshot(col, refill)
    pinned = select_skill_review(col.get_card(cid))
    assert pinned.exercise.blanks == ("hablé",)
    rate(col)
    after_rating = state(col)
    review = select_skill_review(col.get_card(cid))
    assert review.exercise.id == "trabajar"
    col.undo()
    assert select_skill_review(col.get_card(cid)) == pinned
    col.redo()
    assert state(col) == after_rating
    rate(col)
    rate(col)
    refilled = select_skill_review(col.get_card(cid))
    assert refilled.exercise.id == "generated-cantar"
    assert refilled.exercise.blanks == ("trabajé", "preparé")
    # Report-and-skip delivers the complete exercise, fills included.
    report_skill_review(col, refilled, "unclear")
    sent = pending_reports(col, original["source_id"])[0]
    assert sent["exercise"] == batch["exercises"][0]
    assert select_skill_review(col.get_card(cid)).exercise.id == "generated-bailar"
    col.undo()
    assert select_skill_review(col.get_card(cid)) == refilled
    col.close()
    col.reopen()
    assert select_skill_review(col.get_card(cid)) == refilled
    _, _, answer = rendered(col)
    assert '<strong class="lr-fill">preparé</strong>' in answer
