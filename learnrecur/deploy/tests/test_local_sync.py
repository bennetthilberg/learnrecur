"""Exercise the matching standalone server with disposable native collections."""

import copy
import json
import os
import socket
import sqlite3
import subprocess
import sys
import threading
import time
import zipfile
from contextlib import contextmanager
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

import pytest

from anki.collection import Collection
from anki.learnrecur_skill_import import DECK_NAME, import_snapshot
from anki.learnrecur_skills import prepare_skill_answer, select_skill_review
from anki.scheduler.v3 import CardAnswer
from anki.sync import SyncOutput
from learnrecur.companion.server import Server, Store

ROOT = Path(__file__).resolve().parents[3]
TOKEN = "synthetic-test-token-not-a-secret-12345"


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class LocalServer:
    def __init__(self, folder):
        self.folder = folder
        self.port = free_port()
        self.endpoint = f"http://127.0.0.1:{self.port}/"
        self.process = None
        self.log = None

    def start(self):
        self.log = (self.folder.parent / "sync.log").open("ab")
        self.process = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "learnrecur/deploy/run_sync_server.py"),
                "--data-dir",
                str(self.folder),
                "--port",
                str(self.port),
            ],
            env={**os.environ, "LEARNRECUR_SYNC_ACCOUNT": "synthetic:synthetic-pass"},
            stdout=self.log,
            stderr=self.log,
        )
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError("The local sync process exited during startup.")
            try:
                with urlopen(self.endpoint + "health", timeout=0.2) as response:
                    assert response.status == 200
                return
            except OSError:
                time.sleep(0.05)
        raise RuntimeError("The local sync server did not become ready.")

    def stop(self, crash=False):
        if self.process:
            (self.process.kill if crash else self.process.terminate)()
            self.process.wait(timeout=5)
            self.process = None
        if self.log:
            self.log.close()
            self.log = None


@pytest.fixture
def server(tmp_path):
    binary = ROOT / "target/debug/anki-sync-server"
    assert binary.is_file(), (
        "Build the matching binary: cargo build -p anki-sync-server"
    )
    server = LocalServer(tmp_path / "sync")
    try:
        server.start()
        yield server
    finally:
        server.stop()


@pytest.fixture
def snapshot(tmp_path):
    store = Store(tmp_path / "companion")
    server = Server(store, TOKEN, 0)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    try:
        request = Request(
            f"http://127.0.0.1:{server.server_port}/v1/skills",
            data=(ROOT / "learnrecur/fixtures/spanish-import.json").read_bytes(),
            headers={
                "Content-Type": "application/json",
                "Authorization": "Bearer " + TOKEN,
            },
        )
        with urlopen(request, timeout=5) as response:
            first = json.load(response)
        assert Store(store.path.parent).snapshot() == first
        yield first
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


@contextmanager
def collections(tmp_path):
    cols = []
    try:
        for name in ("profile-a", "profile-b"):
            folder = tmp_path / name
            folder.mkdir()
            cols.append(Collection(str(folder / "collection.anki2")))
        yield cols
    finally:
        for col in cols:
            col.close()


def full_sync(col, auth, upload):
    col.close_for_full_sync()
    try:
        col.full_upload_or_download(auth=auth, server_usn=None, upload=upload)
    finally:
        col.reopen(after_full_sync=True)


def sync(col, auth):
    result = col.sync_collection(auth, False)
    col.models._clear_cache()
    assert result.required == SyncOutput.NO_CHANGES


def media_sync(col, auth):
    col.sync_media(auth)
    deadline = time.monotonic() + 10
    while col.media_sync_status().active:
        assert time.monotonic() < deadline, "Media sync did not finish."
        time.sleep(0.02)


def bootstrap(a, b, server):
    auth = a.sync_login("synthetic", "synthetic-pass", server.endpoint)
    full_sync(a, auth, True)
    full_sync(b, auth, False)
    return auth


def rate(col, rating=CardAnswer.AGAIN):
    col.decks.select(col.decks.id(DECK_NAME))
    queued = col.sched.get_queued_cards().cards[0]
    card = col.get_card(queued.card.id)
    review = select_skill_review(card)
    card.start_timer()
    queued.states.current.custom_data = card.custom_data
    answer = col.sched.build_answer(card=card, states=queued.states, rating=rating)
    prepare_skill_answer(col, answer, review)
    col.sched.answer_card(answer)
    return card.id


