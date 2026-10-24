"""Deleted skills reach the companion in the background, and Undo can withdraw them."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from anki.collection import Collection
from anki.learnrecur_retirements import acknowledge_retirements, pending_retirements
from anki.learnrecur_skill_import import SkillImportError, import_snapshot
from aqt import learnrecur_report_delivery as ui
from tests.test_learnrecur_import import server
from tests.test_learnrecur_report_delivery import queues, success

__all__ = ["server"]


def setup(tmp_path, server):
    col = Collection(str(tmp_path / "synthetic.anki2"))
    import_snapshot(col, server.store.snapshot())
    col.remove_notes(col.find_notes(""))
    return SimpleNamespace(col=col, state="deckBrowser")


def drain(controller, mw, queries, writes):
    while queries or writes:
        if queries:
            success(queries.pop(0), mw.col)
        if writes:
            write = writes.pop(0)
            write["runner"].success.call_args.args[0](write["op"](mw.col))
    assert not controller.busy


def test_offline_deletion_is_delivered_after_restart_and_undo_withdraws_it(
    server, tmp_path, monkeypatch
):
    mw = setup(tmp_path, server)
    try:
        source = server.store.snapshot()["source_id"]
        values = pending_retirements(mw.col, source)
        assert [(v["version"], v["active"]) for v in values] == [(1, True)]
        mw.col.close()
        mw.col.reopen()
        assert pending_retirements(mw.col, source) == values
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
        receipts = ui.send_retirements(values, ui.companion_connection())
        # A lost reply retries with the same answer.
        assert ui.send_retirements(values, ui.companion_connection()) == receipts
        assert receipts[0]["status"] == "retired"
        acknowledge_retirements(mw.col, values, receipts)
        assert pending_retirements(mw.col, source) == []
        assert server.store.snapshot()["skills"] == []
        assert import_snapshot(mw.col, server.store.snapshot()).added == 0
    finally:
        mw.col.close()


def test_controller_sends_deletion_then_withdrawal_after_undo(
    server, tmp_path, monkeypatch
):
    mw = setup(tmp_path, server)
    try:
        queries, writes = queues(monkeypatch)
        controller = ui.RetirementDelivery(mw.col)
        controller.check(mw)
        drain(controller, mw, queries, writes)
        assert server.store.snapshot()["skills"] == []
        mw.col.undo()
        assert mw.col.card_count() == 1
        controller.check(mw, force=True)
        drain(controller, mw, queries, writes)
        assert len(server.store.snapshot()["skills"]) == 1
        assert pending_retirements(mw.col, server.store.snapshot()["source_id"]) == []
    finally:
        mw.col.close()


def test_check_reports_runs_both_queues(server, tmp_path, monkeypatch):
    mw = setup(tmp_path, server)
    try:
        queries, _ = queues(monkeypatch)
        ui.check_reports(mw)
        # Only the retirement queue has work, so only it fetches the snapshot.
        assert len(queries) == 1
        assert isinstance(mw._retirement_delivery, ui.RetirementDelivery)
        assert not mw._report_delivery.busy and mw._retirement_delivery.busy
    finally:
        mw.col.close()


@pytest.mark.parametrize("status", [400, 409])
def test_refusals_are_final_and_do_not_block_later_requests(
    server, tmp_path, monkeypatch, status
):
    mw = setup(tmp_path, server)
    try:
        values = pending_retirements(mw.col, server.store.snapshot()["source_id"])
        session = MagicMock()
        session.__enter__.return_value = session
        session.post.return_value.__enter__.return_value.status_code = status
        monkeypatch.setattr(ui.requests, "Session", lambda: session)
        receipts = ui.send_retirements(values * 2, ui.companion_connection())
        assert [r["status"] for r in receipts] == ["refused", "refused"]
        assert session.post.call_count == 2
        assert session.trust_env is False
        assert session.post.call_args.kwargs["allow_redirects"] is False
    finally:
        mw.col.close()


def test_unavailable_companion_keeps_the_request(server, tmp_path, monkeypatch):
    mw = setup(tmp_path, server)
    try:
        values = pending_retirements(mw.col, server.store.snapshot()["source_id"])
        session = MagicMock()
        session.__enter__.return_value = session
        session.post.return_value.__enter__.return_value.status_code = 503
        monkeypatch.setattr(ui.requests, "Session", lambda: session)
        with pytest.raises(SkillImportError):
            ui.send_retirements(values, ui.companion_connection())
        assert (
            pending_retirements(mw.col, server.store.snapshot()["source_id"]) == values
        )
    finally:
        mw.col.close()


def test_reviewer_delete_note_removes_a_skill_like_any_note(
    server, tmp_path, monkeypatch
):
    from aqt import reviewer as reviewer_module
    from aqt.operations import note as note_ops

    col = Collection(str(tmp_path / "synthetic.anki2"))
    try:
        import_snapshot(col, server.store.snapshot())
        ops = []
        # Browse > Delete Note uses the same native operation.
        monkeypatch.setattr(
            reviewer_module,
            "remove_notes",
            lambda **kwargs: ops.append(note_ops.remove_notes(**kwargs)) or MagicMock(),
        )
        reviewer = object.__new__(reviewer_module.Reviewer)
        reviewer.card = col.get_card(col.find_cards("")[0])
        reviewer.mw = SimpleNamespace(state="review", col=col)
        reviewer.delete_current_note()
        ops[0]._op(col)
        assert col.card_count() == 0
        assert len(pending_retirements(col, server.store.snapshot()["source_id"])) == 1
        col.undo()
        assert col.card_count() == 1
        assert not pending_retirements(col, server.store.snapshot()["source_id"])[0][
            "active"
        ]
    finally:
        col.close()


def test_report_for_a_retired_skill_does_not_block_other_reports(server, tmp_path):
    import copy

    from anki.learnrecur_reports import acknowledge_reports, pending_reports
    from anki.learnrecur_skills import report_skill_review, select_skill_review
    from learnrecur.companion.retirements import Retirements

    first = server.store.snapshot()["skills"][0]
    other = copy.deepcopy(first)
    other["id"] = other["bank"]["skill_id"] = "zz-other-skill"
    server.store.import_batch({"skills": [other]})
    col = Collection(str(tmp_path / "synthetic.anki2"))
    try:
        snapshot = server.store.snapshot()
        import_snapshot(col, snapshot)
        for cid in col.find_cards(""):
            report_skill_review(col, select_skill_review(col.get_card(cid)), "other")
        # Another device deleted the first skill and delivered its retirement.
        identity = snapshot["identities"][first["id"]]
        Retirements(server.store).receive(
            {
                "retirement_id": "a" * 32,
                "version": 1,
                "active": True,
                "source_id": snapshot["source_id"],
                "skill_id": first["id"],
                "guid": identity["guid"],
                "native_id": identity["native_id"],
            }
        )
        values = pending_reports(col, snapshot["source_id"])
        assert sorted(v["skill_id"] for v in values) == [first["id"], "zz-other-skill"]
        receipts = ui.send_reports(values, ui.companion_connection())
        status = {v["skill_id"]: r["status"] for v, r in zip(values, receipts)}
        assert status[first["id"]] == "refused"
        assert status["zz-other-skill"] != "refused"
        acknowledge_reports(col, values, receipts)
        assert pending_reports(col, snapshot["source_id"]) == []
        with server.store.connect() as db:
            assert db.execute("select skill_id from exercise_reports").fetchall() == [
                ("zz-other-skill",)
            ]
    finally:
        col.close()


def test_other_report_refusals_still_retry(server, tmp_path, monkeypatch):
    from anki.learnrecur_reports import pending_reports
    from anki.learnrecur_skills import report_skill_review, select_skill_review

    col = Collection(str(tmp_path / "synthetic.anki2"))
    try:
        import_snapshot(col, server.store.snapshot())
        card = col.get_card(col.find_cards("")[0])
        report_skill_review(col, select_skill_review(card), "other")
        values = pending_reports(col, server.store.snapshot()["source_id"])
        session = MagicMock()
        session.__enter__.return_value = session
        response = session.post.return_value.__enter__.return_value
        response.status_code = 409
        response.iter_content.return_value = [
            b'{"error":"The report history is full."}'
        ]
        monkeypatch.setattr(ui.requests, "Session", lambda: session)
        with pytest.raises(SkillImportError):
            ui.send_reports(values, ui.companion_connection())
    finally:
        col.close()
