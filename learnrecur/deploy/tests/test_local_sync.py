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

from anki.collection import Collection, media_paths_from_col_path
from anki.errors import BackendError
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


@pytest.mark.parametrize("revision", [False, True])
def test_disconnect_after_sync_commit_recovers_without_duplicate_reviews(
    server, snapshot, tmp_path, revision
):
    with collections(tmp_path) as (a, b):
        import_snapshot(a, snapshot)
        auth = bootstrap(a, b, server)
        cid = rate(b)
        expected = records(b)
        if revision:
            import_snapshot(b, revised_snapshot(tmp_path))
        expected_fields = b.get_card(cid).note().fields
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
        assert (
            a.get_card(cid).note().fields
            == b.get_card(cid).note().fields
            == expected_fields
        )
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


@pytest.mark.parametrize("delete", ["note", "deck"])
@pytest.mark.parametrize("legacy", [False, True])
def test_collection_restore_discards_claimed_ownership_and_rebuilds_links(
    server, snapshot, tmp_path, delete, legacy
):
    source = Collection(str(tmp_path / "restore-source.anki2"))
    package = tmp_path / "untrusted.colpkg"
    try:
        import_snapshot(source, snapshot)
        cid = rate(source)
        card_before = source.get_card(cid)
        fields_before = card_before.note().fields
        history_before = records(source)
        ordinary = source.new_note(source.models.by_name("Basic"))
        ordinary["Front"] = 'Synthetic <b>ordinary</b> card <img src="restore.svg">'
        ordinary["Back"] = "An ordinary answer"
        source.add_note(ordinary, source.decks.id("Ordinary"))
        svg = b'<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>'
        source.media.write_data("restore.svg", svg)
        # A package author can claim ownership of any note and forge the index.
        source.db.execute(
            "insert into learnrecur_skill_identities(nid,cid,guid) values(?,?,?)",
            ordinary.id,
            ordinary.cards()[0].id,
            ordinary.guid,
        )
        source.db.execute(
            "update learnrecur_skill_links set source_id='forged',skill_id='forged'"
        )
        source.export_collection_package(
            str(package), include_media=True, legacy=legacy
        )
    finally:
        source.close()
    with collections(tmp_path) as (a, b):
        media_folder, media_db = media_paths_from_col_path(a.path)
        a.close()
        a._backend.import_collection_package(
            col_path=a.path,
            backup_path=str(package),
            media_folder=media_folder,
            media_db=media_db,
        )
        a.reopen()
        restored = a.get_card(cid)
        assert restored.note().fields == fields_before
        assert restored.custom_data == card_before.custom_data
        assert (restored.queue, restored.type, restored.due, restored.ivl) == (
            card_before.queue,
            card_before.type,
            card_before.due,
            card_before.ivl,
        )
        assert records(a) == history_before
        assert a.db.scalar("select count(*) from learnrecur_skill_identities") == 0
        assert a.db.all(
            "select nid,source_id,skill_id from learnrecur_skill_links"
        ) == [[cid, snapshot["source_id"], snapshot["skills"][0]["id"]]]
        assert select_skill_review(restored).exercise.id == "trabajar"
        with pytest.raises(ValueError, match="trusted"):
            import_snapshot(a, snapshot)
        assert a.card_count() == 2 and records(a) == history_before
        assert a.get_note(ordinary.id).fields == ordinary.fields
        assert (Path(media_folder) / "restore.svg").read_bytes() == svg
        auth = bootstrap(a, b, server)
        time.sleep(0.01)  # Native change detection uses millisecond timestamps.
        if delete == "note":
            a.remove_notes([restored.nid])
        else:
            a.decks.remove([restored.did])
        sync(a, auth)
        sync(b, auth)
        assert a.card_count() == b.card_count() == 1
        # Forged ownership of the ordinary note must not prevent its deletion.
        time.sleep(0.01)
        a.remove_notes([ordinary.id])
        sync(a, auth)
        sync(b, auth)
        assert a.card_count() == b.card_count() == 0


