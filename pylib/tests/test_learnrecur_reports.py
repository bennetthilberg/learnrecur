"""Reports exclude cached exercises without changing native review history."""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from anki.collection import Collection
from anki.errors import InvalidInput
from anki.learnrecur_skill_import import import_snapshot
from anki.learnrecur_skills import (
    BANK_FIELD,
    CURSOR_KEY,
    SkillReviewError,
    prepare_skill_answer,
    render_skill_review,
    report_skill_review,
    select_skill_review,
    skill_refill_request,
)
from anki.scheduler.v3 import CardAnswer
from tests.test_learnrecur_batches import appended
from tests.test_learnrecur_revisions import col, revisions
from tests.test_learnrecur_skill_import import rate, state

__all__ = ["col", "revisions", "Collection"]


def imported(col, revisions):
    import_snapshot(col, revisions[0])
    card = col.get_card(col.find_cards("")[0])
    col.decks.select(card.did)
    return card


def reports(col):
    return col.db.all("select * from learnrecur_exercise_reports order by exercise_id")


def report(col, card, reason="incorrect"):
    review = select_skill_review(card)
    changes = report_skill_review(col, review, reason)
    assert changes.note_text and not changes.study_queues and not changes.card
    return review


def test_report_replaces_both_sides_without_rating_then_native_undo(col, revisions):
    card = imported(col, revisions)
    before = state(col)
    original = report(col, card)
    assert state(col) == before
    replacement = select_skill_review(col.get_card(card.id))
    assert replacement.exercise.id == "trabajar"
    assert (replacement.position, replacement.used, replacement.cursor_hash) == (
        original.position,
        original.used,
        original.cursor_hash,
    )
    render_skill_review(card, replacement)
    assert "oficina" in card.question() and "trabajé" in card.answer()
    assert "hablé" not in card.answer()
    saved = reports(col)
    payload = json.loads(saved[0][-1])
    assert payload["reason"] == "incorrect"
    assert payload["exercise"]["answer"] == "hablé"
    assert payload["created_at_ms"] > 0
    col.undo()
    assert not reports(col)
    assert state(col) == before
    assert select_skill_review(col.get_card(card.id)) == original
    col.redo()
    assert reports(col) == saved
    assert select_skill_review(col.get_card(card.id)) == replacement
    assert state(col) == before


@pytest.mark.parametrize("fsrs", [False, True])
@pytest.mark.parametrize(
    "rating", [CardAnswer.AGAIN, CardAnswer.HARD, CardAnswer.GOOD, CardAnswer.EASY]
)
def test_rating_and_rating_undo_keep_report_excluded(col, revisions, fsrs, rating):
    card = imported(col, revisions)
    col.set_config("fsrs", fsrs)
    report(col, card)
    before = state(col)
    queued = col.sched.get_queued_cards().cards[0]
    card = col.get_card(card.id)
    card.start_timer()
    queued.states.current.custom_data = card.custom_data
    review = select_skill_review(card)
    answer = col.sched.build_answer(card=card, states=queued.states, rating=rating)
    prepare_skill_answer(col, answer, review)
    col.sched.answer_card(answer)
    assert select_skill_review(col.get_card(card.id)).exercise.id == "comprar"
    saved = reports(col)
    col.undo()
    assert state(col) == before and reports(col) == saved
    assert select_skill_review(col.get_card(card.id)) == review
    col.redo()
    assert reports(col) == saved
    assert col.get_card(card.id).reps == 1


def test_all_reported_stays_unrated_and_restart_keeps_exclusions(col, revisions):
    card = imported(col, revisions)
    before = state(col)
    for exercise_id in ("hablar", "trabajar", "comprar"):
        assert select_skill_review(card).exercise.id == exercise_id
        report(col, card)
    with pytest.raises(SkillReviewError, match="no available exercises"):
        select_skill_review(card)
    assert state(col) == before
    saved = reports(col)
    col.close()
    col.reopen()
    assert state(col) == before and reports(col) == saved
    with pytest.raises(SkillReviewError, match="no available exercises"):
        select_skill_review(col.get_card(card.id))


def test_append_cannot_resurrect_report_and_keeps_report_undo(col, revisions):
    card = imported(col, revisions)
    report(col, card)
    before = state(col)
    latest = appended(revisions[0])
    assert import_snapshot(col, latest, cache_only=True).updated == 1
    assert state(col)[1:] == before[1:]
    assert select_skill_review(col.get_card(card.id)).exercise.id == "trabajar"
    col.undo()  # A cache append must not replace the report's undo entry.
    assert select_skill_review(col.get_card(card.id)).exercise.id == "hablar"
    col.redo()
    assert select_skill_review(col.get_card(card.id)).exercise.id == "trabajar"
    rate(col)
    rate(col)
    assert select_skill_review(col.get_card(card.id)).exercise.id == "generated-cantar"
    assert import_snapshot(col, revisions[0]).existing == 1
    assert len(reports(col)) == 1


def test_reports_are_scoped_to_revision(col, revisions):
    card = imported(col, revisions)
    report(col, card)
    revised = revisions[1]
    revised["skills"][0]["bank"]["exercises"][0]["id"] = "hablar"
    import_snapshot(col, revised)
    assert select_skill_review(col.get_card(card.id)).exercise.id == "hablar"
    col.undo()
    assert select_skill_review(col.get_card(card.id)).exercise.id == "trabajar"
    col.redo()
    assert select_skill_review(col.get_card(card.id)).exercise.id == "hablar"


