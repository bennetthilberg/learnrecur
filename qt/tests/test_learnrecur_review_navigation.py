"""Finish native ratings safely after leaving or restarting review."""

from unittest.mock import MagicMock

import pytest

from anki.collection import Collection
from anki.learnrecur_skill_import import import_snapshot
from anki.learnrecur_skills import SkillReviewError, select_skill_review
from aqt import gui_hooks, learnrecur_refill
from aqt.operations import CollectionOp, QueryOp, on_op_finished
from aqt.reviewer import RefreshNeeded, Reviewer, V3CardInfo
from tests.test_learnrecur_import import server
from tests.test_learnrecur_skills import col, reviewer

__all__ = ["col", "reviewer", "server"]


@pytest.fixture
def pending_answers(monkeypatch):
    pending = []
    monkeypatch.setattr(
        CollectionOp,
        "run_in_background",
        lambda operation, **_: pending.append(operation),
    )
    return pending


@pytest.fixture
def answer_events():
    events = []

    def answered(_, card, ease):
        events.append((card.id, card.reps, ease))

    gui_hooks.reviewer_did_answer_card.append(answered)
    yield events
    gui_hooks.reviewer_did_answer_card.remove(answered)


def start_review(reviewer, kind, *, deck=None):
    deck = deck or ("Spanish skill" if kind == "skill" else "Ordinary sample")
    col: Collection = reviewer.mw.col
    col.decks.select(col.decks.id(deck))
    reviewer._v3 = V3CardInfo.from_queue(col.sched.get_queued_cards())
    reviewer.card = col.get_card(reviewer._v3.top_card().card.id)
    reviewer.card.start_timer()
    reviewer._answeredIds = []
    reviewer.nextCard = MagicMock()
    reviewer.check_timebox = MagicMock(return_value=False)
    reviewer.onLeech = MagicMock()
    reviewer._refresh_needed = None
    reviewer.mw.fade_in_webview = MagicMock()
    reviewer._showQuestion()
    reviewer._showAnswer()
    return reviewer.card


def leave_review(reviewer):
    reviewer.cleanup()
    reviewer.mw.state = "deckBrowser"


@pytest.mark.parametrize("kind", ["skill", "ordinary"])
@pytest.mark.parametrize("navigation", ["stay", "leave", "another_card"])
def test_answer_after_navigation_keeps_one_review_and_native_undo(
    reviewer, pending_answers, answer_events, monkeypatch, kind, navigation
):
    refills = []
    monkeypatch.setattr(
        learnrecur_refill.RefillRequests,
        "check",
        lambda _, mw, card: refills.append((card.id, card.custom_data)),
    )
    original = start_review(reviewer, kind)
    refills.clear()
    col = reviewer.mw.col
    before = col.db.all("select * from cards order by id")
    skill = select_skill_review(original)
    reviewer._answerCard(3)
    reviewer._answerCard(3)  # Ignore a second rating while the first is saving.
    assert len(pending_answers) == 1

    if navigation != "stay":
        leave_review(reviewer)
    if navigation == "another_card":
        other_id = next(cid for cid in col.find_cards("") if cid != original.id)
        reviewer.card = col.get_card(other_id)
        reviewer._skill_review = select_skill_review(reviewer.card)
        reviewer.mw.state = "review"
        reviewer.state = "question"
    current = reviewer.card
    selected = reviewer._skill_review

    operation = pending_answers[0]
    changes = operation._op(col)
    saved = col.get_card(original.id)
    operation._success(changes)

    assert col.db.all("select cid, ease from revlog") == [[original.id, 3]]
    assert saved.reps == 1
    assert reviewer._answeredIds == [original.id]
    assert answer_events == [(original.id, 1, 3)]
    assert refills == ([(original.id, saved.custom_data)] if skill else [])
    assert reviewer.card is current
    assert reviewer._skill_review == selected
    if navigation == "stay":
        reviewer.nextCard.assert_called_once()
    else:
        reviewer.nextCard.assert_not_called()
        reviewer.check_timebox.assert_not_called()
        assert reviewer.mw.state == (
            "review" if navigation == "another_card" else "deckBrowser"
        )
        if current:
            assert col.get_card(current.id).reps == 0

    after = col.db.all("select * from cards order by id")
    col.undo()
    assert col.db.all("select * from cards order by id") == before
    assert col.db.scalar("select count(*) from revlog") == 0
    assert select_skill_review(col.get_card(original.id)) == skill
    col.redo()
    assert col.db.all("select * from cards order by id") == after
    assert col.db.all("select cid, ease from revlog") == [[original.id, 3]]


