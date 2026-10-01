"""Exercise real authenticated HTTP requests and durable companion transactions."""

import copy
import json
import threading
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from learnrecur.companion.server import Server, Store

TOKEN = "synthetic-test-token-not-a-secret-12345"
ROOT = Path(__file__).resolve().parents[3]


@pytest.fixture
def batch():
    return json.loads((ROOT / "learnrecur/fixtures/spanish-import.json").read_text())


@pytest.fixture
def server(tmp_path):
    server = Server(Store(tmp_path / "companion"), TOKEN, 0)
    thread = threading.Thread(target=server.serve_forever)
    thread.start()
    yield server
    server.shutdown()
    server.server_close()
    thread.join()


def request(server, body=None, token=TOKEN, path="/v1/skills"):
    headers = {"Content-Type": "application/json"}
    if token is not None:
        headers["Authorization"] = "Bearer " + token
    req = Request(
        f"http://127.0.0.1:{server.server_port}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
    )
    try:
        response = urlopen(req, timeout=5)
    except HTTPError as error:
        response = error
    with response:
        return response.status, json.load(response)


@pytest.mark.parametrize("token", [None, "wrong"])
def test_authentication_precedes_reads_and_writes(server, batch, token):
    assert request(server, batch, token)[0] == 401
    assert request(server, token=token)[0] == 401
    assert server.store.snapshot()["skills"] == []


def test_retry_restart_and_conflict_rollback(server, batch):
    status, first = request(server, batch)
    assert status == 200
    assert request(server, batch) == (200, first)
    restored = Store(server.store.path.parent)
    assert restored.snapshot() == first
    other = copy.deepcopy(batch["skills"][0])
    other["id"] = other["bank"]["skill_id"] = "another-skill"
    changed = copy.deepcopy(batch["skills"][0])
    changed["title"] = "Different content"
    assert request(server, {"skills": [other, changed]})[0] == 409
    assert restored.snapshot() == first  # The first insert rolled back too.
    assert request(server, path="/missing")[0] == 404


def test_concurrent_retries_create_one_skill(server, batch):
    results = []
    threads = [
        threading.Thread(target=lambda: results.append(request(server, batch)))
        for _ in range(4)
    ]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert len(results) == 4 and all(status == 200 for status, _ in results)
    assert len(server.store.snapshot()["skills"]) == 1


def test_malformed_json_and_oversized_body_do_not_commit(server):
    from anki.learnrecur_skill_import import MAX_BYTES

    for data, expected in [
        (b'{"skills":[],"skills":[]}', 400),
        (b'{"skills":[{"id":"\\ud800"}]}', 400),
    ]:
        req = Request(
            f"http://127.0.0.1:{server.server_port}/v1/skills",
            data=data,
            headers={
                "Authorization": "Bearer " + TOKEN,
                "Content-Type": "application/json",
            },
        )
        with pytest.raises(HTTPError) as error:
            urlopen(req, timeout=5)
        assert error.value.code == expected
    from http.client import HTTPConnection

    connection = HTTPConnection("127.0.0.1", server.server_port, timeout=5)
    connection.request(
        "POST",
        "/v1/skills",
        headers={
            "Authorization": "Bearer " + TOKEN,
            "Content-Type": "application/json",
            "Content-Length": str(MAX_BYTES + 1),
        },
    )
    response = connection.getresponse()
    assert response.status == 413
    response.read()
    connection.close()
    assert server.store.snapshot()["skills"] == []


def test_folder_and_database_links_are_rejected(tmp_path):
    outside = tmp_path / "outside"
    outside.mkdir()
    linked = tmp_path / "linked"
    linked.symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError):
        Store(linked)
    with pytest.raises(ValueError):
        Store(tmp_path / "Anki2")
    store = Store(tmp_path / "companion")
    store.path.unlink()
    store.path.symlink_to(outside / "data.sqlite3")
    with pytest.raises(ValueError):
        Store(store.path.parent)
    assert not (outside / "data.sqlite3").exists()


def test_native_identities_are_durable_and_unique_even_in_same_millisecond(
    tmp_path, batch, monkeypatch
):
    import learnrecur.companion.server as module

    monkeypatch.setattr(module.time, "time_ns", lambda: 1_790_000_000_000_000_000)
    store = Store(tmp_path / "companion")
    first = store.import_batch(batch)
    other = copy.deepcopy(batch["skills"][0])
    other["id"] = other["bank"]["skill_id"] = "another-skill"
    both = store.import_batch({"skills": [other]})
    assert all(
        both["identities"][key] == value for key, value in first["identities"].items()
    )
    ids = [identity["native_id"] for identity in both["identities"].values()]
    assert len(set(ids)) == len(ids) == 2
    assert max(ids) == min(ids) + 1
    assert Store(store.path.parent).snapshot() == both


def test_existing_store_backfills_identity_once(tmp_path, batch):
    store = Store(tmp_path / "companion")
    store.import_batch(batch)
    with store.connect() as db:
        db.execute("drop table identities")  # Simulate the previous store schema.
    upgraded = Store(store.path.parent)
    first = upgraded.snapshot()
    assert upgraded.import_batch(batch) == first
    assert Store(store.path.parent).snapshot() == first


def test_identity_migration_over_limit_rolls_back_and_explains_recovery(
    tmp_path, batch
):
    from anki.learnrecur_skill_import import (
        MAX_BYTES,
        SkillImportError,
        encode,
        validate_skills,
    )

    store = Store(tmp_path / "companion")
    source = store.snapshot()["source_id"]
    skill = batch["skills"][0]
    skill["bank"]["exercises"] = [
        {"id": f"fixture-{index}", "prompt": "x", "answer": "x", "explanation": "x"}
        for index in range(100)
    ]
    legacy = {"source_id": source, "skills": [skill]}
    remaining = MAX_BYTES - 16 - len(encode(legacy).encode())
    for exercise in skill["bank"]["exercises"]:
        for field in ("prompt", "answer", "explanation"):
            amount = min(8191, remaining)
            exercise[field] += "x" * amount
            remaining -= amount
    assert remaining == 0
    validate_skills(legacy["skills"])
    assert len(encode(legacy).encode()) == MAX_BYTES - 16
    original = encode(skill)
    with store.connect() as db:
        db.execute("insert into skills values (?,?)", (skill["id"], original))
        db.execute("drop table identities")
    with pytest.raises(
        SkillImportError, match="Back up this folder.*new companion folder"
    ):
        Store(store.path.parent)
    with store.connect() as db:
        assert (
            db.execute("select value from metadata where key='source_id'").fetchone()[0]
            == source
        )
        assert db.execute("select payload from skills").fetchone()[0] == original
        assert not db.execute(
            "select 1 from sqlite_master where name='identities'"
        ).fetchone()
