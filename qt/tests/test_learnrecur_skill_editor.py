"""Creation resumes one request and keeps exercise inspection optional."""

from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

import anki.lang
from anki.collection import Collection
from anki.learnrecur_skill_import import SkillImportError
from aqt import gui_hooks
from aqt import learnrecur_skill_editor as ui
from aqt.qt import QApplication, QLabel, Qt, QWidget
from tests.test_learnrecur_import import server

__all__ = ["server"]


@pytest.fixture
def app():
    anki.lang.set_lang("en_US")
    return QApplication.instance() or QApplication([])


def jobs(server):
    from learnrecur.companion.jobs import Jobs

    return Jobs(server.store)


def run_fixture(server):
    from learnrecur.companion.jobs import FixtureProvider

    jobs(server).run_once(FixtureProvider())


def payload(server):
    skill = server.store.snapshot()["skills"][0]
    return {
        "request_id": uuid4().hex,
        "source_id": server.store.snapshot()["source_id"],
        "title": "Spanish preterite",
        "description": skill["description"],
        "examples": [],
    }


def window(server, profile=None, col=None):
    mw = QWidget()
    mw.col = col or object()
    mw.pm = SimpleNamespace(
        profile=profile if profile is not None else {}, save=MagicMock()
    )
    mw.state = "deckBrowser"
    server.refill_provider = "fixture"
    return mw


def queues(monkeypatch):
    queries, mutations = [], []

    def operation(queue, **kwargs):
        queue.append(kwargs)
        mock = MagicMock()

        def callback(name, function):
            kwargs[name] = function
            return mock

        mock.failure.side_effect = lambda function: callback("failure", function)
        mock.success.side_effect = lambda function: callback("success", function)
        mock.without_collection.return_value = mock
        kwargs["runner"] = mock
        return mock

    monkeypatch.setattr(ui, "QueryOp", lambda **kwargs: operation(queries, **kwargs))
    monkeypatch.setattr(
        ui, "CollectionOp", lambda **kwargs: operation(mutations, **kwargs)
    )
    return queries, mutations


def receive(query):
    query["success"](query["op"](None))


def test_authenticated_creation_retries_one_request_after_lost_ack(server, monkeypatch):
    server.refill_provider = "fixture"
    value = payload(server)
    connection = ui.companion_connection()
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:1")
    created = ui.request_job(connection, value)
    retried = ui.request_job(connection, value)
    assert created["id"] == retried["id"]
    run_fixture(server)
    assert ui.request_job(connection, value, created["id"])["state"] == "completed"
    with server.store.connect() as db:
        assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 1


def test_reject_disabled_creation_and_token_without_exposing_private_error(
    server, monkeypatch
):
    connection = ui.companion_connection()
    with pytest.raises(SkillImportError, match="not enabled"):
        ui.request_job(connection, payload(server))
    server.refill_provider = "fixture"
    with pytest.raises(SkillImportError, match="rejected"):
        ui.request_job(
            (connection[0], "wrong-token-with-more-than-32-characters"), payload(server)
        )


def test_generated_preview_filters_unrelated_skills_and_imports_once(server, tmp_path):
    server.refill_provider = "fixture"
    value = payload(server)
    created = ui.request_job(ui.companion_connection(), value)
    run_fixture(server)
    snapshot = ui.creation_snapshot(ui.fetch_snapshot(), value)
    assert len(snapshot["skills"]) == len(snapshot["identities"]) == 1
    col = Collection(str(tmp_path / "synthetic.anki2"))
    try:
        assert ui.import_snapshot(col, snapshot).added == 1
        before = col.db.all("select * from cards")
        assert ui.import_snapshot(col, snapshot).existing == 1
        assert col.db.all("select * from cards") == before
        assert jobs(server).get(created["id"])["attempts"] == 1
        changed = {**value, "description": "Other skill"}
        with pytest.raises(SkillImportError, match="missing or changed"):
            ui.creation_snapshot(snapshot, changed)
    finally:
        col.close()


def test_form_has_accessible_fields_and_disables_incomplete_submission(
    app, server, monkeypatch
):
    queues(monkeypatch)
    mw = window(server)
    dialog = ui.SkillEditor(mw)
    try:
        headers = dialog.findChildren(ui.FieldHeader)
        assert [header.text() for header in headers] == [
            "&Title",
            "&Description",
            "Examples (optional)",
        ]
        assert all(
            header.focusPolicy() == Qt.FocusPolicy.StrongFocus for header in headers
        )
        assert not [label for label in dialog.findChildren(QLabel) if label.text()]
        assert dialog.title.accessibleName() == "Title"
        assert dialog.description.accessibleName() == "Description"
        assert dialog.description.tabChangesFocus()
        assert dialog.status.isHidden()
        assert dialog.windowModality() == Qt.WindowModality.NonModal
        assert dialog.parent() is None
        assert not dialog.example_list.isHidden()
        assert dialog.example_list.item(0).text() == "No examples"
        assert not dialog.edit_example_button.isEnabled()
        assert not dialog.remove_example_button.isEnabled()
        assert dialog.add_example_button.text() == "Add example…"
        assert not dialog.action.isEnabled()
        dialog.title.setText("Spanish preterite")
        dialog.description.setPlainText(payload(server)["description"])
        assert dialog.action.isEnabled()
    finally:
        dialog.reject()


