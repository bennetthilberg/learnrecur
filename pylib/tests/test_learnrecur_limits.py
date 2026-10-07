"""Larger banks retain native rating, report, and undo behavior."""

import base64
import copy
import json

import pytest

from anki.learnrecur_limits import MAX_EXERCISES
from anki.learnrecur_skill_import import DECK_NAME, SkillImportError, import_snapshot
from anki.learnrecur_skills import (
    SkillReviewError,
    prepare_skill_answer,
    report_skill_review,
    select_skill_review,
)
from anki.scheduler.v3 import CardAnswer
from tests.test_learnrecur_skill_import import col, snapshot
from tests.test_learnrecur_skills import next_answer as native_next_answer
from tests.test_learnrecur_skills import snapshot as card_state

__all__ = ["col", "snapshot"]


def next_answer(col, rating):
    col.decks.select(col.decks.id(DECK_NAME))
    return native_next_answer(col, rating)


def bank(size):
    return [
        {
            "id": f"exercise-{index}",
            "prompt": f"What is {index} + 1?",
            "answer": str(index + 1),
            "explanation": "Add one.",
        }
        for index in range(size)
    ]


def usage(value):
    raw = value.to_bytes((value.bit_length() + 7) // 8, "little")
    return "~" + base64.urlsafe_b64encode(raw).decode().rstrip("=")


@pytest.mark.parametrize("size", [200, MAX_EXERCISES])
def test_full_large_bank_rating_undo_redo_and_restart(col, snapshot, size):
    snapshot["skills"][0]["bank"]["exercises"] = bank(size)
    import_snapshot(col, snapshot)
    card = col.get_card(col.find_cards("")[0])
    review = select_skill_review(card)
    card.custom_data = json.dumps(
        {
            "lr": {
                "b": review.cursor_hash,
                "n": 1_000_000_000,
                "u": usage((1 << (size - 1)) - 1),
            }
        },
        separators=(",", ":"),
    )
    col.update_card(card)
    card, answer = next_answer(col, CardAnswer.AGAIN)
    review = select_skill_review(card)
    assert review.exercise.ordinal == size - 1
    before = card_state(col, card.id)
    prepare_skill_answer(col, answer, review)
    assert len(answer.new_state.custom_data.encode()) <= 100
    col.sched.answer_card(answer)
    after = card_state(col, card.id)
    assert select_skill_review(col.get_card(card.id)).used == (1 << size) - 1
    col.undo()
    assert card_state(col, card.id) == before
    col.redo()
    assert card_state(col, card.id) == after
    col.close()
    col.reopen()
    assert card_state(col, card.id) == after
    assert select_skill_review(col.get_card(card.id)).used == (1 << size) - 1


def test_legacy_hex_cursor_crosses_100_exercises_in_the_rating_transaction(
    col, snapshot
):
    snapshot["skills"][0]["bank"]["exercises"] = bank(200)
    import_snapshot(col, snapshot)
    card = col.get_card(col.find_cards("")[0])
    review = select_skill_review(card)
    card.custom_data = json.dumps(
        {
            "lr": {
                "b": review.cursor_hash,
                "n": 100,
                "u": format((1 << 100) - 1, "x"),
            }
        }
    )
    col.update_card(card)
    card, answer = next_answer(col, CardAnswer.AGAIN)
    before = card_state(col, card.id)
    review = select_skill_review(card)
    assert review.exercise.ordinal == 100
    prepare_skill_answer(col, answer, review)
    col.sched.answer_card(answer)
    saved = col.get_card(card.id)
    assert json.loads(saved.custom_data)["lr"]["u"] == usage((1 << 101) - 1)
    assert select_skill_review(saved).exercise.ordinal == 101
    col.undo()
    assert card_state(col, card.id) == before


def test_report_above_100_uses_a_backup_without_rating_and_can_be_undone(col, snapshot):
    snapshot["skills"][0]["bank"]["exercises"] = bank(200)
    import_snapshot(col, snapshot)
    card = col.get_card(col.find_cards("")[0])
    review = select_skill_review(card)
    card.custom_data = json.dumps(
        {
            "lr": {
                "b": review.cursor_hash,
                "n": 150,
                "u": usage((1 << 150) - 1),
            }
        }
    )
    col.update_card(card)
    before = card_state(col, card.id)
    review = select_skill_review(col.get_card(card.id))
    assert review.exercise.ordinal == 150
    report_skill_review(col, review, "incorrect")
    assert card_state(col, card.id) == before
    assert select_skill_review(col.get_card(card.id)).exercise.ordinal == 151
    col.undo()
    assert select_skill_review(col.get_card(card.id)) == review
    col.redo()
    assert select_skill_review(col.get_card(card.id)).exercise.ordinal == 151


@pytest.mark.parametrize("value", ["~", "~A", "~A!", "~" + "A" * 44, "~AA"])
def test_bad_compact_usage_never_changes_the_schedule(col, snapshot, value):
    import_snapshot(col, snapshot)
    card = col.get_card(col.find_cards("")[0])
    review = select_skill_review(card)
    card.custom_data = json.dumps({"lr": {"b": review.cursor_hash, "n": 1, "u": value}})
    col.update_card(card)
    before = card_state(col, card.id)
    with pytest.raises(SkillReviewError, match="invalid review data"):
        select_skill_review(col.get_card(card.id))
    assert card_state(col, card.id) == before


def test_format_ceiling_rejects_an_oversized_bank_without_creating_cards(col, snapshot):
    snapshot["skills"][0]["bank"]["exercises"] = bank(MAX_EXERCISES + 1)
    with pytest.raises(SkillImportError, match="cached exercises"):
        import_snapshot(col, snapshot)
    assert col.card_count() == 0


def test_native_import_accepts_more_than_100_skills(col, snapshot):
    original = snapshot["skills"][0]
    snapshot["skills"] = []
    snapshot["identities"] = {}
    for index in range(110):
        skill = copy.deepcopy(original)
        key = skill["id"] = skill["bank"]["skill_id"] = f"synthetic-{index}"
        snapshot["skills"].append(skill)
        snapshot["identities"][key] = {
            "native_id": 1800000000000 + index,
            "guid": f"{index:032x}",
        }
    assert import_snapshot(col, snapshot).added == 110
    assert col.card_count() == 110
    assert import_snapshot(col, snapshot).existing == 110
    col.undo()
    assert col.card_count() == 0