@pytest.mark.parametrize("kind", ["skill", "ordinary"])
@pytest.mark.parametrize("collection_state", ["closed", "replaced"])
def test_late_answer_cannot_touch_a_replaced_or_closed_collection(
    reviewer, pending_answers, answer_events, monkeypatch, kind, collection_state
):
    original = start_review(reviewer, kind)
    refills = MagicMock()
    monkeypatch.setattr(learnrecur_refill, "check_refill", refills)
    reviewer._answerCard(3)
    collection = reviewer.mw.col
    operation = pending_answers[0]
    changes = operation._op(collection)
    leave_review(reviewer)
    reviewer.mw.col = None if collection_state == "closed" else object()
    operation._success(changes)
    assert collection.get_card(original.id).reps == 1
    assert answer_events == []
    assert reviewer._answeredIds == []
    refills.assert_not_called()
    reviewer.nextCard.assert_not_called()


@pytest.mark.parametrize("closure", ["open", "before_notification", "in_hook"])
def test_operation_notification_handles_a_closed_collection(
    reviewer, pending_answers, monkeypatch, closure
):
    start_review(reviewer, "ordinary")
    reviewer._answerCard(3)
    mw = reviewer.mw
    mw.update_undo_actions = MagicMock()
    changes = pending_answers[0]._op(mw.col)
    leave_review(reviewer)
    if closure == "before_notification":
        mw.col = None

    def notify(*_):
        if closure == "in_hook":
            mw.col = None

    notification = MagicMock(side_effect=notify)
    reset = MagicMock()
    monkeypatch.setattr(gui_hooks, "operation_did_execute", notification)
    monkeypatch.setattr(gui_hooks, "state_did_reset", reset)
    on_op_finished(mw, changes, reviewer)
    notification.assert_called_once_with(changes, reviewer)
    assert reset.call_count == (1 if closure == "open" else 0)


@pytest.mark.parametrize("kind", ["skill", "ordinary"])
def test_rating_and_exit_without_an_answer_hook(reviewer, pending_answers, kind):
    original = start_review(reviewer, kind)
    reviewer._answerCard(3)
    leave_review(reviewer)
    operation = pending_answers[0]
    operation._success(operation._op(reviewer.mw.col))
    assert reviewer.mw.col.get_card(original.id).reps == 1
    assert reviewer._answeredIds == [original.id]
    assert reviewer.mw.state == "deckBrowser"
    reviewer.nextCard.assert_not_called()


@pytest.mark.parametrize("kind", ["skill", "ordinary"])
def test_reopened_review_refreshes_through_the_native_change_hook(
    reviewer, pending_answers, kind
):
    original = start_review(reviewer, kind)
    reviewer._answerCard(3)
    leave_review(reviewer)
    reviewer.mw.state = "review"
    reviewer.card = reviewer.mw.col.get_card(original.id)
    reviewer._skill_review = select_skill_review(reviewer.card)
    reviewer.state = "question"
    reviewer._card_info = MagicMock()
    reviewer._previous_card_info = MagicMock()
    operation = pending_answers[0]
    changes = operation._op(reviewer.mw.col)
    operation._success(changes)
    assert reviewer._refresh_needed is RefreshNeeded.QUEUES
    reviewer.nextCard = Reviewer.nextCard.__get__(reviewer)
    reviewer.op_executed(changes, reviewer, focused=True)
    assert reviewer._refresh_needed is None
    assert reviewer.mw.state == "review"
    assert reviewer.state == "question"
    assert reviewer.card.id == original.id
    assert reviewer.card.reps == 1
    if kind == "skill":
        assert reviewer._skill_review.position == 1
        assert reviewer._skill_review.exercise.id == "trabajar"