@pytest.mark.parametrize("legacy", [False, True])
def test_invalid_collection_ownership_keeps_target_collection_and_media(
    tmp_path, legacy
):
    source = Collection(str(tmp_path / "invalid-source.anki2"))
    package = tmp_path / "invalid.colpkg"
    try:
        note = source.new_note(source.models.by_name("Basic"))
        note["Front"], note["Back"] = "Package", "Invalid ownership schema"
        source.add_note(note, 1)
        source.media.write_data("sentinel.txt", b"package media")
        source.db.execute("drop table learnrecur_skill_identities")
        source.db.execute(
            "create view learnrecur_skill_identities as select id as nid from notes"
        )
        source.export_collection_package(
            str(package), include_media=True, legacy=legacy
        )
    finally:
        source.close()
    with collections(tmp_path) as (a, _b):
        sentinel = a.new_note(a.models.by_name("Basic"))
        sentinel["Front"], sentinel["Back"] = "Keep", "Destination"
        a.add_note(sentinel, 1)
        a.media.write_data("sentinel.txt", b"destination media")
        media_folder, media_db = media_paths_from_col_path(a.path)
        a.close()
        with pytest.raises(BackendError, match="not a valid"):
            a._backend.import_collection_package(
                col_path=a.path,
                backup_path=str(package),
                media_folder=media_folder,
                media_db=media_db,
            )
        a.reopen()
        assert a.card_count() == 1
        assert a.get_note(sentinel.id).fields == sentinel.fields
        assert (
            Path(media_folder) / "sentinel.txt"
        ).read_bytes() == b"destination media"


def revised_snapshot(tmp_path):
    batch = json.loads((ROOT / "learnrecur/fixtures/spanish-revision.json").read_text())
    return Store(tmp_path / "companion").import_batch(batch)


def test_revision_sync_preserves_both_offline_ratings_and_retries(
    server, snapshot, tmp_path
):
    with collections(tmp_path) as (a, b):
        import_snapshot(a, snapshot)
        auth = bootstrap(a, b, server)
        server.stop(crash=True)
        cid = rate(a)
        time.sleep(0.01)
        rate(b)
        expected_history = sorted(records(a) + records(b))
        latest = revised_snapshot(tmp_path)
        cards_before = a.db.all("select * from cards")
        assert import_snapshot(a, latest).updated == 1
        assert a.db.all("select * from cards") == cards_before
        assert select_skill_review(a.get_card(cid)).exercise.id == "cantar"
        assert select_skill_review(b.get_card(cid)).exercise.id == "trabajar"
        server.start()
        sync(a, auth)
        sync(b, auth)
        sync(a, auth)
        for col in (a, b):
            assert col.card_count() == 1
            assert records(col) == expected_history
            assert (
                json.loads(col.get_card(cid).note()["LearnRecurSkill"])["revision"] == 2
            )
            before = (col.get_card(cid).note().fields, records(col))
            assert import_snapshot(col, latest).existing == 1
            assert import_snapshot(col, snapshot).existing == 1
            assert (col.get_card(cid).note().fields, records(col)) == before
            col.close()
            col.reopen()
            assert records(col) == expected_history
            assert select_skill_review(col.get_card(cid)).exercise.id == "cantar"


def test_newer_offline_timestamp_cannot_replace_latest_revision(
    server, snapshot, tmp_path
):
    with collections(tmp_path) as (a, b):
        import_snapshot(a, snapshot)
        auth = bootstrap(a, b, server)
        second = revised_snapshot(tmp_path)
        third = copy.deepcopy(second["skills"][0])
        third["bank"]["revision"] = 3
        third["description"] += " Write only the verb."
        latest = Store(tmp_path / "companion").import_batch({"skills": [third]})
        assert import_snapshot(a, latest).updated == 1  # Catch up across two revisions.
        sync(a, auth)
        assert import_snapshot(b, second).updated == 1
        cid = a.find_cards("")[0]
        b.db.execute("update notes set mod=mod+60,usn=-1 where id=?", cid)
        sync(b, auth)
        sync(a, auth)
        expected = a.get_card(cid).note().fields
        assert b.get_card(cid).note().fields == expected
        assert json.loads(a.get_card(cid).note()["LearnRecurSkill"])["revision"] == 3
        assert import_snapshot(b, second).existing == 1
        assert b.get_card(cid).note().fields == expected


