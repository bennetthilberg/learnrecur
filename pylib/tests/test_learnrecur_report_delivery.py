"""Native report states survive Undo, lost receipts, and client restoration."""

from anki.learnrecur_reports import acknowledge_reports, pending_reports
from anki.learnrecur_skills import report_skill_review, select_skill_review
from tests.test_learnrecur_reports import imported, reports
from tests.test_learnrecur_revisions import col, revisions

__all__ = ["col", "revisions"]


def next_report(col, revisions):
    return pending_reports(col, revisions[0]["source_id"])[0]


def test_native_outbox_undo_redo_and_ack_preserve_exact_review_state(col, revisions):
    card = imported(col, revisions)
    report_skill_review(col, select_skill_review(card), "incorrect")
    original = next_report(col, revisions)
    assert original["active"] and original["version"] == 1
    undo = col.undo_status()
    acknowledge_reports(col, [original], [{"version": 1, "active": True}])
    assert col.undo_status() == undo
    assert not pending_reports(col, revisions[0]["source_id"])
    col.undo()
    canceled = next_report(col, revisions)
    assert not canceled["active"] and canceled["version"] == 2
    assert canceled["report_id"] == original["report_id"]
    assert not reports(col)
    # A receipt for the earlier report cannot acknowledge this cancellation.
    acknowledge_reports(col, [original], [{"version": 1, "active": True}])
    assert next_report(col, revisions) == canceled
    col.redo()
    assert next_report(col, revisions)["version"] == 3
    assert next_report(col, revisions)["active"]
    col.close()
    col.reopen()
    assert next_report(col, revisions)["version"] == 3


def test_lost_reply_and_older_restoration_advance_without_clearing_undo(col, revisions):
    card = imported(col, revisions)
    report_skill_review(col, select_skill_review(card), "unclear")
    current = next_report(col, revisions)
    saved = col.undo_status()
    acknowledge_reports(col, [current], [{"version": 8, "active": False}])
    newer = next_report(col, revisions)
    assert newer["version"] == 9 and newer["active"]
    assert saved == col.undo_status()
    acknowledge_reports(col, [newer], [{"version": 9, "active": True}])
    assert not pending_reports(col, revisions[0]["source_id"])
    assert pending_reports(col, revisions[0]["source_id"], replay=True)[0] == newer


def test_wrong_source_and_package_identity_cannot_authorize_delivery(col, revisions):
    card = imported(col, revisions)
    report_skill_review(col, select_skill_review(card), "other")
    assert not pending_reports(col, "wrong-source")
    col.db.execute("delete from learnrecur_skill_identities")
    assert not pending_reports(col, revisions[0]["source_id"])


def test_report_undo_remains_visible_to_timestamp_backup(col, revisions):
    card = imported(col, revisions)
    report_skill_review(col, select_skill_review(card), "incorrect")
    modified = col.db.scalar("select mod from col")
    col.undo()
    assert col.db.scalar("select mod from col") > modified
    canceled = next_report(col, revisions)
    col.redo()
    assert col.db.scalar("select mod from col") > modified
    assert next_report(col, revisions)["version"] > canceled["version"]


def test_existing_local_reports_gain_stable_outbox_identity_on_upgrade(col, revisions):
    card = imported(col, revisions)
    report_skill_review(col, select_skill_review(card), "incorrect")
    saved = reports(col)
    # Simulate a collection from before report delivery existed.
    col.db.execute("drop table learnrecur_report_outbox")
    col.close()
    col.reopen()
    queued = next_report(col, revisions)
    assert queued["active"] and queued["version"] == 1
    assert reports(col) == saved
    col.close()
    col.reopen()
    assert next_report(col, revisions) == queued
