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


@pytest.mark.parametrize("status", ["reported", "retired"])
@pytest.mark.parametrize("ratings", [1, 4])
def test_legacy_usage_maps_rated_active_items_to_raw_positions(
    col, revisions, status, ratings
):
    from anki.learnrecur_skills import skill_refill_request

    original, _ = revisions
    import_snapshot(col, original)
    cid = rate(col)
    card = col.get_card(cid)
    note = card.note()
    bank = json.loads(note["LearnRecurSkill"])
    bank["exercises"][0]["status"] = status
    note["LearnRecurSkill"] = json.dumps(bank)
    col.update_note(note)
    card.load()
    fingerprint = select_skill_review(card).cursor_hash
    card.custom_data = json.dumps({"lr": {"b": fingerprint, "n": ratings}})
    col.update_card(card)
    review = select_skill_review(card)
    assert review.used == (2 if ratings == 1 else 6)
    assert review.exercise.id == ("comprar" if ratings == 1 else "trabajar")
    assert skill_refill_request(card)["remaining"] == (1 if ratings == 1 else 0)
    before = state(col)
    rate(col)
    assert json.loads(col.get_card(cid).custom_data)["lr"]["u"] == "6"
    col.undo()
    assert state(col) == before
    col.redo()
    assert json.loads(col.get_card(cid).custom_data)["lr"]["u"] == "6"


def test_automatic_append_preserves_rating_undo_redo_and_restart(col, revisions):
    original, _ = revisions
    import_snapshot(col, original)
    cid = rate(col)
    col.undo()
    before = state(col)
    status = col.undo_status()
    assert status.redo
    latest = appended(original)
    assert import_snapshot(col, latest, cache_only=True).updated == 1
    assert state(col)[1:] == before[1:]
    assert col.undo_status() == status
    col.redo()
    assert len(col.db.all("select * from revlog")) == 1
    assert (
        len(json.loads(col.get_card(cid).note()["LearnRecurSkill"])["exercises"]) == 5
    )
    col.undo()
    assert state(col)[1:] == before[1:]
    assert import_snapshot(col, latest, cache_only=True).existing == 1
    col.redo()
    saved = state(col)
    col.close()
    col.reopen()
    assert import_snapshot(col, latest, cache_only=True).existing == 1
    assert state(col) == saved


def test_automatic_append_never_creates_skills_or_changes_description(col, revisions):
    original, revised = revisions
    latest = appended(original)
    assert import_snapshot(col, latest, cache_only=True).added == 0
    assert col.card_count() == 0
    import_snapshot(col, original)
    before = state(col)
    assert import_snapshot(col, revised, cache_only=True).updated == 0
    assert state(col) == before
    import_snapshot(col, revised)
    before = state(col)
    assert import_snapshot(col, latest, cache_only=True).updated == 0
    assert state(col) == before


def test_automatic_append_defers_saved_note_edits_without_losing_undo(col, revisions):
    original, _ = revisions
    import_snapshot(col, original)
    cid = rate(col)
    note = col.get_card(cid).note()
    note.tags = ["saved-edit"]
    col.update_note(note)
    before = state(col)
    status = col.undo_status()
    with pytest.raises(Exception, match="deferred"):
        import_snapshot(col, appended(original), cache_only=True)
    assert state(col) == before and col.undo_status() == status
    col.undo()
    with pytest.raises(Exception, match="deferred"):
        import_snapshot(col, appended(original), cache_only=True)
    col.redo()
    col.close()
    col.reopen()
    assert import_snapshot(col, appended(original), cache_only=True).updated == 1
    assert col.get_card(cid).note().tags == ["saved-edit"]


