"""Check confirmation, profile guards, and safe local companion fetching."""

import json
import runpy
import threading
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from anki.learnrecur_skill_import import SkillImportError
from aqt import learnrecur_import as ui

ROOT = Path(__file__).resolve().parents[2]
TOKEN = "synthetic-test-token-not-a-secret-12345"


@pytest.fixture
def server(tmp_path, monkeypatch):
    module = runpy.run_path(str(ROOT / "learnrecur/companion/server.py"))
    server = module["Server"](module["Store"](tmp_path / "companion"), TOKEN, 0)
    server.store.import_batch(
        json.loads((ROOT / "learnrecur/fixtures/spanish-import.json").read_text())
    )
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    monkeypatch.setenv(
        "LEARNRECUR_COMPANION_URL", f"http://127.0.0.1:{server.server_port}"
    )
    monkeypatch.setenv("LEARNRECUR_COMPANION_TOKEN", TOKEN)
    yield server
    server.shutdown()
    server.server_close()
    thread.join()


def test_fetch_uses_auth_and_ignores_proxy_settings(server, monkeypatch):
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:1")
    monkeypatch.delenv("NO_PROXY", raising=False)
    assert len(ui.fetch_snapshot()["skills"]) == 1
    monkeypatch.setenv(
        "LEARNRECUR_COMPANION_TOKEN", "wrong-token-with-more-than-32-characters"
    )
    with pytest.raises(SkillImportError, match="rejected"):
        ui.fetch_snapshot()


@pytest.mark.parametrize(
    "url",
    [
        "https://example.com",
        "http://localhost:45321",
        "http://127.0.0.1:65536",
        "http://127.0.0.1:45321@evil.example",
        "http://127.0.0.1:45321/path",
    ],
)
def test_reject_nonlocal_or_ambiguous_urls(monkeypatch, url):
    monkeypatch.setenv("LEARNRECUR_COMPANION_URL", url)
    session = MagicMock()
    monkeypatch.setattr(ui.requests, "Session", session)
    with pytest.raises(SkillImportError, match="local"):
        ui.fetch_snapshot()
    session.assert_not_called()


def test_redirects_do_not_forward_credentials(server, monkeypatch):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

    class Redirect(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header("Location", "http://127.0.0.1:1/v1/skills")
            self.end_headers()

        def log_message(self, *args):
            pass

    redirect = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
    thread = threading.Thread(target=redirect.serve_forever)
    thread.start()
    try:
        monkeypatch.setenv(
            "LEARNRECUR_COMPANION_URL", f"http://127.0.0.1:{redirect.server_port}"
        )
        with pytest.raises(SkillImportError, match="could not provide"):
            ui.fetch_snapshot()
    finally:
        redirect.shutdown()
        redirect.server_close()
        thread.join()


@pytest.mark.parametrize("action", ["cancel", "accept", "profile_change", "review"])
def test_only_confirmed_import_queues_collection_operation(monkeypatch, action):
    snapshot = {
        "source_id": "5528c1f8-2792-4e70-8a47-75d48c397e02",
        **json.loads((ROOT / "learnrecur/fixtures/spanish-import.json").read_text()),
    }
    mw = SimpleNamespace(
        state="review" if action == "review" else "deckBrowser", col=object()
    )
    queued = []
    operations = []

    def query(**kwargs):
        queued.append(kwargs)
        return MagicMock()

    def mutation(**kwargs):
        operations.append(kwargs)
        return MagicMock()

    monkeypatch.setattr(ui, "QueryOp", query)
    monkeypatch.setattr(ui, "CollectionOp", mutation)
    monkeypatch.setattr(ui, "confirm_import", lambda *_: action != "cancel")
    monkeypatch.setattr(ui, "showWarning", MagicMock())
    ui.import_skills(mw)
    if action == "review":
        assert not queued
        ui.showWarning.assert_called_once()
        return
    if action == "profile_change":
        mw.col = object()
    queued[0]["success"](snapshot)
    assert bool(operations) == (action == "accept")
    if action == "accept":
        mw.col = object()
        with pytest.raises(SkillImportError, match="profile changed"):
            operations[0]["op"](mw.col)


def test_old_companion_cannot_create_unsynchronized_identities(server, monkeypatch):
    snapshot = server.store.snapshot()
    del snapshot["identities"]
    monkeypatch.setattr(server.store, "snapshot", lambda: snapshot)
    with pytest.raises(SkillImportError, match="Update the local companion"):
        ui.fetch_snapshot()
