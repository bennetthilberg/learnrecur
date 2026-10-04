"""Creation resumes one request and keeps exercise inspection optional."""

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock
from uuid import uuid4

import pytest

import anki.lang
from anki.collection import Collection
from anki.learnrecur_skill_import import SkillImportError
from anki.learnrecur_skills import prepare_skill_answer, select_skill_review
from anki.scheduler.v3 import CardAnswer
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


def revise(dialog):
    value = json.loads(
        (
            Path(__file__).resolve().parents[2]
            / "learnrecur/fixtures/spanish-revision.json"
        ).read_text()
    )["skills"][0]
    dialog.description.setPlainText(value["description"])
    dialog.examples = [
        {"prompt": "Yo ___ ayer. (hablar)", "answer": "hablé", "explanation": "Use -é."}
    ]
    dialog.refresh_examples()


def rate_skill(col):
    col.decks.select(col.decks.id("LearnRecur skills"))
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


def test_edit_uses_same_form_and_preserves_review_history_undo_and_offline_review(
    app, server, monkeypatch, tmp_path
):
    queries, mutations = queues(monkeypatch)
    col = Collection(str(tmp_path / "synthetic.anki2"))
    ui.import_snapshot(col, server.store.snapshot())
    cid = rate_skill(col)
    before_cards = col.db.all("select * from cards")
    before_reviews = col.db.all("select * from revlog")
    old_exercise = select_skill_review(col.get_card(cid)).exercise
    target = ui.selected_skill(col, col.get_card(cid).nid)
    mw = window(server, col=col)
    dialog = ui.SkillEditor(mw, target)
    try:
        app.processEvents()
        receive(queries.pop(0))
        assert dialog.windowTitle() == "Edit skill"
        assert dialog.action.text() == "Save changes"
        assert dialog.title.text() == server.store.snapshot()["skills"][0]["title"]
        assert not dialog.action.isEnabled()
        revise(dialog)
        assert dialog.action.isEnabled()
        dialog.perform_action()
        receive(queries.pop(0))
        receive(queries.pop(0))
        assert not dialog.title.isEnabled() and not dialog.action.isEnabled()
        assert select_skill_review(col.get_card(cid)).exercise == old_exercise
        run_fixture(server)
        dialog.poll()
        receive(queries.pop(0))
        receive(queries.pop(0))
        mutation = mutations.pop(0)
        result = mutation["op"](col)
        assert (result.added, result.updated) == (0, 1)
        mutation["success"](result)
        assert dialog.windowTitle() == "Skill saved"
        assert dialog.action.text() == "Done"
        assert not dialog.preview_button.isHidden()
        assert not dialog.pages.currentWidget().findChildren(ui.QPlainTextEdit)
        assert col.card_count() == 1
        assert col.db.all("select * from cards") == before_cards
        assert col.db.all("select * from revlog") == before_reviews
        assert select_skill_review(col.get_card(cid)).exercise != old_exercise
        bank = json.loads(col.get_card(cid).note()["LearnRecurSkill"])
        assert bank["revision"] == 2 and len(bank["retired_revisions"]) == 1
        assert old_exercise.prompt not in [e["prompt"] for e in bank["exercises"]]
        col.undo()
        assert select_skill_review(col.get_card(cid)).exercise == old_exercise
        col.redo()
        col.close()
        col.reopen()
        assert json.loads(col.get_card(cid).note()["LearnRecurSkill"])["revision"] == 2
        assert col.db.all("select * from cards") == before_cards
        assert col.db.all("select * from revlog") == before_reviews
        rate_skill(col)
        assert len(col.db.all("select * from revlog")) == len(before_reviews) + 1
    finally:
        dialog.reject()
        col.close()


@pytest.mark.parametrize("commit_first", [False, True])
def test_closed_edit_resumes_original_job_and_updates_one_card(
    app, server, monkeypatch, tmp_path, commit_first
):
    queries, mutations = queues(monkeypatch)
    col = Collection(str(tmp_path / "synthetic.anki2"))
    ui.import_snapshot(col, server.store.snapshot())
    cid = rate_skill(col)
    before = col.db.all("select * from cards"), col.db.all("select * from revlog")
    mw = window(server, col=col)
    dialog = ui.SkillEditor(mw, ui.selected_skill(col, col.get_card(cid).nid))
    reopened = None
    try:
        app.processEvents()
        receive(queries.pop(0))
        revise(dialog)
        dialog.perform_action()
        receive(queries.pop(0))
        post = queries.pop(0)
        job = post["op"](None)
        if commit_first:
            post["success"](job)
            run_fixture(server)
            dialog.poll()
            receive(queries.pop(0))
            receive(queries.pop(0))
            mutation = mutations.pop(0)
            result = mutation["op"](col)
            dialog.reject()
            mutation["success"](result)
        else:
            dialog.reject()
            post["success"](job)
            run_fixture(server)
        saved = mw.pm.profile[ui.PENDING_KEY].copy()
        reopened = ui.SkillEditor(mw)
        app.processEvents()
        assert reopened.windowTitle() == "Edit skill"
        receive(queries.pop(0))
        receive(queries.pop(0))
        mutation = mutations.pop(0)
        mutation["success"](mutation["op"](col))
        assert reopened.added and ui.PENDING_KEY not in mw.pm.profile
        assert reopened.pending == saved
        assert (
            reopened.job_id == job["id"]
            and jobs(server).get(job["id"])["attempts"] == 1
        )
        assert col.card_count() == 1
        assert (
            col.db.all("select * from cards"),
            col.db.all("select * from revlog"),
        ) == before
    finally:
        dialog.reject()
        if reopened:
            reopened.reject()
        col.close()


