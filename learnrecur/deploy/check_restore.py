# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Sync synthetic data to Linux, restore it, and download through the native client."""

import argparse
import json
import os
import socket
import subprocess
import time
from pathlib import Path
from urllib.request import Request, urlopen
from uuid import uuid4

from anki.collection import Collection
from anki.learnrecur_skill_import import DECK_NAME, import_snapshot
from anki.learnrecur_skills import (
    prepare_skill_answer,
    select_skill_review,
    skill_refill_request,
)
from anki.scheduler.v3 import CardAnswer
from learnrecur.deploy.backup import safe_path
from learnrecur.deploy.manage import Deployment

ROOT = Path(__file__).resolve().parents[2]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def request(endpoint, token, route="/v1/skills", payload=None):
    with urlopen(
        Request(
            endpoint + route,
            data=None if payload is None else json.dumps(payload).encode(),
            headers={
                "Authorization": "Bearer " + token,
                "Content-Type": "application/json",
            },
        ),
        timeout=5,
    ) as response:
        return json.load(response)


def ready(endpoint):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            with urlopen(endpoint + "/health", timeout=1) as response:
                if response.status == 200:
                    return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("The Linux sync server did not become ready.")


def ready_companion(endpoint, token):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        try:
            request(endpoint, token)
            return
        except OSError:
            time.sleep(0.1)
    raise RuntimeError("The Linux companion did not become ready.")


def ready_services(sync, companion, token):
    ready(sync)
    ready_companion(companion, token)


def full_sync(col, auth, upload):
    col.close_for_full_sync()
    try:
        col.full_upload_or_download(auth=auth, server_usn=None, upload=upload)
    finally:
        col.reopen(after_full_sync=True)


def media_sync(col, auth):
    col.sync_media(auth)
    deadline = time.monotonic() + 30
    while col.media_sync_status().active:
        if time.monotonic() > deadline:
            raise RuntimeError("Media sync did not finish.")
        time.sleep(0.05)


def rate(col):
    col.decks.select(col.decks.id(DECK_NAME))
    queued = col.sched.get_queued_cards().cards[0]
    card = col.get_card(queued.card.id)
    review = select_skill_review(card)
    card.start_timer()
    queued.states.current.custom_data = card.custom_data
    answer = col.sched.build_answer(
        card=card, states=queued.states, rating=CardAnswer.AGAIN
    )
    prepare_skill_answer(col, answer, review)
    col.sched.answer_card(answer)
    return card.id


def rows(col):
    return {
        "notes": col.db.all("select * from notes order by id"),
        "cards": col.db.all("select * from cards order by id"),
        "reviews": col.db.all("select * from revlog order by id"),
        "identities": col.db.all(
            "select * from learnrecur_skill_identities order by nid"
        ),
    }