def records(col):
    return col.db.all(
        "select id,cid,ease,ivl,lastIvl,factor,time,type from revlog order by id"
    )


def test_cards_media_offline_review_restart_and_retry(server, snapshot, tmp_path):
    with collections(tmp_path) as (a, b):
        import_snapshot(a, snapshot)
        ordinary = a.new_note(a.models.by_name("Basic"))
        ordinary["Front"] = 'Synthetic <b>ordinary</b> card <img src="sync.svg">'
        ordinary["Back"] = "A synthetic answer"
        a.add_note(ordinary, a.decks.id("Ordinary"))
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>'
        a.media.write_data("sync.svg", svg)
        auth = bootstrap(a, b, server)
        media_sync(a, auth)
        media_sync(b, auth)
        assert (Path(b.media.dir()) / "sync.svg").read_bytes() == svg
        assert b.get_note(ordinary.id).fields == ordinary.fields
        assert import_snapshot(b, snapshot).existing == 1
        skill_id = snapshot["identities"][snapshot["skills"][0]["id"]]["native_id"]
        assert a.get_card(skill_id).note().fields == b.get_card(skill_id).note().fields
        server.stop(crash=True)
        cid = rate(b)
        before = records(b)
        assert len(before) == 1
        assert select_skill_review(b.get_card(cid)).exercise.id == "trabajar"
        b.undo()
        assert records(b) == [] and b.get_card(cid).custom_data == ""
        b.redo()
        assert records(b) == before
        with pytest.raises(Exception):
            b.sync_collection(auth, False)
        assert records(b) == before
        b.close()
        b.reopen()
        assert records(b) == before
        server.start()
        sync(b, auth)
        sync(a, auth)
        assert records(a) == records(b) == before
        assert a.get_card(cid).custom_data == b.get_card(cid).custom_data
        assert a.get_card(cid).reps == b.get_card(cid).reps == 1
        assert import_snapshot(a, snapshot).existing == 1
        assert a.card_count() == b.card_count() == 2


def test_independent_imports_and_offline_reviews_share_one_card(
    server, snapshot, tmp_path
):
    with collections(tmp_path) as (a, b):
        # Share the schema first, as native sync requires for two clients.
        import_snapshot(a, snapshot)
        a.undo()
        auth = bootstrap(a, b, server)
        assert import_snapshot(a, snapshot).added == 1
        assert import_snapshot(b, snapshot).added == 1
        assert a.find_cards("") == b.find_cards("")
        # Both rate before connecting. Native sync retains both revlog rows;
        # card scheduling/custom data still follow Anki's last-modified rule.
        cid = rate(a)
        time.sleep(0.01)  # Revlog IDs are native millisecond timestamps.
        assert rate(b, CardAnswer.GOOD) == cid
        expected = sorted(records(a) + records(b))
        sync(a, auth)
        sync(b, auth)
        sync(a, auth)
        assert a.card_count() == b.card_count() == 1
        assert a.note_count() == b.note_count() == 1
        assert records(a) == records(b) == expected
        assert {row[1] for row in expected} == {cid}
        assert import_snapshot(a, snapshot).existing == 1
        assert import_snapshot(b, snapshot).existing == 1


class DisconnectProxy(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, target_port):
        self.target_port = target_port
        self.drop_finish = True
        self.dropped = threading.Event()
        super().__init__(("127.0.0.1", 0), ProxyHandler)


class ProxyHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        upstream = HTTPConnection("127.0.0.1", self.server.target_port, timeout=5)
        try:
            if self.headers.get("Transfer-Encoding") == "chunked":
                pieces = []
                while size := int(self.rfile.readline().split(b";", 1)[0], 16):
                    pieces.append(self.rfile.read(size))
                    assert self.rfile.read(2) == b"\r\n"
                while self.rfile.readline() != b"\r\n":
                    pass
                data = b"".join(pieces)
            else:
                data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            headers = {
                name: value
                for name, value in self.headers.items()
                if name.casefold() not in {"transfer-encoding", "content-length"}
            }
            upstream.request("POST", self.path, data, headers)
            response = upstream.getresponse()
            body = response.read()
            if self.path.endswith("/finish") and self.server.drop_finish:
                # The server committed, but the client never receives success.
                self.server.drop_finish = False
                self.server.dropped.set()
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.casefold() not in {
                    "transfer-encoding",
                    "connection",
                    "content-length",
                }:
                    self.send_header(name, value)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        finally:
            upstream.close()


