"""Revise cached skills without replacing cards or their review history."""

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from anki.collection import Collection
from anki.learnrecur_skill_import import SkillImportError, import_snapshot
from anki.learnrecur_skills import (
    SkillReviewError,
    select_skill_review,
    validate_skill_review,
)
from tests.test_learnrecur_skill_import import rate, state

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def revisions():
    original = {
        "source_id": "5528c1f8-2792-4e70-8a47-75d48c397e02",
        **json.loads((ROOT / "learnrecur/fixtures/spanish-import.json").read_text()),
    }
    key = original["skills"][0]["id"]
    original["identities"] = {key: {"native_id": 1800000000000, "guid": "a" * 32}}
    revised = copy.deepcopy(original)
    revised["skills"] = json.loads(
        (ROOT / "learnrecur/fixtures/spanish-revision.json").read_text()
    )["skills"]
    revised["previous_revisions"] = {key: copy.deepcopy(original["skills"])}
    return original, revised


@pytest.fixture
def col(tmp_path):
    col = Collection(str(tmp_path / "collection.anki2"))
    yield col
    col.close()


def test_revision_preserves_card_history_retry_undo_and_restart(col, revisions):
    original, revised = revisions
    import_snapshot(col, original)
    cid = rate(col)
    before = state(col)
    stale_review = select_skill_review(col.get_card(cid))
    result = import_snapshot(col, revised)
    assert (result.added, result.updated, result.existing) == (0, 1, 0)
    assert state(col)[1:] == before[1:]
    assert col.card_count() == col.note_count() == 1
    assert select_skill_review(col.get_card(cid)).exercise.id == "cantar"
    bank = json.loads(col.get_card(cid).note()["LearnRecurSkill"])
    assert bank["retired_revisions"] == original["skills"]
    with pytest.raises(SkillReviewError, match="changed"):
        validate_skill_review(col.get_card(cid), stale_review)
    after = state(col)
    assert import_snapshot(col, revised).existing == 1
    assert import_snapshot(col, original).existing == 1
    assert state(col) == after
    col.undo()
    assert select_skill_review(col.get_card(cid)).exercise.id == "trabajar"
    assert state(col)[1:] == before[1:]
    col.redo()
    assert select_skill_review(col.get_card(cid)).exercise.id == "cantar"
    rate(col)
    assert select_skill_review(col.get_card(cid)).exercise.id == "bailar"
    col.undo()
    assert select_skill_review(col.get_card(cid)).exercise.id == "cantar"
    col.redo()
    after = state(col)
    col.close()
    col.reopen()
    assert import_snapshot(col, revised).existing == 1
    assert state(col) == after


def test_first_import_can_start_at_latest_revision(col, revisions):
    _, revised = revisions
    assert import_snapshot(col, revised).added == 1
    cid = col.find_cards("")[0]
    assert select_skill_review(col.get_card(cid)).exercise.id == "cantar"
    assert import_snapshot(col, revised).existing == 1


def test_revision_preserves_renamed_note_type_and_moved_deck(col, revisions):
    original, revised = revisions
    import_snapshot(col, original)
    cid = rate(col)
    model = col.get_card(cid).note_type()
    model["name"] = "Renamed skill"
    model["css"] += "\n.card { color: blue; }"
    col.models.update_dict(model)
    col.set_deck([cid], col.decks.id("Moved skill"))
    before = state(col)
    assert import_snapshot(col, revised).updated == 1
    assert state(col)[1:] == before[1:]
    assert col.get_card(cid).note_type()["css"] == model["css"]


