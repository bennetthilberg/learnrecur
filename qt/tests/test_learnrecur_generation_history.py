"""History cannot submit work, reveal exercises, or outlive its profile."""

import copy
from unittest.mock import MagicMock
from uuid import uuid4

import pytest
import requests

import anki.lang
from anki.collection import Collection
from anki.learnrecur_skill_import import SkillImportError, import_snapshot
from aqt import gui_hooks
from aqt import learnrecur_generation_history as ui
from aqt.qt import QApplication, QWidget
from learnrecur.companion.jobs import Jobs
from tests.test_learnrecur_import import server

__all__ = ["server"]


@pytest.fixture
def app():
    anki.lang.set_lang("en_US")
    return QApplication.instance() or QApplication([])


def enqueue(server, count=1):
    jobs = Jobs(server.store)
    skill = server.store.snapshot()["skills"][0]
    for _ in range(count):
        jobs.enqueue(
            {
                "request_id": uuid4().hex,
                "skill_id": skill["id"],
                "revision": 1,
                "count": 1,
            }
        )


def window(col=None):
    mw = QWidget()
    mw.col = col if col is not None else object()
    return mw


def queries(monkeypatch):
    queue = []

    def query(**kwargs):
        queue.append(kwargs)
        runner = MagicMock()
        kwargs["runner"] = runner
        runner.failure.side_effect = lambda callback: (
            kwargs.update(failure=callback) or runner
        )
        runner.without_collection.return_value = runner
        return runner

    monkeypatch.setattr(ui, "QueryOp", query)
    return queue


def receive(query):
    query["success"](query["op"](None))


def test_native_read_only_table_does_not_submit_jobs_or_change_cards(
    app, server, tmp_path, monkeypatch
):
    enqueue(server)
    queue = queries(monkeypatch)
    col = Collection(str(tmp_path / "synthetic.anki2"))
    import_snapshot(col, server.store.snapshot())
    cards = col.db.all("select * from cards")
    reviews = col.db.all("select * from revlog")
    with server.store.connect() as db:
        before = list(db.iterdump())
    monkeypatch.setattr(
        Jobs, "enqueue", lambda *_: pytest.fail("History submitted a job")
    )
    monkeypatch.setattr(Jobs, "claim", lambda *_: pytest.fail("History ran generation"))
    dialog = ui.GenerationHistory(window(col))
    try:
        receive(queue.pop(0))
        dialog.load("refresh")
        request = queue.pop(0)
        request["runner"].without_collection.assert_called_once()
        receive(request)
        assert dialog.table.topLevelItemCount() == 1
        item = dialog.table.topLevelItem(0)
        assert [item.text(i) for i in range(1, 6)] == [
            "Refill",
            "Waiting",
            "0",
            "$0.00",
            "$0.00",
        ]
        assert item.data(0, ui.Qt.ItemDataRole.UserRole) == ""
        assert not dialog.table.selectedItems()
        assert (
            dialog.table.editTriggers()
            == ui.QAbstractItemView.EditTrigger.NoEditTriggers
        )
        assert dialog.table.accessibleName() == "Generation history"
        assert col.db.all("select * from cards") == cards
        assert col.db.all("select * from revlog") == reviews
        with server.store.connect() as db:
            assert list(db.iterdump()) == before
    finally:
        dialog.reject()
        col.close()


def test_paging_replaces_rows_and_refresh_returns_to_newest(app, server, monkeypatch):
    enqueue(server, 51)
    queue = queries(monkeypatch)
    dialog = ui.GenerationHistory(window())
    try:
        receive(queue.pop(0))
        assert dialog.table.topLevelItemCount() == 50
        assert dialog.older_button.isEnabled() and not dialog.newer_button.isEnabled()
        dialog.older_button.click()
        receive(queue.pop(0))
        assert dialog.table.topLevelItemCount() == 1
        assert not dialog.older_button.isEnabled() and dialog.newer_button.isEnabled()
        dialog.newer_button.click()
        receive(queue.pop(0))
        assert dialog.table.topLevelItemCount() == 50
        dialog.older_button.click()
        receive(queue.pop(0))
        dialog.refresh_button.click()
        receive(queue.pop(0))
        assert dialog.table.topLevelItemCount() == 50
        assert dialog.cursors == [None]
    finally:
        dialog.reject()


def test_selected_failure_and_reservations_are_plain_text(app, server, monkeypatch):
    enqueue(server)
    with server.store.connect() as db:
        db.execute(
            "update generation_jobs set state='needs_attention',error='private provider output'"
        )
    queue = queries(monkeypatch)
    dialog = ui.GenerationHistory(window())
    try:
        receive(queue.pop(0))
        item = dialog.table.topLevelItem(0)
        assert item.text(2) == "Needs attention"
        dialog.table.setCurrentItem(item)
        assert "unconfirmed" in dialog.detail.text()
        assert "private" not in dialog.detail.text()
        assert dialog.detail.textFormat() == ui.Qt.TextFormat.PlainText
        assert "estimated spend" in dialog.budget.text()
        assert "not confirmed charges" in dialog.budget.toolTip()
        assert ui.dollars(2637) == "$0.002637"
        assert ui.dollars(5_000_000) == "$5.00"
        assert ui.dollars(100_000) == "$0.10"
    finally:
        dialog.reject()


