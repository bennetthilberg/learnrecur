"""Completed batches arrive only at safe boundaries in the same profile."""

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from anki.collection import Collection
from anki.learnrecur_skill_import import import_snapshot
from aqt import learnrecur_delivery as ui
from tests.test_learnrecur_import import server

__all__ = ["server"]


def queued_operations(monkeypatch):
    queries, mutations = [], []

    def operation(queue, **kwargs):
        queue.append(kwargs)
        mock = MagicMock()
        mock.failure.return_value = mock
        mock.success.return_value = mock
        kwargs["runner"] = mock
        mock.without_collection.return_value = mock
        return mock

    monkeypatch.setattr(ui, "QueryOp", lambda **kwargs: operation(queries, **kwargs))
    monkeypatch.setattr(
        ui, "CollectionOp", lambda **kwargs: operation(mutations, **kwargs)
    )
    return queries, mutations


def window(tmp_path, server):
    col = Collection(str(tmp_path / "synthetic.anki2"))
    import_snapshot(col, server.store.snapshot())
    return SimpleNamespace(col=col, state="deckBrowser")


def test_late_fetch_waits_for_review_to_end_and_checks_queued_apply(
    server, tmp_path, monkeypatch
):
    mw = window(tmp_path, server)
    try:
        queries, mutations = queued_operations(monkeypatch)
        now = [0]
        delivery = ui.BatchDelivery(mw.col, clock=lambda: now[0])
        delivery.check(mw)
        assert len(queries) == 1
        mw.state = "review"
        snapshot = queries[0]["op"](None)
        queries[0]["success"](snapshot)
        assert not mutations and delivery.snapshot is snapshot
        mw.state = "deckBrowser"
        delivery.check(mw)
        assert len(mutations) == 1
        mw.state = "review"  # State changed while collection work was queued.
        guarded = mutations[0]["op"](mw.col)
        assert not mw.col.op_made_changes(guarded)
        mutations[0]["runner"].success.call_args.args[0](guarded)
        assert not delivery.applying and delivery.snapshot is snapshot
        mw.state = "deckBrowser"
        delivery.check(mw)
        result = mutations[1]["op"](mw.col)
        assert result.existing == 1
        mutations[1]["runner"].success.call_args.args[0](result)
        assert not delivery.applying and delivery.snapshot is None
        delivery.check(mw)
        assert len(queries) == 1
        now[0] = 60
        delivery.check(mw)
        assert len(queries) == 2
    finally:
        mw.col.close()


def test_changed_profile_or_connection_discards_fetch(server, tmp_path, monkeypatch):
    mw = window(tmp_path, server)
    collection = mw.col
    try:
        queries, mutations = queued_operations(monkeypatch)
        delivery = ui.BatchDelivery(collection)
        delivery.check(mw)
        mw.col = object()
        queries[0]["success"](server.store.snapshot())
        assert not mutations and delivery.snapshot is None
        mw.col = collection
        delivery.last_fetch = float("-inf")
        delivery.check(mw)
        monkeypatch.setenv(
            "LEARNRECUR_COMPANION_TOKEN", "different-test-token-123456789012345"
        )
        queries[1]["success"](server.store.snapshot())
        assert not mutations and delivery.snapshot is None
    finally:
        collection.close()


@pytest.mark.parametrize("configured", [True, False])
def test_ordinary_profile_does_not_download(server, tmp_path, monkeypatch, configured):
    col = Collection(str(tmp_path / "ordinary.anki2"))
    try:
        if not configured:
            monkeypatch.delenv("LEARNRECUR_COMPANION_TOKEN")
        queries, _ = queued_operations(monkeypatch)
        ui.BatchDelivery(col).check(SimpleNamespace(col=col, state="deckBrowser"))
        assert not queries
    finally:
        col.close()


def test_completed_fixture_batch_downloads_without_manual_import(server, tmp_path):
    from learnrecur.companion.jobs import FixtureProvider, Jobs

    mw = window(tmp_path, server)
    try:
        server.refill_provider = "fixture"
        jobs = Jobs(server.store)
        jobs.enqueue(
            {
                "request_id": "delivery",
                "skill_id": "spanish-ar-preterite-yo",
                "revision": 1,
                "count": 3,
            }
        )
        jobs.run_once(FixtureProvider())
        snapshot = ui.fetch_snapshot()
        before = mw.col.db.all("select * from cards")
        assert import_snapshot(mw.col, snapshot, cache_only=True).updated == 1
        assert mw.col.db.all("select * from cards") == before
        assert import_snapshot(mw.col, snapshot, cache_only=True).existing == 1
    finally:
        mw.col.close()


def test_unconfigured_response_and_failures_are_quiet_and_retryable(
    server, tmp_path, monkeypatch, capsys
):
    mw = window(tmp_path, server)
    try:
        queries, mutations = queued_operations(monkeypatch)
        now = [0]
        delivery = ui.BatchDelivery(mw.col, clock=lambda: now[0])
        delivery.check(mw)
        monkeypatch.delenv("LEARNRECUR_COMPANION_TOKEN")
        queries[0]["success"](server.store.snapshot())
        assert not mutations and not delivery.fetching
        monkeypatch.setenv(
            "LEARNRECUR_COMPANION_TOKEN", "delivery-test-token-123456789012345"
        )
        delivery.check(mw)
        assert len(queries) == 2
        queries[1]["runner"].failure.call_args.args[0](Exception("private detail"))
        assert "private detail" not in capsys.readouterr().out
        assert not delivery.fetching
        delivery.check(mw)
        assert len(queries) == 2
        now[0] = 60
        delivery.check(mw)
        assert len(queries) == 3
        queries[2]["success"](server.store.snapshot())
        mutations[0]["runner"].failure.call_args.args[0](Exception("private detail"))
        assert "private detail" not in capsys.readouterr().out
        assert not delivery.applying and delivery.snapshot is None
    finally:
        mw.col.close()


def test_queued_apply_cannot_write_another_profile(server, tmp_path, monkeypatch):
    mw = window(tmp_path, server)
    col = mw.col
    try:
        queries, mutations = queued_operations(monkeypatch)
        delivery = ui.BatchDelivery(col)
        delivery.check(mw)
        queries[0]["success"](server.store.snapshot())
        mw.col = object()
        assert not col.op_made_changes(mutations[0]["op"](mw.col))
    finally:
        col.close()


@pytest.mark.parametrize("change", ["none", "state", "deck", "profile"])
def test_study_waits_for_cache_write_and_cancels_after_navigation(
    server, tmp_path, monkeypatch, change
):
    mw = window(tmp_path, server)
    col = mw.col
    mw.progress = MagicMock()
    try:
        delivery = ui.BatchDelivery(col)
        resume = MagicMock()
        assert not delivery.defer_review(mw, resume)
        delivery.applying = True
        assert delivery.defer_review(mw, resume)
        resume.assert_not_called()
        delivery.finish_apply(mw)
        assert not delivery.applying
        if change == "state":
            mw.state = "review"
        elif change == "deck":
            monkeypatch.setattr(col.decks, "selected", lambda: -1)
        elif change == "profile":
            mw.col = object()
        mw.progress.single_shot.call_args.args[1]()
        assert resume.call_count == (1 if change == "none" else 0)
    finally:
        col.close()


def test_main_window_defers_review_before_cleanup(monkeypatch):
    from aqt.main import AnkiQt

    controller = MagicMock()
    controller.defer_review.return_value = True
    mw = SimpleNamespace(_batch_delivery=controller)
    AnkiQt.moveToState(mw, "review")
    controller.defer_review.assert_called_once()
