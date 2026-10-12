"""Structured presentation keeps native history, undo, cache cursors, and exports."""

import json

import pytest

from anki.learnrecur_skill_import import SkillImportError, import_snapshot
from anki.learnrecur_skills import (
    SkillReviewError,
    render_skill_review,
    select_skill_review,
)
from tests.test_learnrecur_batches import appended
from tests.test_learnrecur_restore import restore
from tests.test_learnrecur_revisions import col, revisions
from tests.test_learnrecur_skill_import import rate, state

__all__ = ["col", "revisions"]


def structured(snapshot):
    skill = snapshot["skills"][0]
    skill["formatting_preferences"] = "Put the intended meaning below the exercise."
    first = skill["bank"]["exercises"][0]
    first.update(
        instruction="Choose por or para.",
        prompt="El sábado salimos ______ Madrid.",
        context="Intended meaning: Madrid is our destination.",
        answer="para",
        explanation="Para marks a destination.",
    )
    return snapshot


@pytest.mark.parametrize("legacy", [False, True])
def test_native_render_refill_cursor_undo_restart_and_collection_restore(
    col, revisions, tmp_path, legacy
):
    original, _ = revisions
    structured(original)
    import_snapshot(col, original)
    cid = col.db.scalar("select id from cards")
    card = col.get_card(cid)
    before = state(col)
    review = select_skill_review(card)
    render_skill_review(card, review)
    question, answer = card.question(), card.answer()
    assert (
        question.index('class="lr-instruction"')
        < question.index('class="lr-prompt"')
        < question.index('class="lr-context"')
    )
    assert '<strong class="lr-answer">para</strong>' in answer
    assert '<div class="lr-explanation">Para marks a destination.</div>' in answer
    assert "Intended meaning" in card.note()["Prompt"]
    assert state(col) == before
    # Matching selectors in the normal note-type CSS can override the defaults.
    model = card.note_type()
    model["css"] += "\n.lr-context { color: #ccc; font-size: 1em; }"
    col.models.update_dict(model)
    card = col.get_card(cid)
    render_skill_review(card, select_skill_review(card))
    assert card._render_output.css.endswith(
        ".lr-context { color: #ccc; font-size: 1em; }"
    )
    rate(col)
    pinned = select_skill_review(col.get_card(cid))
    rated = state(col)
    import_snapshot(col, appended(original))
    current = select_skill_review(col.get_card(cid))
    assert current.cursor_hash == pinned.cursor_hash
    assert (current.position, current.used, current.exercise) == (
        pinned.position,
        pinned.used,
        pinned.exercise,
    )
    assert state(col)[1:] == rated[1:]
    col.undo()
    assert state(col) == rated
    col.redo()
    expanded = state(col)
    col.close()
    col.reopen()
    assert state(col) == expanded
    restored = restore(col, tmp_path, legacy=legacy)
    try:
        assert state(restored) == expanded
        assert select_skill_review(restored.get_card(cid)) == current
        bank = json.loads(restored.get_card(cid).note()["LearnRecurSkill"])
        assert (
            bank["definition"]["formatting_preferences"]
            == original["skills"][0]["formatting_preferences"]
        )
        assert bank["exercises"][0]["context"] == review.exercise.context
    finally:
        restored.close()


def test_generated_markup_and_native_instructions_stay_plain_text(col, revisions):
    original, _ = revisions
    structured(original)
    first = original["skills"][0]["bank"]["exercises"][0]
    first.update(
        instruction="<script>no()</script>",
        prompt="[type:Answer] <img src=x>\nNew line.",
        context="[sound:private.mp3] & context",
        answer="<b>answer</b>",
    )
    import_snapshot(col, original)
    card = col.get_card(col.db.scalar("select id from cards"))
    render_skill_review(card, select_skill_review(card))
    question = card.question()
    assert "<script>" not in question and "<img " not in question
    assert "&#91;type:Answer]" in question and "&#91;sound:" in question
    assert "<br>New line." in question
    assert (
        '<strong class="lr-answer">&lt;b&gt;answer&lt;/b&gt;</strong>' in card.answer()
    )


def test_legacy_cached_content_renders_without_rewriting_the_bank(col, revisions):
    original, _ = revisions
    import_snapshot(col, original)
    card = col.get_card(col.db.scalar("select id from cards"))
    before = state(col)
    review = select_skill_review(card)
    assert review.exercise.instruction == review.exercise.context == ""
    render_skill_review(card, review)
    assert (
        'class="lr-instruction"' not in card.question()
        and 'class="lr-context"' not in card.question()
    )
    assert '<strong class="lr-answer">hablé</strong>' in card.answer()
    assert state(col) == before


@pytest.mark.parametrize("key", ["instruction", "context"])
def test_invalid_optional_fields_do_not_import_or_render(col, revisions, key):
    original, _ = revisions
    structured(original)
    import_snapshot(col, original)
    before = state(col)
    original["skills"][0]["bank"]["exercises"][0][key] = None
    with pytest.raises(SkillImportError):
        import_snapshot(col, original)
    assert state(col) == before
    card = col.get_card(col.db.scalar("select id from cards"))
    note = card.note()
    bank = json.loads(note["LearnRecurSkill"])
    bank["exercises"][0][key] = None
    note["LearnRecurSkill"] = json.dumps(bank)
    col.update_note(note)
    with pytest.raises(SkillReviewError, match="invalid exercise bank"):
        select_skill_review(col.get_card(card.id))