def test_disconnect_retains_visible_rows_as_stale_and_refresh_clears_warning(
    app, server, monkeypatch
):
    enqueue(server)
    queue = queries(monkeypatch)
    dialog = ui.GenerationHistory(window())
    try:
        receive(queue.pop(0))
        dialog.refresh_button.click()
        queue.pop(0)["failure"](Exception("private token or provider response"))
        assert dialog.table.topLevelItemCount() == 1
        assert "out of date" in dialog.status.text()
        assert "private" not in dialog.status.text()
        assert dialog.refresh_button.isEnabled()
        dialog.refresh_button.click()
        receive(queue.pop(0))
        assert dialog.status.isHidden()
    finally:
        dialog.reject()


def test_profile_close_discards_late_success_and_failure(app, server, monkeypatch):
    queue = queries(monkeypatch)
    dialog = ui.GenerationHistory(window())
    request = queue.pop(0)
    result = request["op"](None)
    gui_hooks.profile_will_close()
    assert dialog.closed
    request["success"](result)
    request["failure"](Exception("private"))
    assert dialog.table.topLevelItemCount() == 0
    assert dialog.reject not in gui_hooks.profile_will_close._hooks


@pytest.mark.parametrize("change", ["profile", "connection"])
def test_late_results_cannot_cross_profiles_or_connections(
    app, server, monkeypatch, change
):
    enqueue(server)
    queue = queries(monkeypatch)
    mw = window()
    dialog = ui.GenerationHistory(mw)
    try:
        receive(queue.pop(0))
        dialog.refresh_button.click()
        request = queue.pop(0)
        result = request["op"](None)
        if change == "profile":
            mw.col = object()
        else:
            monkeypatch.setenv(
                "LEARNRECUR_COMPANION_TOKEN",
                "another-synthetic-token-with-32-characters",
            )
        request["success"](result)
        if change == "profile":
            assert dialog.closed
        else:
            assert dialog.table.topLevelItemCount() == 0 and not dialog.budget.text()
            assert "connection changed" in dialog.status.text()
            assert not dialog.refresh_button.isEnabled()
    finally:
        if not dialog.closed:
            dialog.reject()


def test_paging_cannot_mix_different_companion_sources(app, server, monkeypatch):
    enqueue(server, 51)
    queue = queries(monkeypatch)
    dialog = ui.GenerationHistory(window())
    try:
        receive(queue.pop(0))
        with server.store.connect() as db:
            db.execute(
                "update metadata set value=? where key='source_id'", (str(uuid4()),)
            )
        dialog.older_button.click()
        receive(queue.pop(0))
        assert dialog.table.topLevelItemCount() == 0
        assert "companion changed" in dialog.status.text()
        assert dialog.refresh_button.isEnabled() and not dialog.older_button.isEnabled()
        dialog.refresh_button.click()
        receive(queue.pop(0))
        assert dialog.table.topLevelItemCount() == 50
    finally:
        dialog.reject()


def test_fetch_ignores_proxies_and_sanitizes_connection_errors(server, monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:1")
    monkeypatch.delenv("NO_PROXY", raising=False)
    assert ui.fetch_history(ui.companion_connection())["jobs"] == []

    def failed(*_args, **_kwargs):
        raise requests.ConnectionError("private credential or URL")

    monkeypatch.setattr(requests.Session, "get", failed)
    with pytest.raises(SkillImportError, match="Could not reach") as error:
        ui.fetch_history(ui.companion_connection())
    assert "private" not in str(error.value)


def test_redirect_is_not_followed_or_treated_as_history(server, monkeypatch):
    session = MagicMock()
    session.__enter__.return_value = session
    response = session.get.return_value.__enter__.return_value
    response.status_code = 302
    monkeypatch.setattr(ui.requests, "Session", lambda: session)
    with pytest.raises(SkillImportError, match="could not provide"):
        ui.fetch_history(ui.companion_connection())
    assert session.get.call_count == 1
    assert session.get.call_args.kwargs["allow_redirects"] is False
    assert session.trust_env is False


@pytest.mark.parametrize(
    "damage", ["exercise_content", "cost", "duplicate_job", "oversized_page", "cursor"]
)
def test_invalid_history_is_rejected_before_rendering(server, damage):
    enqueue(server)
    value = copy.deepcopy(Jobs(server.store).history())
    if damage == "exercise_content":
        value["jobs"][0]["answer"] = "private answer"
    elif damage == "cost":
        value["jobs"][0]["reserved_microusd"] = -1
    elif damage == "duplicate_job":
        value["jobs"].append(value["jobs"][0])
    elif damage == "oversized_page":
        value["jobs"] = [{**value["jobs"][0], "id": uuid4().hex} for _ in range(51)]
    else:
        value["next_before"] = 0
    with pytest.raises(SkillImportError, match="invalid generation history"):
        ui.validate_history(value)


def test_empty_history_has_no_navigation_or_edit_actions(app, server, monkeypatch):
    queue = queries(monkeypatch)
    dialog = ui.GenerationHistory(window())
    try:
        receive(queue.pop(0))
        assert dialog.status.text() == "No generation jobs."
        assert (
            not dialog.newer_button.isEnabled() and not dialog.older_button.isEnabled()
        )
        assert dialog.refresh_button.isEnabled()
    finally:
        dialog.reject()
