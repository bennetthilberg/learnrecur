"""Retry imported cards after ratings, undo, exports, and process interruption."""

import copy
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from anki.collection import Collection
from anki.learnrecur_skill_import import (
    DECK_NAME,
    LINK_FIELD,
    SkillImportError,
    import_snapshot,
)
from anki.learnrecur_skills import prepare_skill_answer, select_skill_review
from anki.scheduler.v3 import CardAnswer

ROOT = Path(__file__).resolve().parents[2]
SOURCE = "5528c1f8-2792-4e70-8a47-75d48c397e02"


@pytest.fixture
def snapshot():
    return {
        "source_id": SOURCE,
        **json.loads((ROOT / "learnrecur/fixtures/spanish-import.json").read_text()),
    }


@pytest.fixture
def col(tmp_path):
    collection = Collection(str(tmp_path / "collection.anki2"))
    yield collection
    collection.close()


def state(col):
    return (
        col.db.all("select * from notes order by id"),
        col.db.all("select * from cards order by id"),
        col.db.all("select * from revlog order by id"),
    )


def rate(col):
    col.decks.select(col.decks.id(DECK_NAME))
    queued = col.sched.get_queued_cards().cards[0]
    card = col.get_card(queued.card.id)
    card.start_timer()
    queued.states.current.custom_data = card.custom_data
    answer = col.sched.build_answer(
        card=card, states=queued.states, rating=CardAnswer.AGAIN
    )
    prepare_skill_answer(col, answer, select_skill_review(card))
    col.sched.answer_card(answer)
    return card.id


def test_retry_preserves_review_and_undo_after_restart(col, snapshot):
    result = import_snapshot(col, snapshot)
    assert (result.added, result.existing) == (1, 0)
    cid = rate(col)
    before = state(col)
    result = import_snapshot(col, snapshot)
    assert (result.added, result.existing) == (0, 1)
    assert state(col) == before
    col.undo()  # A no-op retry must not replace the rating's undo entry.
    assert col.get_card(cid).reps == 0
    col.redo()
    assert state(col) == before
    col.close()
    col.reopen()
    import_snapshot(col, snapshot)
    assert state(col) == before
    assert select_skill_review(col.get_card(cid)).exercise.id == "trabajar"


def test_import_undo_then_retry(col, snapshot):
    import_snapshot(col, snapshot)
    col.undo()
    assert col.card_count() == 0
    assert import_snapshot(col, snapshot).added == 1
    assert col.card_count() == 1


def test_modified_or_duplicate_link_blocks_whole_batch(col, snapshot):
    import_snapshot(col, snapshot)
    note = col.get_card(col.find_cards("")[0]).note()
    note["Description"] = "Edited locally"
    col.update_note(note)
    second = copy.deepcopy(snapshot["skills"][0])
    second["id"] = second["bank"]["skill_id"] = "another-skill"
    snapshot["skills"].append(second)
    before = state(col)
    with pytest.raises(SkillImportError, match="changed"):
        import_snapshot(col, snapshot)
    assert state(col) == before
    note["Description"] = snapshot["skills"][0]["description"]
    col.update_note(note)
    duplicate = col.new_note(note.note_type())
    duplicate.fields = note.fields.copy()
    col.add_note(duplicate, col.decks.id(DECK_NAME))
    before = state(col)
    with pytest.raises(SkillImportError, match="Duplicate"):
        import_snapshot(col, snapshot)
    assert state(col) == before


def test_same_id_from_different_companion_is_distinct(col, snapshot):
    import_snapshot(col, snapshot)
    snapshot["source_id"] = "68ec380b-9202-4cff-97b5-a55f9f222a38"
    assert import_snapshot(col, snapshot).added == 1
    assert col.card_count() == 2


def test_ordinary_deck_collision_does_not_change_notes(col, snapshot):
    note = col.new_note(col.models.by_name("Basic"))
    note["Front"], note["Back"] = "hello", "hola"
    col.add_note(note, col.decks.id(DECK_NAME))
    before = state(col)
    with pytest.raises(SkillImportError, match="ordinary"):
        import_snapshot(col, snapshot)
    assert state(col) == before