def test_examples_require_selection_even_after_keyboard_focus_or_removal(
    app, server, monkeypatch
):
    queues(monkeypatch)
    dialog = ui.SkillEditor(window(server))
    try:
        dialog.examples = [
            {"prompt": "First", "answer": "One", "explanation": "First answer"},
            {"prompt": "Second", "answer": "Two", "explanation": "Second answer"},
        ]
        dialog.refresh_examples()
        assert not dialog.example_list.selectedItems()
        assert not dialog.edit_example_button.isEnabled()
        assert not dialog.remove_example_button.isEnabled()
        dialog.example_list.setCurrentRow(0)
        assert dialog.edit_example_button.isEnabled()
        assert dialog.remove_example_button.isEnabled()
        dialog.example_list.clearSelection()
        dialog.remove_example()
        assert len(dialog.examples) == 2
        assert not dialog.edit_example_button.isEnabled()
        assert not dialog.remove_example_button.isEnabled()
        dialog.example_list.setCurrentRow(1)
        dialog.remove_example()
        assert len(dialog.examples) == 1
        assert not dialog.example_list.selectedItems()
        assert not dialog.edit_example_button.isEnabled()
        assert not dialog.remove_example_button.isEnabled()
    finally:
        dialog.reject()


def test_profile_close_closes_the_independent_editor_and_preserves_request(
    app, server, monkeypatch
):
    queues(monkeypatch)
    saved = payload(server)
    mw = window(server, profile={ui.PENDING_KEY: saved})
    dialog = ui.SkillEditor(mw)
    gui_hooks.profile_will_close()
    assert dialog.closed and not dialog.timer.isActive()
    assert mw.pm.profile[ui.PENDING_KEY] == saved
    assert dialog.reject not in gui_hooks.profile_will_close._hooks


def test_cancel_before_request_leaves_no_draft_or_card(app, server, monkeypatch):
    queries, mutations = queues(monkeypatch)
    mw = window(server)
    dialog = ui.SkillEditor(mw)
    dialog.reject()
    assert dialog.closed
    assert not queries and not mutations and ui.PENDING_KEY not in mw.pm.profile


def test_close_after_submission_and_reopen_recovers_same_job(app, server, monkeypatch):
    queries, mutations = queues(monkeypatch)
    mw = window(server)
    dialog = ui.SkillEditor(mw)
    dialog.title.setText("Spanish preterite")
    dialog.description.setPlainText(payload(server)["description"])
    dialog.perform_action()
    assert not dialog.title.isEnabled() and not dialog.description.isEnabled()
    assert not dialog.action.isEnabled()
    assert not dialog.progress.isHidden()
    receive(queries.pop(0))
    request = mw.pm.profile[ui.PENDING_KEY].copy()
    post = queries.pop(0)
    job = post["op"](None)
    dialog.reject()  # The successful POST reply arrives after the window closes.
    post["success"](job)
    assert not mutations and mw.pm.profile[ui.PENDING_KEY] == request
    run_fixture(server)
    reopened = ui.SkillEditor(mw)
    try:
        app.processEvents()
        assert len(queries) == 1
        receive(queries.pop(0))
        assert reopened.job_id == job["id"]
        receive(queries.pop(0))
        assert len(mutations) == 1
        assert reopened.pages.currentIndex() == 0
        assert not reopened.action.isEnabled()
        assert reopened.preview_button.isHidden()
    finally:
        reopened.reject()


@pytest.mark.parametrize("change", ["profile", "connection", "close"])
def test_late_handshake_never_posts_after_context_changes(
    app, server, monkeypatch, change
):
    queries, mutations = queues(monkeypatch)
    mw = window(server)
    dialog = ui.SkillEditor(mw)
    dialog.title.setText("Spanish preterite")
    dialog.description.setPlainText(payload(server)["description"])
    dialog.perform_action()
    query = queries.pop(0)
    snapshot = query["op"](None)
    if change == "profile":
        mw.col = object()
    elif change == "connection":
        monkeypatch.setenv(
            "LEARNRECUR_COMPANION_TOKEN", "changed-token-12345678901234567890"
        )
    else:
        dialog.reject()
    query["success"](snapshot)
    assert not queries and not mutations
    assert ui.PENDING_KEY not in mw.pm.profile
    dialog.reject()


def test_native_add_checks_profile_again_when_queued(
    app, server, monkeypatch, tmp_path
):
    queries, mutations = queues(monkeypatch)
    col = Collection(str(tmp_path / "synthetic.anki2"))
    mw = window(server, col=col)
    value = payload(server)
    jobs(server).create_skill(value, "fixture")
    run_fixture(server)
    dialog = ui.SkillEditor(mw)
    try:
        dialog.pending = value
        dialog.generated(ui.creation_snapshot(server.store.snapshot(), value))
        assert len(mutations) == 1
        mw.col = object()
        with pytest.raises(SkillImportError, match="profile changed"):
            mutations[0]["op"](mw.col)
        assert col.card_count() == 0
    finally:
        dialog.reject()
        col.close()