def test_cancel_edit_does_not_publish_or_generate(app, server, monkeypatch, tmp_path):
    queries, mutations = queues(monkeypatch)
    col = Collection(str(tmp_path / "synthetic.anki2"))
    ui.import_snapshot(col, server.store.snapshot())
    mw = window(server, col=col)
    before = col.db.all("select * from notes"), server.store.snapshot()
    dialog = ui.SkillEditor(mw, ui.selected_skill(col, col.find_notes("")[0]))
    try:
        app.processEvents()
        receive(queries.pop(0))
        revise(dialog)
        dialog.reject()
        assert not queries and not mutations and ui.PENDING_KEY not in mw.pm.profile
        assert (col.db.all("select * from notes"), server.store.snapshot()) == before
        with server.store.connect() as db:
            assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 0
    finally:
        dialog.reject()
        col.close()


def test_missing_original_card_cannot_be_recreated_by_completed_edit(
    app, server, monkeypatch, tmp_path
):
    queries, mutations = queues(monkeypatch)
    col = Collection(str(tmp_path / "synthetic.anki2"))
    ui.import_snapshot(col, server.store.snapshot())
    cid = col.find_cards("")[0]
    mw = window(server, col=col)
    dialog = ui.SkillEditor(mw, ui.selected_skill(col, col.get_card(cid).nid))
    try:
        app.processEvents()
        receive(queries.pop(0))
        revise(dialog)
        dialog.perform_action()
        receive(queries.pop(0))
        receive(queries.pop(0))
        run_fixture(server)
        dialog.poll()
        receive(queries.pop(0))
        receive(queries.pop(0))
        col.remove_notes([col.get_card(cid).nid])
        with pytest.raises(SkillImportError, match="missing"):
            mutations.pop(0)["op"](col)
        assert col.card_count() == 0
        assert ui.PENDING_KEY in mw.pm.profile
    finally:
        dialog.reject()
        col.close()


def test_definition_load_failure_can_retry_and_preserves_saved_examples(
    app, server, monkeypatch, tmp_path
):
    queries, mutations = queues(monkeypatch)
    col = Collection(str(tmp_path / "synthetic.anki2"))
    ui.import_snapshot(col, server.store.snapshot())
    target = ui.selected_skill(col, col.find_notes("")[0])
    mw = window(server, col=col)
    dialog = ui.SkillEditor(mw, target)
    try:
        app.processEvents()
        queries.pop(0)["failure"](SkillImportError("Could not reach the companion."))
        assert dialog.action.isEnabled()
        dialog.perform_action()
        receive(queries.pop(0))
        revise(dialog)
        dialog.perform_action()
        receive(queries.pop(0))
        receive(queries.pop(0))
        run_fixture(server)
        dialog.poll()
        receive(queries.pop(0))
        receive(queries.pop(0))
        mutation = mutations.pop(0)
        mutation["success"](mutation["op"](col))
        expected = dialog.examples.copy()
        dialog.reject()
        reopened = ui.SkillEditor(mw, ui.selected_skill(col, col.find_notes("")[0]))
        try:
            app.processEvents()
            receive(queries.pop(0))
            assert reopened.examples == expected
            assert not reopened.example_list.selectedItems()
            assert not reopened.action.isEnabled()
        finally:
            reopened.reject()
    finally:
        dialog.reject()
        col.close()


def test_pending_creation_is_resumed_even_when_opened_from_edit_menu(
    app, server, monkeypatch
):
    queries, mutations = queues(monkeypatch)
    saved = payload(server)
    mw = window(server, profile={ui.PENDING_KEY: saved})
    dialog = ui.SkillEditor(
        mw,
        {
            "source_id": saved["source_id"],
            "skill_id": "other-skill",
            "base_revision": 1,
        },
    )
    try:
        assert not dialog.editing
        assert dialog.windowTitle() == "Add skill"
        app.processEvents()
        receive(queries.pop(0))
        assert dialog.pending == saved
        assert (
            jobs(server).get(dialog.job_id)["request"]["skill_id"]
            == "skill-" + saved["request_id"]
        )
    finally:
        dialog.reject()