@pytest.mark.parametrize(
    "change", ["duplicate", "bool", "empty", "wrong_id", "html", "oversize"]
)
def test_invalid_batch_does_not_create_any_notes(col, snapshot, change):
    skill = snapshot["skills"][0]
    if change == "duplicate":
        snapshot["skills"].append(copy.deepcopy(skill))
    elif change == "bool":
        skill["bank"]["revision"] = True
    elif change == "empty":
        skill["bank"]["exercises"] = []
    elif change == "wrong_id":
        skill["bank"]["skill_id"] = "other"
    elif change == "html":
        skill["id"] = "<script>"
    else:
        skill["description"] = "x" * 9000
    before = state(col)
    with pytest.raises(SkillImportError):
        import_snapshot(col, snapshot)
    assert state(col) == before


@pytest.mark.parametrize("after_commit", [False, True])
@pytest.mark.parametrize("stable", [False, True])
def test_process_dies_around_native_batch_commit(
    tmp_path, canonical, after_commit, stable
):
    snapshot = (
        canonical
        if stable
        else {key: value for key, value in canonical.items() if key != "identities"}
    )
    path = tmp_path / "collection.anki2"
    data = tmp_path / "snapshot.json"
    data.write_text(json.dumps(snapshot))
    script = """
import json, os, sys
from anki.collection import Collection
from anki.learnrecur_skill_import import import_snapshot
col = Collection(sys.argv[1])
method = "add_skill_notes" if "identities" in json.load(open(sys.argv[2])) else "add_notes"
original = getattr(col, method)
def interrupted(*args):
    if sys.argv[3] == "True":
        original(*args)
    os._exit(71)
setattr(col, method, interrupted)
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
        result = import_snapshot(col, snapshot)
        assert result.added == (0 if after_commit else 1)
        assert col.card_count() == 1
        assert col.note_count() == 1
        assert col.db.scalar("select count(*) from revlog") == 0
    finally:
        col.close()


def test_link_survives_scheduled_package_round_trip(col, snapshot, tmp_path):
    from anki.import_export_pb2 import (
        ExportAnkiPackageOptions,
        ImportAnkiPackageOptions,
        ImportAnkiPackageRequest,
    )

    import_snapshot(col, snapshot)
    rate(col)
    package = tmp_path / "skills.apkg"
    col.export_anki_package(
        out_path=str(package),
        options=ExportAnkiPackageOptions(with_scheduling=True, with_media=True),
        limit=None,
    )
    dest = Collection(str(tmp_path / "destination.anki2"))
    try:
        dest.import_anki_package(
            ImportAnkiPackageRequest(
                package_path=str(package),
                options=ImportAnkiPackageOptions(with_scheduling=True),
            )
        )
        before = state(dest)
        assert import_snapshot(dest, snapshot).existing == 1
        assert state(dest) == before
        card = dest.get_card(dest.find_cards("")[0])
        assert card.reps == 1
        assert LINK_FIELD in card.note()
    finally:
        dest.close()


def test_unicode_and_literal_markup_remain_safe_to_retry(col, snapshot):
    skill = snapshot["skills"][0]
    skill["title"] = "Cafe\u0301 <b>verbs</b>"
    skill["description"] = "A < B & C; 'quotes'; accents: e\u0301"
    skill["bank"]["exercises"][0]["answer"] = "hable\u0301"
    import_snapshot(col, snapshot)
    before = state(col)
    assert import_snapshot(col, snapshot).existing == 1
    assert state(col) == before
    card = col.get_card(col.find_cards("")[0])
    assert "&lt;b&gt;" in card.note()["Title"]
    assert select_skill_review(card).exercise.answer == "hable\u0301"


def test_removed_marker_does_not_create_duplicate(col, snapshot):
    from anki.learnrecur_skills import MODEL_MARKER

    import_snapshot(col, snapshot)
    model = col.get_card(col.find_cards("")[0]).note_type()
    del model[MODEL_MARKER]
    col.models.update_dict(model)
    before = state(col)
    with pytest.raises(SkillImportError, match="changed"):
        import_snapshot(col, snapshot)
    assert state(col) == before


@pytest.fixture
def canonical(snapshot):
    snapshot["identities"] = {
        snapshot["skills"][0]["id"]: {
            "native_id": 1_790_000_000_000,
            "guid": "5528c1f827924e708a4775d48c397e02",
        }
    }
    return snapshot


def test_companion_identity_is_native_and_survives_review_undo(col, canonical):
    import_snapshot(col, canonical)
    identity = next(iter(canonical["identities"].values()))
    card = col.get_card(identity["native_id"])
    assert card.note().id == card.id
    assert card.note().guid == identity["guid"]
    rate(col)
    before = state(col)
    assert import_snapshot(col, canonical).existing == 1
    assert state(col) == before
    col.undo()
    assert col.get_card(card.id).reps == 0
    col.redo()
    assert state(col) == before


def test_legacy_identity_conflict_preserves_reviews(col, canonical):
    legacy = {key: value for key, value in canonical.items() if key != "identities"}
    import_snapshot(col, legacy)
    rate(col)
    before = state(col)
    with pytest.raises(SkillImportError, match="identity"):
        import_snapshot(col, canonical)
    assert state(col) == before


@pytest.mark.parametrize("occupied", ["note", "card", "deleted"])
def test_companion_identity_collision_does_not_replace_data(col, canonical, occupied):
    note = col.new_note(col.models.by_name("Basic"))
    note["Front"], note["Back"] = "Synthetic", "Ordinary"
    col.add_note(note, col.decks.id("Ordinary"))
    cid = note.cards()[0].id
    identity = next(iter(canonical["identities"].values()))
    identity["native_id"] = note.id if occupied == "note" else cid
    if occupied == "deleted":
        col.remove_notes([note.id])
    before = state(col)
    with pytest.raises(SkillImportError, match="used or deleted"):
        import_snapshot(col, canonical)
    assert state(col) == before


def test_native_skill_batch_rolls_back_on_later_card_collision(col, canonical):
    from anki.collection import AddNoteRequest

    import_snapshot(col, canonical)
    card = col.get_card(col.find_cards("")[0])
    note = card.note()
    first, second = [col.new_note(note.note_type()) for _ in range(2)]
    for index, candidate in enumerate((first, second)):
        candidate.fields = note.fields.copy()
        candidate.id = card.id + index + 10
        candidate.guid = f"{index + 1:032x}"
    before = state(col)
    with pytest.raises(Exception, match="identity"):
        col.add_skill_notes(
            [AddNoteRequest(first, card.did), AddNoteRequest(second, card.did)],
            [card.id + 10, card.id],
        )
    assert state(col) == before


def test_duplicate_links_block_rating_without_removing_either_copy(col, snapshot):
    from anki.learnrecur_skill_links import SkillLinkError, validate_skill_links

    import_snapshot(col, snapshot)
    rate(col)
    card = col.get_card(col.find_cards("")[0])
    duplicate = col.new_note(card.note_type())
    duplicate.fields = card.note().fields.copy()
    col.add_note(duplicate, card.did)
    before = state(col)
    with pytest.raises(SkillLinkError, match="duplicate"):
        validate_skill_links(col)
    with pytest.raises(SkillLinkError, match="duplicate"):
        select_skill_review(card)
    assert state(col) == before


@pytest.mark.parametrize("bad", ["missing", "bool", "negative", "oversize", "guid"])
def test_invalid_identities_fail_before_collection_changes(col, canonical, bad):
    identity = next(iter(canonical["identities"].values()))
    if bad == "missing":
        canonical["identities"] = {}
    elif bad == "guid":
        identity["guid"] = "bad"
    else:
        identity["native_id"] = {"bool": True, "negative": -1, "oversize": 2**53}[bad]
    before = state(col)
    with pytest.raises(SkillImportError, match="identit"):
        import_snapshot(col, canonical)
    assert state(col) == before
