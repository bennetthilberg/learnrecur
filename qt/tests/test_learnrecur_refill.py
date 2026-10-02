"""Refill requests run quietly outside the collection operation queue."""

import json
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from anki.collection import Collection
from anki.learnrecur_skill_import import SkillImportError, import_snapshot
from anki.learnrecur_skills import skill_refill_request
from aqt import learnrecur_refill as ui
from tests.test_learnrecur_import import TOKEN, server

__all__ = ["server"]


def body(server):
    return {
        "source_id": server.store.snapshot()["source_id"],
        "skill_id": "spanish-ar-preterite-yo",
        "revision": 1,
        "bank_sequence": 0,
        "remaining": 2,
    }


def test_authenticated_request_ignores_proxies_and_creates_one_job(server, monkeypatch):
    from learnrecur.companion.jobs import Jobs

    server.refill_provider = "fixture"
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:1")
    monkeypatch.delenv("NO_PROXY", raising=False)
    for _ in range(2):
        ui.send_request(body(server), ui.companion_connection())
    with server.store.connect() as db:
        job_id = db.execute("select id from generation_jobs").fetchone()[0]
        assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 1
    assert Jobs(server.store).get(job_id)["request"]["count"] == 3
    with pytest.raises(SkillImportError, match="could not accept"):
        ui.send_request(body(server), (ui.companion_connection()[0], TOKEN + "wrong"))


def test_network_redirect_is_not_followed(server, monkeypatch):
    session = MagicMock()
    session.__enter__.return_value = session
    response = session.post.return_value.__enter__.return_value
    response.status_code = 302
    monkeypatch.setattr(ui.requests, "Session", lambda: session)
    with pytest.raises(SkillImportError, match="could not accept"):
        ui.send_request(body(server), ui.companion_connection())
    assert session.trust_env is False
    assert session.post.call_args.kwargs["allow_redirects"] is False
    assert session.post.call_args.kwargs["timeout"] == (3, 5)


@pytest.mark.parametrize("response_body", [b"x" * 4097, b"{}", b"[]"])
def test_bad_response_is_bounded(server, monkeypatch, response_body):
    session = MagicMock()
    session.__enter__.return_value = session
    response = session.post.return_value.__enter__.return_value
    response.status_code = 200
    response.iter_content.return_value = [response_body]
    monkeypatch.setattr(ui.requests, "Session", lambda: session)
    with pytest.raises(SkillImportError):
        ui.send_request(body(server), ui.companion_connection())


def test_checks_are_throttled_inflight_and_profile_guarded(server, monkeypatch, capsys):
    now = [0]
    collection = object()
    mw = SimpleNamespace(col=collection)
    controller = ui.RefillRequests(collection, clock=lambda: now[0])
    monkeypatch.setattr(ui, "skill_refill_request", lambda _: body(server))
    queued = []
    operation = MagicMock()
    operation.failure.return_value = operation
    operation.without_collection.return_value = operation

    def query(**kwargs):
        queued.append(kwargs)
        return operation

    monkeypatch.setattr(ui, "QueryOp", query)
    controller.check(mw, object())
    now[0] = 70
    controller.check(mw, object())
    assert len(queued) == 1  # Still in flight.
    operation.without_collection.assert_called_once()
    operation.failure.call_args.args[0](Exception("private network detail"))
    assert "private network detail" not in capsys.readouterr().out
    controller.check(mw, object())
    assert len(queued) == 2
    queued[1]["success"](None)
    controller.check(mw, object())
    assert len(queued) == 2
    mw.col = object()
    now[0] = 140
    controller.check(mw, object())
    assert len(queued) == 2


def test_unconfigured_or_ordinary_review_does_not_queue(server, monkeypatch):
    mw = SimpleNamespace(col=object())
    controller = ui.RefillRequests(mw.col)
    query = MagicMock()
    monkeypatch.setattr(ui, "QueryOp", query)
    monkeypatch.setattr(ui, "skill_refill_request", lambda _: None)
    controller.check(mw, object())
    monkeypatch.delenv("LEARNRECUR_COMPANION_TOKEN")
    monkeypatch.setattr(
        ui, "skill_refill_request", lambda _: pytest.fail("No configuration")
    )
    controller.check(mw, object())
    query.assert_not_called()


def test_full_refill_keeps_local_bank_until_manual_import(server, tmp_path):
    from anki.learnrecur_skills import prepare_skill_answer, select_skill_review
    from anki.scheduler.v3 import CardAnswer
    from learnrecur.companion.jobs import FixtureProvider, Jobs

    server.refill_provider = "fixture"
    col = Collection(str(tmp_path / "synthetic.anki2"))
    try:
        import_snapshot(col, server.store.snapshot())
        cid = col.find_cards("note:LearnRecur*")[0]
        card = col.get_card(cid)
        col.decks.select(card.did)
        assert skill_refill_request(card) is None
        queued = col.sched.get_queued_cards().cards[0]
        card.start_timer()
        answer = col.sched.build_answer(
            card=card, states=queued.states, rating=CardAnswer.AGAIN
        )
        prepare_skill_answer(col, answer, select_skill_review(card))
        col.sched.answer_card(answer)
        card = col.get_card(cid)
        before = card.custom_data
        ui.send_request(skill_refill_request(card), ui.companion_connection())
        Jobs(server.store).run_once(FixtureProvider())
        assert len(json.loads(card.note()["LearnRecurSkill"])["exercises"]) == 3
        assert col.get_card(cid).custom_data == before
        ui.send_request(skill_refill_request(card), ui.companion_connection())
        with server.store.connect() as db:
            assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 1
        import_snapshot(col, server.store.snapshot())
        assert (
            len(json.loads(col.get_card(cid).note()["LearnRecurSkill"])["exercises"])
            == 6
        )
        assert col.get_card(cid).custom_data == before
        assert skill_refill_request(col.get_card(cid)) is None
        col.undo()
        assert skill_refill_request(col.get_card(cid))["remaining"] == 2
    finally:
        col.close()