def test_fallback_reuses_only_eligible_exercises(col, revisions):
    card = imported(col, revisions)
    review = select_skill_review(card)
    card.custom_data = json.dumps(
        {CURSOR_KEY: {"b": review.cursor_hash, "n": 3, "u": "7"}}
    )
    col.update_card(card)
    report(col, card)
    assert select_skill_review(card).exercise.id in ("trabajar", "comprar")
    report(col, card)
    final = select_skill_review(card)
    assert final.exercise.id in ("trabajar", "comprar")
    assert final.exercise.id not in {row[3] for row in reports(col)}
    assert final.used == 7 and final.position == 3


def test_legacy_usage_is_inferred_before_excluding_report(col, revisions):
    card = imported(col, revisions)
    original = select_skill_review(card)
    card.custom_data = json.dumps({CURSOR_KEY: {"b": original.cursor_hash, "n": 1}})
    col.update_card(card)
    assert report(col, card).exercise.id == "trabajar"
    replacement = select_skill_review(card)
    assert replacement.exercise.id == "comprar" and replacement.used == 1


def test_stale_report_and_answer_cannot_apply_to_replacement(col, revisions):
    card = imported(col, revisions)
    review = report(col, card)
    before = state(col), reports(col)
    with pytest.raises(SkillReviewError, match="changed"):
        report_skill_review(col, review, "incorrect")
    with pytest.raises(SkillReviewError, match="changed"):
        render_skill_review(card, review)
    queued = col.sched.get_queued_cards().cards[0]
    card.start_timer()
    answer = col.sched.build_answer(
        card=card, states=queued.states, rating=CardAnswer.GOOD
    )
    with pytest.raises(SkillReviewError, match="changed"):
        prepare_skill_answer(col, answer, review)
    assert (state(col), reports(col)) == before


@pytest.mark.parametrize("damage", ["bank", "id", "reason", "retired"])
def test_native_rejects_changed_or_invalid_request_without_writes(
    col, revisions, damage
):
    card = imported(col, revisions)
    bank = card.note()[BANK_FIELD]
    kwargs = dict(
        card_id=card.id, expected_bank=bank, exercise_id="hablar", reason="incorrect"
    )
    if damage == "bank":
        kwargs["expected_bank"] = "{}"
    elif damage == "id":
        kwargs["exercise_id"] = "missing"
    elif damage == "reason":
        kwargs["reason"] = "not-a-reason"
    else:
        note = card.note()
        raw = json.loads(bank)
        raw["exercises"][0]["status"] = "retired"
        note[BANK_FIELD] = kwargs["expected_bank"] = json.dumps(raw)
        col.update_note(note)
    before = state(col)
    with pytest.raises(InvalidInput):
        col._backend.report_skill_exercise(**kwargs)
    assert state(col) == before and not reports(col)


def test_remaining_count_excludes_reports(col, revisions):
    card = imported(col, revisions)
    assert skill_refill_request(card) is None
    report(col, card)
    assert skill_refill_request(card)["remaining"] == 2
    report(col, card)
    report(col, card)
    assert skill_refill_request(card)["remaining"] == 0


@pytest.mark.parametrize("after_commit", [False, True])
def test_process_exit_during_report_is_atomic(col, revisions, after_commit):
    card = imported(col, revisions)
    before = state(col)
    path = col.path
    col.close()
    root = Path(__file__).resolve().parents[2]
    script = """
import os, sys
from anki.collection import Collection
from anki.learnrecur_skills import report_skill_review, select_skill_review
col = Collection(sys.argv[1])
card = col.get_card(int(sys.argv[2]))
if sys.argv[3] == 'True':
    report_skill_review(col, select_skill_review(card), 'incorrect')
os._exit(71)
"""
    try:
        result = subprocess.run(
            [sys.executable, "-c", script, path, str(card.id), str(after_commit)],
            env={
                **os.environ,
                "PYTHONPATH": f"{root}/pylib:{root}/out/pylib",
                "ANKI_TEST_MODE": "1",
            },
            capture_output=True,
            check=False,
        )
        assert result.returncode == 71, result.stderr.decode()
    finally:
        col.reopen()
    assert state(col) == before
    assert len(reports(col)) == int(after_commit)
    assert select_skill_review(col.get_card(card.id)).exercise.id == (
        "trabajar" if after_commit else "hablar"
    )


def test_complete_collection_backup_restores_reports(col, revisions, tmp_path):
    card = imported(col, revisions)
    report(col, card)
    saved = reports(col)
    package = tmp_path / "synthetic.colpkg"
    target = tmp_path / "restored.anki2"
    col.export_collection_package(str(package), include_media=True, legacy=False)
    try:
        col._backend.import_collection_package(
            col_path=str(target),
            backup_path=str(package),
            media_folder=str(tmp_path / "restored.media"),
            media_db=str(tmp_path / "restored.media.db2"),
        )
    finally:
        col.reopen()
    restored = Collection(str(target))
    try:
        assert reports(restored) == saved
        assert select_skill_review(restored.get_card(card.id)).exercise.id == "trabajar"
        assert restored.db.scalar("select count(*) from revlog") == 0
    finally:
        restored.close()


def test_ordinary_card_cannot_be_reported(col, revisions):
    imported(col, revisions)
    note = col.new_note(col.models.by_name("Basic"))
    note["Front"] = "Synthetic fact"
    note["Back"] = "Synthetic answer"
    col.add_note(note, 1)
    card = note.cards()[0]
    before = state(col)
    assert select_skill_review(card) is None
    with pytest.raises(InvalidInput, match="not a skill card"):
        col._backend.report_skill_exercise(
            card_id=card.id,
            expected_bank="{}",
            exercise_id="hablar",
            reason="incorrect",
        )
    assert state(col) == before and not reports(col)