def verify_private_listeners(deployment):
    ids = deployment.compose("ps", "--quiet").split()
    containers = json.loads(
        subprocess.run(
            ["docker", "inspect", *ids], check=True, capture_output=True, text=True
        ).stdout
    )
    for item in containers:
        assert item["HostConfig"]["ReadonlyRootfs"]
        assert item["Config"]["User"] != "0:0"
        for bindings in item["HostConfig"]["PortBindings"].values():
            assert all(binding["HostIp"] == "127.0.0.1" for binding in bindings)


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    root = safe_path(args.root)
    root.mkdir(mode=0o700, parents=True)  # Every run needs fresh synthetic storage.
    keys = root / "keys"
    keys.mkdir(mode=0o700)
    source = Deployment(
        root / "source",
        root / "credentials",
        args.image,
        "learnrecur-proof-" + uuid4().hex[:10],
    )
    restored = Deployment(
        root / "restored",
        root / "credentials",
        args.image,
        "learnrecur-proof-" + uuid4().hex[:10],
    )
    for deployment in (source, restored):
        deployment.env["LEARNRECUR_SYNC_PORT"] = str(free_port())
        deployment.env["LEARNRECUR_COMPANION_PORT"] = str(free_port())

    def endpoint(deployment):
        return "http://127.0.0.1:" + deployment.env["LEARNRECUR_SYNC_PORT"]

    def companion(deployment):
        return "http://127.0.0.1:" + deployment.env["LEARNRECUR_COMPANION_PORT"]

    started = time.monotonic()
    clients = []
    try:
        source.initialize()
        source.start()
        token = (source.credentials / "companion-token").read_text().strip()
        ready_services(endpoint(source), companion(source), token)
        verify_private_listeners(source)
        user, password = (
            (source.credentials / "sync-account").read_text().strip().split(":", 1)
        )
        snapshot = request(
            companion(source),
            token,
            payload=json.loads(
                (ROOT / "learnrecur/fixtures/spanish-import.json").read_text()
            ),
        )
        for name in ("client-a", "client-b"):
            folder = root / name
            folder.mkdir()
            clients.append(Collection(str(folder / "collection.anki2")))
        a, b = clients
        import_snapshot(a, snapshot)
        ordinary = a.new_note(a.models.by_name("Basic"))
        ordinary["Front"] = 'Synthetic <b>ordinary</b> <img src="synthetic.svg">'
        ordinary["Back"] = "Synthetic answer"
        a.add_note(ordinary, a.decks.id("Ordinary"))
        media = b'<svg xmlns="http://www.w3.org/2000/svg"><circle r="10"/></svg>'
        a.media.write_data("synthetic.svg", media)
        skill_card = rate(a)
        checkpoint = skill_refill_request(a.get_card(skill_card))
        assert checkpoint is not None
        first = request(companion(source), token, "/v1/refill-requests", checkpoint)
        assert first["status"] == "queued"
        source.compose(
            "exec",
            "-T",
            "companion",
            "python",
            "-c",
            'from pathlib import Path; from learnrecur.companion.server import Store; from learnrecur.companion.jobs import Jobs, FixtureProvider; Jobs(Store(Path("/state/companion"))).run_once(FixtureProvider())',
        )
        assert (
            request(companion(source), token, "/v1/generation-jobs/" + first["job_id"])[
                "state"
            ]
            == "completed"
        )
        snapshot = request(companion(source), token)
        assert import_snapshot(a, snapshot, cache_only=True).updated == 1
        for _ in range(3):
            rate(a)
        checkpoint = skill_refill_request(a.get_card(skill_card))
        assert checkpoint is not None and checkpoint["bank_sequence"] == 1
        queued = request(companion(source), token, "/v1/refill-requests", checkpoint)
        assert queued["status"] == "queued" and queued["job_id"] != first["job_id"]
        pending = request(
            companion(source), token, "/v1/generation-jobs/" + queued["job_id"]
        )
        expected_answer = select_skill_review(a.get_card(skill_card)).exercise.answer
        auth = a.sync_login(user, password, endpoint(source) + "/")
        full_sync(a, auth, True)
        media_sync(a, auth)
        before = rows(a)
        # The key exists only in this disposable proof, outside backend state.
        subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--user",
                f"{os.getuid()}:{os.getuid()}",
                "--mount",
                f"type=bind,src={keys},dst=/keys",
                "--entrypoint",
                "age-keygen",
                args.image,
                "-o",
                "/keys/identity",
            ],
            check=True,
            capture_output=True,
        )
        public = subprocess.run(
            [
                "docker",
                "run",
                "--rm",
                "--user",
                f"{os.getuid()}:{os.getuid()}",
                "--mount",
                f"type=bind,src={keys},dst=/keys,readonly",
                "--entrypoint",
                "age-keygen",
                args.image,
                "-y",
                "/keys/identity",
            ],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()
        archive = root / "backups/backend.age"
        source.backup(archive, public)
        assert source.running() == {"sync", "companion"}  # Worker was never started.
        source.compose("stop")
        damaged = archive.with_name("damaged.age")
        ciphertext = bytearray(archive.read_bytes())
        ciphertext[-1] ^= 1
        damaged.write_bytes(ciphertext)
        invalid = Deployment(
            root / "invalid-restore",
            root / "credentials",
            args.image,
            "learnrecur-proof-" + uuid4().hex[:10],
        )
        try:
            invalid.restore(damaged, keys / "identity")
        except subprocess.CalledProcessError:
            pass
        else:
            raise AssertionError("A damaged encrypted backup was accepted.")
        assert not invalid.state.exists()
        restored.restore(archive, keys / "identity")
        assert (restored.state / "companion/.restore-pending").exists()
        restored.start()
        ready_services(endpoint(restored), companion(restored), token)
        assert request(companion(restored), token) == snapshot
        assert request(
            companion(restored), token, "/v1/refill-requests", checkpoint
        ) == {"status": "disabled", "job_id": None}
        assert (
            request(companion(restored), token, "/v1/generation-jobs/" + pending["id"])
            == pending
        )
        try:
            restored.start(worker=True)
        except ValueError:
            pass
        else:
            raise AssertionError("The restored worker started without inspection.")
        auth_b = b.sync_login(user, password, endpoint(restored) + "/")
        full_sync(b, auth_b, False)
        media_sync(b, auth_b)
        after = rows(b)
        assert before["cards"] == after["cards"]
        assert before["reviews"] == after["reviews"]
        assert before["identities"] == after["identities"]
        assert before["notes"] == after["notes"]
        assert (Path(b.media.dir()) / "synthetic.svg").read_bytes() == media
        assert import_snapshot(b, snapshot).existing == 1
        assert (
            select_skill_review(b.get_card(skill_card)).exercise.answer
            == expected_answer
        )
        restored.compose("stop")
        restored.helper(
            [(restored.state, "/state", False)],
            "allow-fixture-worker",
            "--root",
            "/state",
        )
        restored.start(worker=True)
        ready_services(endpoint(restored), companion(restored), token)
        deadline = time.monotonic() + 20
        while (
            request(companion(restored), token, "/v1/generation-jobs/" + pending["id"])[
                "state"
            ]
            != "completed"
        ):
            assert time.monotonic() < deadline
            time.sleep(0.1)
        latest = request(companion(restored), token)
        assert len(latest["bank_updates"]["spanish-ar-preterite-yo"]) == 2
        unchanged = rows(b)
        assert import_snapshot(b, latest, cache_only=True).updated == 1
        assert (
            rows(b)["cards"] == unchanged["cards"]
            and rows(b)["reviews"] == unchanged["reviews"]
        )
        assert request(
            companion(restored), token, "/v1/refill-requests", checkpoint
        ) == {"status": "awaiting_import", "job_id": None}
        assert (
            restored.compose(
                "exec",
                "-T",
                "companion",
                "python",
                "-c",
                'import sqlite3; db=sqlite3.connect("/state/companion/skills.sqlite3"); print(db.execute("select count(*) from generation_jobs").fetchone()[0])',
            ).strip()
            == "2"
        )
        ids = restored.compose("ps", "--quiet").split()
        stats = subprocess.run(
            ["docker", "stats", "--no-stream", "--format", "{{json .}}", *ids],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        report = {
            "image": args.image,
            "elapsed_seconds": round(time.monotonic() - started, 2),
            "cards": b.card_count(),
            "reviews": len(after["reviews"]),
            "exercises": 9,
            "pending_job_resumed_once": pending["id"],
            "backup_bytes": archive.stat().st_size,
            "stats": [json.loads(line) for line in stats.splitlines()],
            "limit": "Separate Linux containers on one Docker host; a different VPS restore is still required.",
        }
        (root / "result.json").write_text(json.dumps(report, indent=2))
        print(
            "Linux sync, encrypted restore, media, identities, offline review, and queued job recovery passed."
        )
    finally:
        for client in clients:
            client.close()
        for deployment in (source, restored):
            deployment.verify_containers()
            (root / (deployment.project + ".log")).write_text(
                deployment.compose("logs", "--no-color")
            )
            deployment.compose("down")


if __name__ == "__main__":
    main()
