"""Full collection restores keep offline study and require verified reconnection."""

import copy
import json
import os
import subprocess
import sys

import pytest

from anki.collection import Collection
from anki.errors import InvalidInput, NotFoundError
from anki.learnrecur_reports import pending_reports
from anki.learnrecur_restore import reconnect_skills
from anki.learnrecur_skill_import import SkillImportError, import_snapshot
from anki.learnrecur_skills import render_skill_review, select_skill_review
from tests.learnrecur_deck_fixture import IMAGE_NAME, content, seed
from tests.test_learnrecur_batches import appended
from tests.test_learnrecur_reports import report, reports
from tests.test_learnrecur_revisions import col, revisions
from tests.test_learnrecur_skill_import import rate, state

__all__ = ["col", "revisions"]


def seed_restore_fixture(col, revisions):
    seed(col)
    original, revised = revisions
    import_snapshot(col, original)
    cid = rate(col)
    report(col, col.get_card(cid))
    latest = latest_snapshot(revisions)
    import_snapshot(col, latest)
    rate(col)
    report(col, col.get_card(cid))
    col.undo()  # Keep a withdrawal waiting for delivery.
    rate(col)
    report(col, col.get_card(cid))
    return cid, latest


def latest_snapshot(revisions):
    original, revised = revisions
    latest = appended(revised)
    batch = copy.deepcopy(latest["bank_updates"][original["skills"][0]["id"]][0])
    batch.update(job_id="b" * 32, revision=2, sequence=2)
    for exercise in batch["exercises"]:
        exercise["id"] += "-v2"
        exercise["prompt"] = (
            exercise["prompt"]
            .replace("Anoche", "El sábado")
            .replace("Ayer", "El domingo")
        )
    latest["bank_updates"][original["skills"][0]["id"]].append(batch)
    return latest


def restore(col, tmp_path, *, legacy=False):
    package = tmp_path / "synthetic.colpkg"
    target = tmp_path / "restored.anki2"
    col.export_collection_package(str(package), include_media=True, legacy=legacy)
    try:
        col._backend.import_collection_package(
            col_path=str(target),
            backup_path=str(package),
            media_folder=str(tmp_path / "restored.media"),
            media_db=str(tmp_path / "restored.media.db2"),
        )
    finally:
        col.reopen()
    return Collection(str(target))


def outbox(col):
    return col.db.all("select * from learnrecur_report_outbox order by report_id")


@pytest.mark.parametrize("legacy", [False, True])
def test_complete_collection_round_trip_and_reconnect(col, revisions, tmp_path, legacy):
    cid, snapshot = seed_restore_fixture(col, revisions)
    expected_content, expected_state = content(col), state(col)
    expected_reports, expected_outbox = reports(col), outbox(col)
    assert {row[6] for row in expected_outbox} == {0, 1}
    restored = restore(col, tmp_path, legacy=legacy)
    try:
        assert content(restored) == expected_content
        assert state(restored) == expected_state
        assert reports(restored) == expected_reports
        assert outbox(restored) == expected_outbox
        assert not restored.db.scalar(
            "select count(*) from learnrecur_skill_identities"
        )
        assert not pending_reports(restored, snapshot["source_id"])
        review = select_skill_review(restored.get_card(cid))
        card = restored.get_card(cid)
        render_skill_review(card, review)
        assert review.exercise.answer in card.answer()
        rate(restored)  # Offline study works before any connection.
        rated = state(restored)
        assert reconnect_skills(restored, snapshot).connected == 1
        assert state(restored) == rated
        assert (
            reports(restored) == expected_reports
            and outbox(restored) == expected_outbox
        )
        assert len(pending_reports(restored, snapshot["source_id"])) == len(
            expected_outbox
        )
        assert reconnect_skills(restored, snapshot).existing == 1
        restored.undo()
        assert state(restored) == expected_state
        restored.redo()
        assert state(restored) == rated
        restored.close()
        restored.reopen()
        assert reconnect_skills(restored, snapshot).existing == 1
        assert state(restored) == rated
        assert content(restored)["media"] == expected_content["media"]
        assert (tmp_path / "restored.media" / IMAGE_NAME).exists()
    finally:
        restored.close()


@pytest.mark.parametrize("cache", ["original", "revision", "batch"])
def test_authenticated_history_can_connect_older_cache_without_updating_it(
    col, revisions, cache
):
    original, revised = revisions
    latest = latest_snapshot(revisions)
    import_snapshot(
        col, {"original": original, "revision": revised, "batch": latest}[cache]
    )
    col.db.execute("delete from learnrecur_skill_identities")
    before = state(col)
    assert reconnect_skills(col, latest).connected == 1
    assert state(col) == before
    assert import_snapshot(col, latest).added == 0


