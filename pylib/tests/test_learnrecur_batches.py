"""Appending cached exercises keeps the native card and its review progress."""

import copy
import json

import pytest

from anki.collection import Collection
from anki.learnrecur_skill_import import SkillImportError, import_snapshot
from anki.learnrecur_skills import (
    SkillReviewError,
    select_skill_review,
    validate_skill_review,
)
from tests.test_learnrecur_revisions import col, revisions
from tests.test_learnrecur_skill_import import rate, state

__all__ = ["col", "revisions", "Collection"]


def appended(snapshot):
    result = copy.deepcopy(snapshot)
    key = result["skills"][0]["id"]
    result["bank_updates"] = {
        key: [
            {
                "job_id": "a" * 32,
                "revision": 1,
                "sequence": 1,
                "exercises": [
                    {
                        "id": "generated-cantar",
                        "prompt": "Anoche yo ___ una canción. (cantar)",
                        "answer": "canté",
                        "explanation": "Replace -ar with -é: cantar → canté.",
                    },
                    {
                        "id": "generated-bailar",
                        "prompt": "Ayer yo ___ con Luis. (bailar)",
                        "answer": "bailé",
                        "explanation": "Replace -ar with -é: bailar → bailé.",
                    },
                ],
            }
        ]
    }
    return result


def test_append_keeps_card_cursor_history_and_native_undo(col, revisions):
    original, _ = revisions
    import_snapshot(col, original)
    cid = rate(col)
    before = state(col)
    pinned = select_skill_review(col.get_card(cid))
    latest = appended(original)
    assert import_snapshot(col, latest).updated == 1
    assert state(col)[1:] == before[1:]
    current = select_skill_review(col.get_card(cid))
    assert current.exercise.id == "trabajar" and current.position == pinned.position
    assert current.cursor_hash == pinned.cursor_hash
    with pytest.raises(SkillReviewError, match="changed"):
        validate_skill_review(col.get_card(cid), pinned)
    after = state(col)
    assert import_snapshot(col, latest).existing == 1
    assert import_snapshot(col, original).existing == 1
    assert state(col) == after
    col.undo()
    assert state(col) == before
    col.redo()
    assert state(col) == after
    rate(col)
    assert select_skill_review(col.get_card(cid)).exercise.id == "comprar"
    rate(col)
    assert select_skill_review(col.get_card(cid)).exercise.id == "generated-cantar"
    rate(col)
    assert select_skill_review(col.get_card(cid)).exercise.id == "generated-bailar"
    col.undo()
    assert select_skill_review(col.get_card(cid)).exercise.id == "generated-cantar"
    col.redo()
    final = state(col)
    col.close()
    col.reopen()
    assert import_snapshot(col, latest).existing == 1
    assert state(col) == final


def test_description_revision_archives_batches_and_stale_snapshot_cannot_revert(
    col, revisions
):
    original, revised = revisions
    latest = appended(original)
    import_snapshot(col, latest)
    cid = rate(col)
    revised["bank_updates"] = latest["bank_updates"]
    assert import_snapshot(col, revised).updated == 1
    assert select_skill_review(col.get_card(cid)).exercise.id == "cantar"
    current = state(col)
    assert import_snapshot(col, latest).existing == 1
    assert state(col) == current
    raw = json.loads(col.get_card(cid).note()["LearnRecurSkill"])
    assert raw["bank_updates"] == latest["bank_updates"][original["skills"][0]["id"]]
    assert "generated-cantar" not in [e["id"] for e in raw["exercises"]]


@pytest.mark.parametrize(
    "damage", ["sequence", "revision", "duplicate", "history", "local"]
)
def test_invalid_batch_never_changes_collection(col, revisions, damage):
    original, _ = revisions
    latest = appended(original)
    import_snapshot(col, latest)
    cid = rate(col)
    candidate = copy.deepcopy(latest)
    batch = candidate["bank_updates"][original["skills"][0]["id"]][0]
    if damage == "sequence":
        batch["sequence"] = 2
    if damage == "revision":
        batch["revision"] = 2
    if damage == "duplicate":
        batch["exercises"][0]["id"] = "hablar"
    if damage == "history":
        batch["exercises"][0]["answer"] = "changed"
    if damage == "local":
        note = col.get_card(cid).note()
        note["Answer"] = "local edit"
        col.update_note(note)
    before = state(col)
    with pytest.raises(SkillImportError):
        import_snapshot(col, candidate)
    assert state(col) == before