def test_disconnect_after_sync_commit_recovers_without_duplicate_reviews(
    server, snapshot, tmp_path
):
    with collections(tmp_path) as (a, b):
        import_snapshot(a, snapshot)
        auth = bootstrap(a, b, server)
        cid = rate(b)
        expected = records(b)
        proxy = DisconnectProxy(server.port)
        thread = threading.Thread(target=proxy.serve_forever)
        thread.start()
        try:
            intercepted = type(auth)(
                hkey=auth.hkey, endpoint=f"http://127.0.0.1:{proxy.server_port}/"
            )
            with pytest.raises(Exception):
                b.sync_collection(intercepted, False)
            assert proxy.dropped.is_set(), (
                "The intended finish response was not interrupted."
            )
            assert records(b) == expected
        finally:
            proxy.shutdown()
            proxy.server_close()
            thread.join()
        server.stop(crash=True)
        b.close()
        b.reopen()
        server.start()
        sync(b, auth)
        sync(a, auth)
        assert records(a) == records(b) == expected
        assert a.card_count() == b.card_count() == 1
        assert a.get_card(cid).reps == b.get_card(cid).reps == 1
        assert import_snapshot(b, snapshot).existing == 1


@pytest.mark.parametrize("collision", ["note", "card"])
def test_incoming_identity_collision_preserves_both_profiles(
    server, snapshot, tmp_path, collision
):
    from anki.collection import AddNoteRequest

    with collections(tmp_path) as (a, b):
        auth = bootstrap(a, b, server)
        import_snapshot(a, snapshot)
        native_id = a.find_cards("")[0]
        model = copy.deepcopy(a.get_card(native_id).note_type())
        model["id"] = 0
        mid = b.models.add_dict(model).id
        different = b.new_note(b.models.get(mid))
        different.fields = a.get_card(native_id).note().fields.copy()
        different["Title"] = "A distinct synthetic note"
        different.id = native_id if collision == "note" else native_id + 100
        different.guid = "00000000000000000000000000000001"
        b.add_skill_notes(
            [AddNoteRequest(different, b.decks.id(DECK_NAME))], [native_id]
        )
        before_a = (
            a.get_card(native_id).note().guid,
            a.get_card(native_id).note().fields,
        )
        before_b = (
            b.get_card(native_id).note().guid,
            b.get_card(native_id).note().fields,
        )
        sync(a, auth)
        with pytest.raises(Exception, match="identity collision"):
            b.sync_collection(auth, False)
        assert (
            a.get_card(native_id).note().guid,
            a.get_card(native_id).note().fields,
        ) == before_a
        assert (
            b.get_card(native_id).note().guid,
            b.get_card(native_id).note().fields,
        ) == before_b
        assert a.card_count() == b.card_count() == 1
        assert records(a) == records(b) == []


@pytest.mark.parametrize("collision", ["note", "card"])
@pytest.mark.parametrize("remove_marker", [False, True])
def test_remote_deletion_collision_preserves_unsynced_skill(
    server, snapshot, tmp_path, collision, remove_marker
):
    from anki.collection import AddNoteRequest

    with collections(tmp_path) as (a, b):
        auth = bootstrap(a, b, server)
        import_snapshot(b, snapshot)
        native_id = b.find_cards("")[0]
        model = copy.deepcopy(b.get_card(native_id).note_type())
        model.pop("learnrecur")
        model["id"] = 0
        mid = a.models.add_dict(model).id
        ordinary = a.new_note(a.models.get(mid))
        ordinary.fields = b.get_card(native_id).note().fields.copy()
        ordinary["LearnRecurLink"] = ordinary["LearnRecurSkill"] = ""
        ordinary.id = native_id if collision == "note" else native_id + 100
        ordinary.guid = "00000000000000000000000000000001"
        a.add_skill_notes(
            [AddNoteRequest(ordinary, a.decks.id("Ordinary"))], [native_id]
        )
        a.remove_notes([ordinary.id])
        sync(a, auth)
        rate(b)
        if remove_marker:
            model = b.get_card(native_id).note_type()
            model.pop("learnrecur")
            b.models.update_dict(model)
        before = (b.get_card(native_id).note().fields, records(b))
        with pytest.raises(Exception, match="remote skill deletion"):
            b.sync_collection(auth, False)
        assert b.card_count() == 1
        assert (b.get_card(native_id).note().fields, records(b)) == before