@pytest.mark.parametrize(
    "change",
    ["content", "guid", "card", "duplicate", "template", "future", "source", "grave"],
)
def test_conflicts_do_not_grant_ownership(col, revisions, change):
    original, revised = revisions
    import_snapshot(col, original)
    col.db.execute("delete from learnrecur_skill_identities")
    cid = col.find_cards("")[0]
    note = col.get_card(cid).note()
    if change == "content":
        note["Answer"] = "Changed answer"
        col.update_note(note)
    elif change == "guid":
        note.guid = "c" * 32
        col.update_note(note)
    elif change == "card":
        col.db.execute("update cards set id=id+1 where id=?", cid)
    elif change == "duplicate":
        other = col.new_note(note.note_type())
        other.fields = note.fields
        col.add_note(other, col.get_card(cid).did)
    elif change == "template":
        model = note.note_type()
        template = col.models.new_template("Other")
        template["qfmt"] = "{{Title}}"
        col.models.add_template(model, template)
        col.models.update_dict(model)
    elif change == "future":
        # The server snapshot cannot confirm a newer local revision.
        col.db.execute(
            "insert into learnrecur_skill_identities values(?,?,?)", cid, cid, note.guid
        )
        import_snapshot(col, revised)
        col.db.execute("delete from learnrecur_skill_identities")
    elif change == "source":
        original["source_id"] = "66752115-a688-4472-8e29-0212118a577c"
    elif change == "grave":
        col.db.execute("insert into graves(usn,oid,type) values(-1,?,0)", cid)
    before = state(col)
    if change == "source":
        assert reconnect_skills(col, original).connected == 0
    else:
        with pytest.raises((SkillImportError, InvalidInput)):
            reconnect_skills(col, original)
    assert state(col) == before
    assert not col.db.scalar("select count(*) from learnrecur_skill_identities")


@pytest.mark.parametrize("race_kind", ["delete", "edit"])
def test_native_recheck_rolls_back_entire_reconnect(
    col, revisions, monkeypatch, race_kind
):
    snapshot = copy.deepcopy(revisions[0])
    other = copy.deepcopy(snapshot["skills"][0])
    other["id"] = other["bank"]["skill_id"] = "other"
    snapshot["skills"].append(other)
    snapshot["identities"]["other"] = {"native_id": 1800000000001, "guid": "b" * 32}
    import_snapshot(col, snapshot)
    col.db.execute("delete from learnrecur_skill_identities")
    native = col._backend.reconnect_skill_notes

    def race(**kwargs):
        if race_kind == "delete":
            col.remove_notes([1800000000001])
        else:
            note = col.get_note(1800000000001)
            note["Title"] = "An intervening edit"
            col.update_note(note)
        return native(**kwargs)

    monkeypatch.setattr(col._backend, "reconnect_skill_notes", race)
    error, message = (
        (NotFoundError, "No such note")
        if race_kind == "delete"
        else (InvalidInput, "changed before reconnect")
    )
    with pytest.raises(error, match=message):
        reconnect_skills(col, snapshot)
    assert not col.db.scalar("select count(*) from learnrecur_skill_identities")


def test_reconnect_keeps_moved_cards_and_ignores_unrelated_malformed_links(
    col, revisions
):
    original, _ = revisions
    import_snapshot(col, original)
    cid = rate(col)
    model = col.get_card(cid).note_type()
    other = col.new_note(model)
    other["Title"] = "Unrelated malformed skill"
    other["LearnRecurLink"] = "invalid"
    col.add_note(other, col.get_card(cid).did)
    model["name"] = "Renamed skill type"
    model["css"] += " .card { color: blue; }"
    col.models.update_dict(model)
    col.set_deck([cid], col.decks.id("Moved skills"))
    col.db.execute("delete from learnrecur_skill_identities")
    before = state(col)
    assert reconnect_skills(col, original).connected == 1
    assert state(col) == before
    assert col.get_card(cid).note_type()["css"] == model["css"]


@pytest.mark.parametrize("after_commit", [False, True])
def test_process_death_around_native_reconnect_is_retryable(
    col, revisions, after_commit
):
    snapshot = revisions[0]
    import_snapshot(col, snapshot)
    col.db.execute("delete from learnrecur_skill_identities")
    before = state(col)
    path = col.path
    col.close()
    program = """
import json, os, sys
from anki.collection import Collection
from anki.learnrecur_restore import reconnect_skills
col = Collection(sys.argv[1])
if sys.argv[3] == "False":
    os._exit(71)
reconnect_skills(col, json.loads(sys.argv[2]))
os._exit(71)
"""
    result = subprocess.run(
        [sys.executable, "-c", program, path, json.dumps(snapshot), str(after_commit)],
        env={**os.environ, "ANKI_TEST_MODE": "1"},
        capture_output=True,
        check=False,
    )
    assert result.returncode == 71, result.stderr.decode()
    col.reopen()
    assert state(col) == before
    assert reconnect_skills(col, snapshot).connected == (0 if after_commit else 1)
    assert col.card_count() == 1


def test_future_batches_cannot_authorize_a_fabricated_older_cache(col, revisions):
    from anki.learnrecur_skill_import import FIELDS, _fields

    original, _ = revisions
    latest = latest_snapshot(revisions)
    import_snapshot(col, original)
    note = col.get_note(col.find_notes("")[0])
    key = original["skills"][0]["id"]
    for field, value in zip(
        FIELDS,
        _fields(
            original["source_id"],
            original["skills"][0],
            batches=latest["bank_updates"][key],
        ),
    ):
        note[field] = value
    col.update_note(note)
    col.db.execute("delete from learnrecur_skill_identities")
    with pytest.raises(SkillImportError, match="published history"):
        reconnect_skills(col, latest)
    assert not col.db.scalar("select count(*) from learnrecur_skill_identities")