def test_completion_adds_one_card_without_revealing_exercises(
    app, server, monkeypatch, tmp_path
):
    queries, mutations = queues(monkeypatch)
    col = Collection(str(tmp_path / "synthetic.anki2"))
    mw = window(server, col=col)
    dialog = ui.SkillEditor(mw)
    try:
        value = payload(server)
        dialog.title.setText(value["title"])
        dialog.description.setPlainText(value["description"])
        dialog.perform_action()
        receive(queries.pop(0))
        receive(queries.pop(0))
        assert dialog.timer.isActive()
        assert not dialog.title.isEnabled()
        assert not dialog.action.isEnabled()
        assert dialog.status.isHidden()
        run_fixture(server)
        dialog.poll()
        receive(queries.pop(0))
        receive(queries.pop(0))
        mutation = mutations.pop(0)
        mutation["success"](mutation["op"](col))
        assert col.card_count() == 1
        assert ui.PENDING_KEY not in mw.pm.profile
        assert not dialog.closed
        assert dialog.added
        assert dialog.pages.currentIndex() == 1
        assert dialog.action.text() == "Add another skill"
        assert not dialog.preview_button.isHidden()
        assert dialog.new_button.isHidden()
        assert dialog.progress.isHidden()
        assert not dialog.pages.currentWidget().findChildren(ui.QPlainTextEdit)
        snapshot = dialog.snapshot
        preview = ui.ExercisePreview(dialog, snapshot)
        assert len(preview.findChildren(ui.QTabWidget)) == 1
        assert not preview.findChildren(ui.QLineEdit)
        preview.reject()
        dialog.perform_action()
        assert col.card_count() == 1
        assert dialog.action.text() == "Add skill"
        assert not dialog.title.text()
        assert dialog.title.isEnabled()
        assert dialog.preview_button.isHidden()
        assert not queries and not mutations
        # Retrying the completed request after a crash finds the same card.
        assert ui.import_snapshot(col, snapshot).existing == 1
        assert col.card_count() == 1
    finally:
        dialog.reject()
        col.close()


def test_close_after_card_commit_recovers_without_another_card_or_job(
    app, server, monkeypatch, tmp_path
):
    queries, mutations = queues(monkeypatch)
    col = Collection(str(tmp_path / "synthetic.anki2"))
    value = payload(server)
    mw = window(server, profile={ui.PENDING_KEY: value}, col=col)
    job = jobs(server).create_skill(value, "fixture")
    run_fixture(server)
    dialog = ui.SkillEditor(mw)
    reopened = None
    try:
        app.processEvents()
        receive(queries.pop(0))
        receive(queries.pop(0))
        mutation = mutations.pop(0)
        result = mutation["op"](col)
        dialog.reject()
        mutation["success"](result)
        assert mw.pm.profile[ui.PENDING_KEY] == value
        assert col.card_count() == 1
        reopened = ui.SkillEditor(mw)
        app.processEvents()
        receive(queries.pop(0))
        receive(queries.pop(0))
        mutation = mutations.pop(0)
        mutation["success"](mutation["op"](col))
        assert reopened.added
        assert ui.PENDING_KEY not in mw.pm.profile
        assert col.card_count() == 1
        assert reopened.job_id == job["id"]
        assert jobs(server).get(job["id"])["attempts"] == 1
    finally:
        dialog.reject()
        if reopened:
            reopened.reject()
        col.close()


def test_budget_wait_stops_animation_and_keeps_the_saved_request(
    app, server, monkeypatch
):
    queues(monkeypatch)
    mw = window(server)
    dialog = ui.SkillEditor(mw)
    try:
        value = payload(server)
        dialog.pending = value
        mw.pm.profile[ui.PENDING_KEY] = value
        dialog.freeze(True)
        dialog.processing("Generating…")
        dialog.received_job({"id": uuid4().hex, "state": "waiting_budget"})
        assert dialog.progress.isHidden()
        assert not dialog.timer.isActive()
        assert dialog.action.isEnabled()
        assert dialog.status.text() == "Waiting for budget."
        assert mw.pm.profile[ui.PENDING_KEY] == value
        assert dialog.new_button.isHidden()
        assert not dialog.title.isEnabled()
    finally:
        dialog.reject()


def test_example_form_has_required_fields_and_focus_navigation(app):
    parent = QWidget()
    dialog = ui.ExampleDialog(parent)
    try:
        assert len(dialog.fields) == 3
        for key, field in dialog.fields.items():
            assert field.tabChangesFocus()
            field.setPlainText("Example " + key)
        assert dialog.example() == {key: "Example " + key for key in dialog.fields}
        assert all(
            field.accessibleName() == key.capitalize()
            for key, field in dialog.fields.items()
        )
    finally:
        dialog.reject()