def test_mixed_new_skill_and_revision_share_one_native_undo_entry(col, revisions):
    original, revised = revisions
    import_snapshot(col, original)
    cid = rate(col)
    before = state(col)
    other = copy.deepcopy(original["skills"][0])
    other["id"] = other["bank"]["skill_id"] = "second-skill"
    revised["skills"].append(other)
    revised["identities"][other["id"]] = {"native_id": cid + 1, "guid": "b" * 32}
    result = import_snapshot(col, revised)
    assert (result.added, result.updated, result.existing) == (1, 1, 0)
    assert col.card_count() == 2
    col.undo()
    assert col.card_count() == 1
    assert state(col)[1:] == before[1:]
    assert select_skill_review(col.get_card(cid)).exercise.id == "trabajar"
    col.redo()
    assert col.card_count() == 2
    assert select_skill_review(col.get_card(cid)).exercise.id == "cantar"


def test_native_precondition_failure_rolls_back_new_cards_and_ownership(
    col, revisions, monkeypatch
):
    original, revised = revisions
    import_snapshot(col, original)
    cid = rate(col)
    other = copy.deepcopy(original["skills"][0])
    other["id"] = other["bank"]["skill_id"] = "second-skill"
    revised["skills"].append(other)
    revised["identities"][other["id"]] = {"native_id": cid + 1, "guid": "b" * 32}
    native = col.add_skill_notes
    observed = []

    def racing_import(*args, **kwargs):
        note = col.get_card(cid).note()
        note["Title"] = "An intervening native edit"
        col.update_note(note)
        observed.append(state(col))
        return native(*args, **kwargs)

    monkeypatch.setattr(col, "add_skill_notes", racing_import)
    with pytest.raises(Exception, match="changed before revision"):
        import_snapshot(col, revised)
    assert state(col) == observed[0]
    assert col.db.scalar("select count(*) from learnrecur_skill_identities") == 1


@pytest.mark.parametrize("damage", ["history", "identity", "local", "gap", "empty"])
def test_invalid_revision_preserves_whole_collection(col, revisions, damage):
    original, revised = revisions
    import_snapshot(col, original)
    cid = rate(col)
    if damage == "history":
        revised["previous_revisions"][original["skills"][0]["id"]][0]["description"] = (
            "Wrong ancestor"
        )
    elif damage == "identity":
        revised["identities"][original["skills"][0]["id"]]["guid"] = "b" * 32
    elif damage == "local":
        note = col.get_card(cid).note()
        note["Description"] = "Changed outside the companion"
        col.update_note(note)
    elif damage == "gap":
        revised["skills"][0]["bank"]["revision"] = 3
    else:
        revised["skills"][0]["bank"]["exercises"] = []
    before = state(col)
    with pytest.raises(SkillImportError):
        import_snapshot(col, revised)
    assert state(col) == before


@pytest.mark.parametrize("after_commit", [False, True])
def test_client_interruption_retries_revision_on_same_reviewed_card(
    tmp_path, revisions, after_commit
):
    original, revised = revisions
    path = tmp_path / "collection.anki2"
    col = Collection(str(path))
    import_snapshot(col, original)
    rate(col)
    before = state(col)
    col.close()
    data = tmp_path / "revision.json"
    data.write_text(json.dumps(revised))
    script = """
import json, os, sys
from anki.collection import Collection
from anki.learnrecur_skill_import import import_snapshot
col = Collection(sys.argv[1])
original = col.add_skill_notes
def interrupted(*args, **kwargs):
    if sys.argv[3] == 'True':
        original(*args, **kwargs)
    os._exit(71)
col.add_skill_notes = interrupted
import_snapshot(col, json.load(open(sys.argv[2])))
"""
    result = subprocess.run(
        [sys.executable, "-c", script, str(path), str(data), str(after_commit)],
        env={
            **os.environ,
            "PYTHONPATH": f"{ROOT}/pylib:{ROOT}/out/pylib",
            "ANKI_TEST_MODE": "1",
        },
        capture_output=True,
        check=False,
    )
    assert result.returncode == 71, result.stderr.decode()
    col = Collection(str(path))
    try:
        assert import_snapshot(col, revised).updated == (0 if after_commit else 1)
        assert col.card_count() == 1
        assert state(col)[1:] == before[1:]
        assert (
            select_skill_review(col.get_card(col.find_cards("")[0])).exercise.id
            == "cantar"
        )
    finally:
        col.close()