def test_automatic_append_keeps_import_undo_and_refetch_after_redo(col, revisions):
    original, _ = revisions
    import_snapshot(col, original)
    assert import_snapshot(col, appended(original), cache_only=True).updated == 1
    assert col.undo_status().undo == "Import skills"
    col.undo()
    assert col.card_count() == 0
    # A background fetch must not recreate a deliberately undone import.
    assert import_snapshot(col, appended(original), cache_only=True).added == 0
    col.redo()
    card = col.get_card(col.find_cards("")[0])
    # Redo restores the original import; the published batch remains fetchable.
    assert len(json.loads(card.note()["LearnRecurSkill"])["exercises"]) == 3
    assert import_snapshot(col, appended(original), cache_only=True).updated == 1
    assert (
        len(json.loads(col.get_card(card.id).note()["LearnRecurSkill"])["exercises"])
        == 5
    )


def test_native_cache_only_rejects_description_change_and_keeps_undo(col, revisions):
    from anki.learnrecur_skill_import import FIELDS, _fields
    from anki.notes_pb2 import UpdateSkillNoteRequest

    original, revised = revisions
    import_snapshot(col, original)
    cid = rate(col)
    before = state(col)
    status = col.undo_status()
    note = col.get_card(cid).note()
    expected = note._to_backend_note()
    for field, content in zip(
        FIELDS, _fields(original["source_id"], revised["skills"][0], original["skills"])
    ):
        note[field] = content
    with pytest.raises(Exception, match="cannot revise"):
        col.add_skill_notes(
            [],
            [],
            updates=[
                UpdateSkillNoteRequest(
                    note=note._to_backend_note(), expected=expected, card_id=cid
                )
            ],
            cache_only=True,
        )
    assert state(col) == before and col.undo_status() == status
    col.undo()
    assert not col.db.all("select * from revlog")


@pytest.mark.parametrize("after_commit", [False, True])
def test_automatic_append_recovers_process_death(tmp_path, revisions, after_commit):
    import os
    import subprocess
    import sys
    from pathlib import Path

    original, _ = revisions
    path = tmp_path / "synthetic.anki2"
    col = Collection(str(path))
    import_snapshot(col, original)
    cid = rate(col)
    before = state(col)[1:]
    col.close()
    latest = appended(original)
    data = tmp_path / "snapshot.json"
    data.write_text(json.dumps(latest))
    script = """
import json, os, sys
from anki.collection import Collection
from anki.learnrecur_skill_import import import_snapshot
col = Collection(sys.argv[1])
original = col.add_skill_notes
def interrupted(*args, **kwargs):
    if sys.argv[3] == "True":
        original(*args, **kwargs)
    os._exit(71)
col.add_skill_notes = interrupted
import_snapshot(col, json.load(open(sys.argv[2])), cache_only=True)
"""
    root = Path(__file__).resolve().parents[2]
    result = subprocess.run(
        [sys.executable, "-c", script, str(path), str(data), str(after_commit)],
        env={
            **os.environ,
            "PYTHONPATH": f"{root}/pylib:{root}/out/pylib",
            "ANKI_TEST_MODE": "1",
        },
        capture_output=True,
        check=False,
    )
    assert result.returncode == 71, result.stderr.decode()
    col = Collection(str(path))
    try:
        assert import_snapshot(col, latest, cache_only=True).updated == (
            0 if after_commit else 1
        )
        assert col.card_count() == 1 and col.get_card(cid).id == cid
        assert state(col)[1:] == before
    finally:
        col.close()


def test_automatic_bank_remains_changed_for_backup_after_rating_undo(
    col, revisions, tmp_path
):
    original, _ = revisions
    import_snapshot(col, original)
    backups = tmp_path / "backups"
    backups.mkdir()
    assert col.create_backup(
        backup_folder=str(backups), force=True, wait_for_completion=True
    )
    before_backup = col.mod
    rate(col)
    import_snapshot(col, appended(original), cache_only=True)
    changed = col.mod
    col.undo()
    assert col.mod >= changed and col.mod > before_backup
    assert col.create_backup(
        backup_folder=str(backups), force=True, wait_for_completion=True
    )

    after_undo_backup = col.mod
    col.redo()
    assert col.mod > after_undo_backup
    assert col.create_backup(
        backup_folder=str(backups), force=True, wait_for_completion=True
    )
