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


def test_wrapped_bank_prefers_new_batch_and_undo_restores_usage(col, revisions):
    from anki.learnrecur_skills import skill_refill_request

    original, _ = revisions
    import_snapshot(col, original)
    for _ in range(5):
        cid = rate(col)
    before = select_skill_review(col.get_card(cid))
    assert before.position == 5
    assert skill_refill_request(col.get_card(cid))["remaining"] == 0
    import_snapshot(col, appended(original))
    fresh = select_skill_review(col.get_card(cid))
    assert fresh.exercise.id == "generated-cantar"
    assert fresh.used == before.used == 7
    assert skill_refill_request(col.get_card(cid))["remaining"] == 2
    rate(col)
    assert skill_refill_request(col.get_card(cid))["remaining"] == 1
    col.undo()
    assert select_skill_review(col.get_card(cid)) == fresh
    col.redo()
    assert select_skill_review(col.get_card(cid)).exercise.id == "generated-bailar"
    col.close()
    col.reopen()
    assert skill_refill_request(col.get_card(cid))["remaining"] == 1


def test_legacy_counter_is_conservative_and_upgrade_uses_native_answer(col, revisions):
    from anki.learnrecur_skills import skill_refill_request

    original, _ = revisions
    import_snapshot(col, appended(original))
    cid = rate(col)
    card = col.get_card(cid)
    data = json.loads(card.custom_data)
    del data["lr"]["u"]
    data["lr"]["n"] = 8
    card.custom_data = json.dumps(data)
    col.update_card(card)
    assert skill_refill_request(card)["remaining"] == 0
    before = state(col)
    rate(col)
    assert "u" in json.loads(col.get_card(cid).custom_data)["lr"]
    col.undo()
    assert state(col) == before


def test_untrusted_package_link_cannot_request_generation(col, revisions):
    from anki.learnrecur_skills import skill_refill_request

    original, _ = revisions
    import_snapshot(col, original)
    cid = rate(col)
    assert skill_refill_request(col.get_card(cid))["remaining"] == 2
    col.db.execute("delete from learnrecur_skill_identities")
    assert select_skill_review(col.get_card(cid)) is not None
    assert skill_refill_request(col.get_card(cid)) is None