@pytest.mark.parametrize("delete", ["note", "deck"])
@pytest.mark.parametrize("import_after_bootstrap", [False, True])
def test_remote_skill_deletion_stops_without_deleting_server_copy(
    server, snapshot, tmp_path, delete, import_after_bootstrap
):
    with collections(tmp_path) as (a, b):
        if import_after_bootstrap:
            auth = bootstrap(a, b, server)
            import_snapshot(a, snapshot)
            sync(a, auth)
            sync(b, auth)
        else:
            import_snapshot(a, snapshot)
            auth = bootstrap(a, b, server)
        nid = a.find_notes("")[0]
        assert a.db.all("select * from learnrecur_skill_identities") == b.db.all(
            "select * from learnrecur_skill_identities"
        )
        assert a.db.scalar("select count(*) from learnrecur_skill_identities") == 1
        time.sleep(0.01)  # Native change detection uses millisecond timestamps.
        if delete == "note":
            a.remove_notes([nid])
        else:
            a.decks.remove([a.decks.id(DECK_NAME)])
        with pytest.raises(Exception):
            a.sync_collection(auth, False)
        # Download into this disposable profile to inspect the committed server state.
        full_sync(a, auth, False)
        assert a.card_count() == b.card_count() == 1
        assert a.get_note(nid).fields == b.get_note(nid).fields


@pytest.mark.parametrize("delete", ["note", "deck"])
def test_ordinary_deletion_still_syncs(server, snapshot, tmp_path, delete):
    with collections(tmp_path) as (a, b):
        import_snapshot(a, snapshot)
        ordinary = a.new_note(a.models.by_name("Basic"))
        ordinary["Front"], ordinary["Back"] = "Synthetic", "Ordinary"
        a.add_note(ordinary, a.decks.id("Ordinary"))
        auth = bootstrap(a, b, server)
        if delete == "note":
            a.remove_notes([ordinary.id])
        else:
            a.decks.remove([ordinary.cards()[0].did])
        sync(a, auth)
        sync(b, auth)
        assert a.card_count() == b.card_count() == 1
        assert b.find_notes(f"nid:{ordinary.id}") == []


@pytest.mark.parametrize("delete", ["note", "deck"])
@pytest.mark.parametrize("forge_table", [False, True])
def test_package_metadata_cannot_block_deletion_sync(
    server, snapshot, tmp_path, delete, forge_table
):
    from anki.import_export_pb2 import (
        ExportAnkiPackageOptions,
        ImportAnkiPackageOptions,
        ImportAnkiPackageRequest,
    )

    source = Collection(str(tmp_path / "package-source.anki2"))
    package = tmp_path / "untrusted.apkg"
    try:
        import_snapshot(source, snapshot)
        assert source.db.scalar("select count(*) from learnrecur_skill_identities") == 1
        source.export_anki_package(
            out_path=str(package),
            options=ExportAnkiPackageOptions(
                with_scheduling=True, with_media=True, legacy=forge_table
            ),
            limit=None,
        )
    finally:
        source.close()
    if forge_table:
        with zipfile.ZipFile(package) as archive:
            members = {name: archive.read(name) for name in archive.namelist()}
        member = "collection.anki21"
        forged = tmp_path / "forged-package.anki2"
        forged.write_bytes(members[member])
        with sqlite3.connect(forged) as db:
            db.execute(
                "create table if not exists learnrecur_skill_identities "
                "(nid integer primary key, cid integer not null unique, guid text not null unique)"
            )
            db.execute(
                "insert or replace into learnrecur_skill_identities "
                "select n.id,c.id,n.guid from notes n join cards c on c.nid=n.id"
            )
        members[member] = forged.read_bytes()
        with zipfile.ZipFile(package, "w", zipfile.ZIP_DEFLATED) as archive:
            for name, data in members.items():
                archive.writestr(name, data)
    with collections(tmp_path) as (a, b):
        a.import_anki_package(
            ImportAnkiPackageRequest(
                package_path=str(package),
                options=ImportAnkiPackageOptions(with_scheduling=True),
            )
        )
        card = a.get_card(a.find_cards("")[0])
        assert card.note_type()["learnrecur"] == "skill-v1"
        assert card.note()["LearnRecurLink"]
        assert a.db.scalar("select count(*) from learnrecur_skill_identities") == 0
        auth = bootstrap(a, b, server)
        if delete == "note":
            a.remove_notes([card.nid])
        else:
            a.decks.remove([card.did])
        sync(a, auth)
        sync(b, auth)
        assert a.card_count() == b.card_count() == 0
