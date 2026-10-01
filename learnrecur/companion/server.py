# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""A loopback-only companion for supplied skill batches, not paid generation."""

from __future__ import annotations

import argparse
import hmac
import os
import sqlite3
import time
from contextlib import closing, contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from uuid import uuid4

from anki.learnrecur_skill_import import (
    MAX_BYTES,
    MAX_SKILLS,
    SkillImportError,
    decode,
    encode,
    validate_skills,
)


class Conflict(SkillImportError):
    pass


class Store:
    def __init__(self, folder: Path):
        folder = Path(os.path.abspath(folder.expanduser()))
        if any(
            part.casefold() in {"anki", "anki2", ".anki"} for part in folder.parts
        ) or any(path.is_symlink() for path in (folder, *folder.parents)):
            raise ValueError("Use a separate companion folder without symbolic links.")
        marker = folder / ".learnrecur-companion"
        if marker.is_symlink() or (
            folder.exists() and not marker.exists() and any(folder.iterdir())
        ):
            raise ValueError("Use an empty folder or an existing companion folder.")
        if marker.exists() and marker.read_text() != "learnrecur-companion-v1\n":
            raise ValueError("Unrecognized companion folder.")
        folder.mkdir(parents=True, exist_ok=True, mode=0o700)
        marker.write_text("learnrecur-companion-v1\n")
        self.path = folder / "skills.sqlite3"
        for suffix in ("", "-wal", "-shm", "-journal"):
            if Path(str(self.path) + suffix).is_symlink():
                raise ValueError("Companion database files must not be symbolic links.")
        with self.connect() as db:
            db.execute("begin immediate")
            db.execute(
                "create table if not exists metadata (key text primary key, value text not null)"
            )
            db.execute(
                "create table if not exists skills (id text primary key, payload text not null)"
            )
            db.execute(
                "insert or ignore into metadata values ('source_id', ?)",
                (str(uuid4()),),
            )
            db.execute(
                "create table if not exists identities (skill_id text primary key, "
                "native_id integer not null unique, guid text not null unique)"
            )
            for (skill_id,) in db.execute(
                "select id from skills order by id"
            ).fetchall():
                self._assign_identity(db, skill_id)
            if self._too_large(self._snapshot(db)):
                raise SkillImportError(
                    "The stored skills are too large to add card identities. "
                    "Back up this folder and import a smaller batch into a new companion folder."
                )
        self.path.chmod(0o600)

    @contextmanager
    def connect(self):
        with closing(sqlite3.connect(self.path, timeout=5)) as db:
            with db:
                yield db

    @staticmethod
    def _assign_identity(db, skill_id):
        if db.execute(
            "select 1 from identities where skill_id=?", (skill_id,)
        ).fetchone():
            return
        highest = db.execute(
            "select coalesce(max(native_id),0) from identities"
        ).fetchone()[0]
        native_id = max(time.time_ns() // 1_000_000, highest + 1)
        db.execute(
            "insert into identities values (?,?,?)", (skill_id, native_id, uuid4().hex)
        )

    @staticmethod
    def _snapshot(db):
        return {
            "source_id": db.execute(
                "select value from metadata where key = 'source_id'"
            ).fetchone()[0],
            "identities": {
                skill_id: {"native_id": native_id, "guid": guid}
                for skill_id, native_id, guid in db.execute(
                    "select skill_id, native_id, guid from identities order by skill_id"
                )
            },
            "skills": [
                decode(row[0].encode())
                for row in db.execute("select payload from skills order by id")
            ],
        }

    @staticmethod
    def _too_large(snapshot):
        return (
            len(snapshot["skills"]) > MAX_SKILLS
            or len(encode(snapshot).encode()) > MAX_BYTES
        )

    def snapshot(self):
        with self.connect() as db:
            db.execute("begin")
            return self._snapshot(db)

    def import_batch(self, payload):
        if not isinstance(payload, dict) or set(payload) != {"skills"}:
            raise SkillImportError("Expected a skill batch.")
        skills = validate_skills(payload["skills"])
        with self.connect() as db:
            db.execute("begin immediate")
            for skill in skills:
                encoded = encode(skill)
                existing = db.execute(
                    "select payload from skills where id = ?", (skill["id"],)
                ).fetchone()
                if existing and existing[0] != encoded:
                    raise Conflict(
                        "This skill ID already has different content. Revisions are not supported yet."
                    )
                db.execute(
                    "insert or ignore into skills values (?, ?)", (skill["id"], encoded)
                )
                self._assign_identity(db, skill["id"])
            result = self._snapshot(db)
            if self._too_large(result):
                raise SkillImportError(
                    "The local companion can hold at most 100 skills and 1 MiB of skill data."
                )
            return result


class Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, store: Store, token: str, port: int = 45321):
        if (
            not token.isascii()
            or len(token) < 32
            or any(char.isspace() for char in token)
        ):
            raise ValueError(
                "Set LEARNRECUR_COMPANION_TOKEN to at least 32 ASCII characters without spaces."
            )
        self.store = store
        self.authorization = ("Bearer " + token).encode()
        super().__init__(("127.0.0.1", port), Handler)

    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(5)
        return connection, address


class Handler(BaseHTTPRequestHandler):
    server: Server

    def log_message(self, *args):
        pass  # No request bodies, credentials, or skill text in HTTP logs.

    def _reply(self, status, value):
        data = encode(value).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass  # A committed import remains safe to retry after disconnect.

    def do_GET(self):
        self._request(False)

    def do_POST(self):
        self._request(True)

    def _request(self, write):
        self.connection.settimeout(5)
        auth = self.headers.get_all("Authorization", [])
        if len(auth) != 1 or not hmac.compare_digest(
            auth[0].encode(), self.server.authorization
        ):
            self._reply(401, {"error": "Authentication required."})
            return
        if self.path != "/v1/skills":
            self._reply(404, {"error": "Unknown endpoint."})
            return
        try:
            if write:
                lengths = self.headers.get_all("Content-Length", [])
                if (
                    len(lengths) != 1
                    or not lengths[0].isdigit()
                    or self.headers.get("Transfer-Encoding")
                    or self.headers.get("Content-Type") != "application/json"
                ):
                    raise SkillImportError("Send JSON with a Content-Length header.")
                length = int(lengths[0])
                if not 0 < length <= MAX_BYTES:
                    self._reply(413, {"error": "The skill batch is too large."})
                    return
                data = self.rfile.read(length)
                if len(data) != length:
                    raise SkillImportError("Incomplete skill batch.")
                result = self.server.store.import_batch(decode(data))
            else:
                result = self.server.store.snapshot()
            self._reply(200, result)
        except Conflict as error:
            self._reply(409, {"error": str(error)})
        except SkillImportError as error:
            self._reply(400, {"error": str(error)})
        except (sqlite3.Error, OSError):
            self._reply(503, {"error": "The companion is unavailable. Retry later."})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=45321)
    args = parser.parse_args()
    try:
        server = Server(
            Store(args.data_dir),
            os.environ.get("LEARNRECUR_COMPANION_TOKEN", ""),
            args.port,
        )
    except ValueError as error:
        parser.error(str(error))
    print(f"Companion listening on http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
