"""Report transport and callbacks preserve local review and native Undo."""

import copy
import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from anki.collection import Collection
from anki.learnrecur_reports import acknowledge_reports, pending_reports
from anki.learnrecur_skill_import import SkillImportError, import_snapshot
from anki.learnrecur_skills import report_skill_review, select_skill_review
from aqt import learnrecur_report_delivery as ui
from tests.test_learnrecur_import import server

__all__ = ["server"]


def setup(tmp_path, server):
    col = Collection(str(tmp_path / "synthetic.anki2"))
    import_snapshot(col, server.store.snapshot())
    card = col.get_card(col.find_cards("")[0])
    report_skill_review(col, select_skill_review(card), "incorrect")
    return SimpleNamespace(col=col, state="review")


def queues(monkeypatch):
    queries, writes = [], []

    def operation(target, **kwargs):
        mock = MagicMock()
        mock.failure.return_value = mock
        mock.success.return_value = mock
        mock.without_collection.return_value = mock
        kwargs["runner"] = mock
        target.append(kwargs)
        return mock

    monkeypatch.setattr(ui, "QueryOp", lambda **kw: operation(queries, **kw))
    monkeypatch.setattr(ui, "CollectionOp", lambda **kw: operation(writes, **kw))
    return queries, writes


def success(query, col=None):
    query["success"](query["op"](col))


def test_full_offline_restart_delivery_fixture_and_native_undo(
    server, tmp_path, monkeypatch
):
    from learnrecur.companion.jobs import FixtureProvider, Jobs

    server.refill_provider = "fixture"
    mw = setup(tmp_path, server)
    try:
        source = server.store.snapshot()["source_id"]
        before = (
            mw.col.db.all("select * from cards"),
            mw.col.db.all("select * from revlog"),
        )
        values = pending_reports(mw.col, source)
        mw.col.close()
        mw.col.reopen()
        assert pending_reports(mw.col, source) == values
        monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
        receipts = ui.send_reports(values, ui.companion_connection())
        assert (
            ui.send_reports(values, ui.companion_connection()) == receipts
        )  # Lost reply retry.
        acknowledge_reports(mw.col, values, receipts)
        assert Jobs(server.store).run_once(FixtureProvider()) == receipts[0]["job_id"]
        assert (
            select_skill_review(
                mw.col.get_card(values_card := mw.col.find_cards("")[0])
            ).exercise.id
            == "trabajar"
        )
        import_snapshot(mw.col, server.store.snapshot(), cache_only=True)
        assert (
            mw.col.db.all("select * from cards"),
            mw.col.db.all("select * from revlog"),
        ) == before
        assert (
            len(
                json.loads(mw.col.get_card(values_card).note()["LearnRecurSkill"])[
                    "exercises"
                ]
            )
            == 6
        )
        # Native Undo was cleared by restart; make a second report and deliver it first.
        report_skill_review(
            mw.col, select_skill_review(mw.col.get_card(values_card)), "unclear"
        )
        sent = pending_reports(mw.col, source)
        acknowledge_reports(
            mw.col, sent, ui.send_reports(sent, ui.companion_connection())
        )
        mw.col.undo()
        canceled = pending_reports(mw.col, source)
        assert not canceled[0]["active"]
        acknowledge_reports(
            mw.col, canceled, ui.send_reports(canceled, ui.companion_connection())
        )
        assert (
            select_skill_review(mw.col.get_card(values_card)).exercise.id == "trabajar"
        )
        with server.store.connect() as db:
            assert (
                db.execute("select sum(active) from exercise_reports").fetchone()[0]
                == 1
            )
    finally:
        mw.col.close()


def test_inflight_undo_and_stale_profile_receipts(server, tmp_path, monkeypatch):
    mw = setup(tmp_path, server)
    col = mw.col
    try:
        query, writes = queues(monkeypatch)
        controller = ui.ReportDelivery(col)
        controller.check(mw)
        assert controller.busy and len(query) == 1
        success(query[0])  # Verify destination identity.
        success(query[1], col)  # Capture version 1.
        col.undo()
        controller.check(mw, force=True)
        assert controller.again
        success(query[2])  # Report reaches server after local Undo.
        result = writes[0]["op"](col)
        assert (
            pending_reports(col, server.store.snapshot()["source_id"])[0]["version"]
            == 2
        )
        writes[0]["runner"].success.call_args.args[0](result)
        assert len(query) == 4  # A fresh pass sends the cancellation.
        mw.col = object()
        success(query[3])
        assert not controller.busy and len(writes) == 1
    finally:
        col.close()