@pytest.mark.parametrize("tags", [["offline-tag"], []])
def test_revision_sync_preserves_newer_offline_tag_edits(
    server, snapshot, tmp_path, tags
):
    with collections(tmp_path) as (a, b):
        import_snapshot(a, snapshot)
        cid = a.find_cards("")[0]
        note = a.get_card(cid).note()
        note.tags = ["original-tag"]
        a.update_note(note)
        auth = bootstrap(a, b, server)
        latest = revised_snapshot(tmp_path)
        import_snapshot(a, latest)
        sync(a, auth)
        note = b.get_card(cid).note()
        note.tags = tags
        b.update_note(note)
        b.db.execute("update notes set mod=mod+60,usn=-1 where id=?", cid)
        # The simulated later edit must advance the collection clock too.
        # Equal millisecond collection clocks make native sync skip the exchange.
        b.db.execute("update col set mod=mod+60000")
        sync(b, auth)
        sync(a, auth)
        for col in (a, b):
            note = col.get_card(cid).note()
            assert note.tags == tags
            assert json.loads(note["LearnRecurSkill"])["revision"] == 2
            assert select_skill_review(col.get_card(cid)).exercise.id == "cantar"
            assert import_snapshot(col, latest).existing == 1
        # The merged tag edit was uploaded, rather than merely kept locally.
        full_sync(a, auth, False)
        assert a.get_card(cid).note().tags == tags


def test_conflicting_content_at_same_revision_stops_sync(server, snapshot, tmp_path):
    with collections(tmp_path) as (a, b):
        import_snapshot(a, snapshot)
        auth = bootstrap(a, b, server)
        latest = revised_snapshot(tmp_path)
        import_snapshot(a, latest)
        sync(a, auth)
        sync(b, auth)
        cid = rate(b)
        note = b.get_card(cid).note()
        note["Description"] = "Conflicting local wording"
        b.update_note(note)
        before = (b.get_card(cid).note().fields, records(b))
        with pytest.raises(Exception):
            b.sync_collection(auth, False)
        assert (b.get_card(cid).note().fields, records(b)) == before
        assert a.get_card(cid).note()["Description"] != note["Description"]
        # Inspect the server copy without accepting a replacement in the edited profile.
        full_sync(a, auth, False)
        assert (
            a.get_card(cid).note()["Description"] == latest["skills"][0]["description"]
        )
        assert records(a) == []  # The failed transaction did not copy B's rating.


def generated_snapshot(tmp_path):
    from learnrecur.companion.jobs import FixtureProvider, Jobs

    store = Store(tmp_path / "companion")
    jobs = Jobs(store)
    jobs.enqueue(
        {
            "request_id": "sync-fixture",
            "skill_id": "spanish-ar-preterite-yo",
            "revision": 1,
            "count": 3,
        }
    )
    jobs.run_once(FixtureProvider())
    return store.snapshot()


def test_generated_bank_sync_keeps_offline_reviews_cursor_tags_and_retry(
    server, snapshot, tmp_path
):
    with collections(tmp_path) as (a, b):
        import_snapshot(a, snapshot)
        auth = bootstrap(a, b, server)
        cid = rate(a)
        before = a.db.all("select * from cards")
        latest = generated_snapshot(tmp_path)
        assert import_snapshot(a, latest).updated == 1
        assert a.db.all("select * from cards") == before
        assert select_skill_review(a.get_card(cid)).exercise.id == "trabajar"
        note = b.get_card(cid).note()
        note.tags = ["offline-tag"]
        b.update_note(note)
        b.db.execute("update notes set mod=mod+60,usn=-1 where id=?", cid)
        sync(a, auth)
        sync(b, auth)
        sync(a, auth)
        for col in (a, b):
            assert col.card_count() == 1 and len(records(col)) == 1
            assert col.get_card(cid).note().tags == ["offline-tag"]
            assert select_skill_review(col.get_card(cid)).exercise.id == "trabajar"
            state_before = (
                col.get_card(cid).note().fields,
                records(col),
                col.db.all("select * from cards"),
            )
            assert import_snapshot(col, snapshot).existing == 1
            assert import_snapshot(col, latest).existing == 1
            assert (
                col.get_card(cid).note().fields,
                records(col),
                col.db.all("select * from cards"),
            ) == state_before
        rate(b)
        rate(b)
        assert select_skill_review(b.get_card(cid)).exercise.id.startswith("job-")
        sync(b, auth)
        sync(a, auth)
        assert a.get_card(cid).note().fields == b.get_card(cid).note().fields
        assert records(a) == records(b)
        assert (
            select_skill_review(a.get_card(cid)).exercise.id
            == select_skill_review(b.get_card(cid)).exercise.id
        )