def test_departed_skill_refills_with_the_saved_usage(
    reviewer, pending_answers, server, monkeypatch
):
    col = reviewer.mw.col
    server.refill_provider = "fixture"
    import_snapshot(col, server.store.snapshot())
    cid = col.db.scalar("select cid from learnrecur_skill_identities")
    deck = col.decks.name(col.get_card(cid).did)
    queries = []

    def queue_request(operation):
        queries.append(operation)

    sent = []
    send_request = learnrecur_refill.send_request

    def send(payload, connection):
        sent.append(payload)
        return send_request(payload, connection)

    monkeypatch.setattr(QueryOp, "run_in_background", queue_request)
    monkeypatch.setattr(learnrecur_refill, "send_request", send)
    original = start_review(reviewer, "skill", deck=deck)
    assert queries == []
    reviewer._answerCard(3)
    leave_review(reviewer)
    operation = pending_answers[0]
    operation._success(operation._op(col))
    assert len(queries) == 1
    queries[0]._success(queries[0]._op(None))
    with server.store.connect() as db:
        assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 1
    assert len(sent) == 1
    assert sent[0]["remaining"] == 2
    assert col.get_card(original.id).reps == 1
    assert reviewer.mw.state == "deckBrowser"
    reviewer.nextCard.assert_not_called()


@pytest.mark.parametrize("kind", ["skill", "ordinary"])
def test_answer_hook_can_leave_review_without_loading_another_card(
    reviewer, pending_answers, answer_events, kind
):
    original = start_review(reviewer, kind)

    def leave_after_answer(*_):
        leave_review(reviewer)

    gui_hooks.reviewer_did_answer_card.append(leave_after_answer)
    try:
        reviewer._answerCard(3)
        operation = pending_answers[0]
        operation._success(operation._op(reviewer.mw.col))
    finally:
        gui_hooks.reviewer_did_answer_card.remove(leave_after_answer)
    assert answer_events == [(original.id, 1, 3)]
    assert reviewer._answeredIds == [original.id]
    assert reviewer.mw.state == "deckBrowser"
    reviewer.nextCard.assert_not_called()
    reviewer.check_timebox.assert_not_called()


@pytest.mark.parametrize("navigation", ["stay", "leave", "closed"])
def test_failed_skill_answer_does_not_restart_a_departed_review(
    reviewer, pending_answers, answer_events, monkeypatch, navigation
):
    original = start_review(reviewer, "skill")
    warning = MagicMock()
    monkeypatch.setattr("aqt.reviewer.show_warning", warning)
    reviewer._answerCard(3)
    col = reviewer.mw.col
    note = original.note()
    note["LearnRecurSkill"] = "{}"
    col.update_note(note)
    if navigation != "stay":
        leave_review(reviewer)
    if navigation == "closed":
        reviewer.mw.col = None
    operation = pending_answers[0]
    with pytest.raises(SkillReviewError) as error:
        operation._op(col)
    operation._failure(error.value)
    assert col.get_card(original.id).reps == 0
    assert col.db.scalar("select count(*) from revlog") == 0
    assert answer_events == []
    assert reviewer._answeredIds == []
    if navigation == "closed":
        warning.assert_not_called()
    else:
        warning.assert_called_once()
    if navigation == "stay":
        reviewer.nextCard.assert_called_once()
    else:
        reviewer.nextCard.assert_not_called()