def test_connection_removal_discards_async_callbacks(server, tmp_path, monkeypatch):
    mw = setup(tmp_path, server)
    try:
        query, writes = queues(monkeypatch)
        controller = ui.ReportDelivery(mw.col)
        controller.check(mw)
        monkeypatch.delenv("LEARNRECUR_COMPANION_TOKEN")
        query[0]["success"](server.store.snapshot())
        assert not controller.busy and not writes and len(query) == 1
    finally:
        mw.col.close()


def test_chunks_drain_and_acknowledged_reports_heal_older_server_backup(
    server, tmp_path, monkeypatch
):
    first = server.store.snapshot()["skills"][0]
    additional = []
    for i in range(11):
        skill = copy.deepcopy(first)
        skill["id"] = skill["bank"]["skill_id"] = f"skill-{i}"
        additional.append(skill)
    server.store.import_batch({"skills": additional})
    mw = setup(tmp_path, server)
    try:
        for cid in mw.col.find_cards("")[1:]:
            report_skill_review(
                mw.col, select_skill_review(mw.col.get_card(cid)), "other"
            )
        source = server.store.snapshot()["source_id"]
        assert len(pending_reports(mw.col, source)) == 10
        queries, writes = queues(monkeypatch)
        now = [0]
        controller = ui.ReportDelivery(mw.col, clock=lambda: now[0])

        def drain():
            while queries or writes:
                if queries:
                    success(queries.pop(0), mw.col)
                if writes:
                    write = writes.pop(0)
                    result = write["op"](mw.col)
                    write["runner"].success.call_args.args[0](result)
            assert not controller.busy and controller.replayed

        controller.check(mw)
        drain()
        assert not pending_reports(mw.col, source)
        with server.store.connect() as db:
            saved = db.execute(
                "select * from exercise_reports order by report_id"
            ).fetchall()
            assert len(saved) == 12
            # Simulate an older backend backup without the received claims.
            db.execute("delete from exercise_reports")
        now[0] = 60
        controller.check(mw)
        drain()
        with server.store.connect() as db:
            assert (
                db.execute(
                    "select * from exercise_reports order by report_id"
                ).fetchall()
                == saved
            )
    finally:
        mw.col.close()


def test_failed_delivery_is_throttled_and_does_not_log_credentials(
    server, tmp_path, monkeypatch, capsys
):
    mw = setup(tmp_path, server)
    try:
        query, _ = queues(monkeypatch)
        now = [0]
        controller = ui.ReportDelivery(mw.col, clock=lambda: now[0])
        controller.check(mw)
        query[0]["runner"].failure.call_args.args[0](
            Exception("synthetic private token")
        )
        controller.check(mw)
        assert len(query) == 1 and "private token" not in capsys.readouterr().out
        now[0] = 60
        controller.check(mw)
        assert len(query) == 2
    finally:
        mw.col.close()


@pytest.mark.parametrize(
    "body",
    [
        b"{}",
        b"x" * 4097,
        b'{"report_id":"wrong","version":1,"active":true,"status":"recorded","job_id":null}',
    ],
)
def test_invalid_receipts_cannot_acknowledge(server, tmp_path, monkeypatch, body):
    mw = setup(tmp_path, server)
    try:
        values = pending_reports(mw.col, server.store.snapshot()["source_id"])
        session = MagicMock()
        session.__enter__.return_value = session
        response = session.post.return_value.__enter__.return_value
        response.status_code = 200
        response.iter_content.return_value = [body]
        monkeypatch.setattr(ui.requests, "Session", lambda: session)
        with pytest.raises(SkillImportError):
            ui.send_reports(values, ui.companion_connection())
        assert pending_reports(mw.col, server.store.snapshot()["source_id"]) == values
        session.post.assert_called_once()
        assert session.trust_env is False
        assert session.post.call_args.kwargs["allow_redirects"] is False
    finally:
        mw.col.close()