def test_later_bank_sequence_survives_stale_offline_bank(server, snapshot, tmp_path):
    with collections(tmp_path) as (a, b):
        import_snapshot(a, snapshot)
        auth = bootstrap(a, b, server)
        first = generated_snapshot(tmp_path)
        import_snapshot(b, first)
        from learnrecur.companion.jobs import FixtureProvider, Jobs

        class Different(FixtureProvider):
            def generate(self, context):
                result = super().generate(context)
                for exercise in result["exercises"]:
                    exercise["prompt"] = "En 2020: " + exercise["prompt"]
                return result

        store = Store(tmp_path / "companion")
        jobs = Jobs(store)
        jobs.enqueue(
            {
                "request_id": "second-bank",
                "skill_id": "spanish-ar-preterite-yo",
                "revision": 1,
                "count": 3,
            }
        )
        jobs.run_once(Different())
        latest = store.snapshot()
        import_snapshot(a, latest)
        sync(a, auth)
        cid = a.find_cards("")[0]
        b.db.execute("update notes set mod=mod+60,usn=-1 where id=?", cid)
        sync(b, auth)
        sync(a, auth)
        assert a.get_card(cid).note().fields == b.get_card(cid).note().fields
        assert (
            json.loads(b.get_card(cid).note()["LearnRecurSkill"])["bank_sequence"] == 2
        )
        assert import_snapshot(b, first).existing == 1


def test_refill_sync_refuses_rewriting_existing_exercises(server, snapshot, tmp_path):
    with collections(tmp_path) as (a, b):
        import_snapshot(a, snapshot)
        auth = bootstrap(a, b, server)
        latest = generated_snapshot(tmp_path)
        import_snapshot(a, latest)
        sync(a, auth)
        cid = b.find_cards("")[0]
        note = b.get_card(cid).note()
        # Simulate an invalid client declaring a later batch that rewrites an old prompt.
        from anki.learnrecur_skill_import import _fields

        damaged = copy.deepcopy(latest)
        key = damaged["skills"][0]["id"]
        damaged["skills"][0]["bank"]["exercises"][0]["prompt"] = (
            "Changed existing prompt"
        )
        note.fields = _fields(
            damaged["source_id"],
            damaged["skills"][0],
            batches=damaged["bank_updates"][key],
        )
        b.update_note(note)
        before = (note.fields, records(b))
        with pytest.raises(Exception):
            b.sync_collection(auth, False)
        assert (b.get_card(cid).note().fields, records(b)) == before
        full_sync(a, auth, False)
        assert a.get_card(cid).note()["Prompt"] != note["Prompt"]


def test_automatic_bank_delivery_converges_after_offline_reviews(
    server, snapshot, tmp_path
):
    with collections(tmp_path) as (a, b):
        import_snapshot(a, snapshot)
        auth = bootstrap(a, b, server)
        cid = rate(a)
        rate(b)
        latest = generated_snapshot(tmp_path)
        for col in (a, b):
            before = (col.db.all("select * from cards"), records(col))
            assert import_snapshot(col, latest, cache_only=True).updated == 1
            assert (col.db.all("select * from cards"), records(col)) == before
            col.undo()
            assert records(col) == []
            col.redo()
            assert (col.db.all("select * from cards"), records(col)) == before
        sync(a, auth)
        server.stop(crash=True)
        server.start()
        sync(b, auth)
        sync(a, auth)
        for col in (a, b):
            assert col.card_count() == 1 and len(records(col)) == 2
            before = (col.get_card(cid).note().fields, records(col))
            assert import_snapshot(col, latest, cache_only=True).updated == 0
            assert import_snapshot(col, snapshot, cache_only=True).updated == 0
            col.close()
            col.reopen()
            assert (col.get_card(cid).note().fields, records(col)) == before
        assert a.get_card(cid).note().fields == b.get_card(cid).note().fields


@pytest.mark.parametrize("redo", [False, True])
def test_automatic_bank_still_syncs_after_undoing_last_rating(
    server, snapshot, tmp_path, redo
):
    with collections(tmp_path) as (a, b):
        import_snapshot(a, snapshot)
        auth = bootstrap(a, b, server)
        cid = a.find_cards("")[0]
        original = a.db.all("select * from cards")
        last_sync = a.db.scalar("select ls from col")
        rate(a)
        latest = generated_snapshot(tmp_path)
        assert import_snapshot(a, latest, cache_only=True).updated == 1
        committed = a.mod
        a.undo()
        if redo:
            a.redo()
            a.undo()
        assert a.db.all("select * from cards") == original
        assert records(a) == []
        assert a.mod >= committed and a.mod > last_sync
        sync(a, auth)
        sync(b, auth)
        for col in (a, b):
            assert (
                len(
                    json.loads(col.get_card(cid).note()["LearnRecurSkill"])["exercises"]
                )
                == 6
            )
            assert records(col) == []
