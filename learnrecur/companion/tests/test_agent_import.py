"""Check the agent helper against the real API without paid generation."""

import copy
import importlib.util
import json
import os
import stat
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from anki.collection import Collection
from anki.learnrecur_skill_import import import_snapshot
from anki.learnrecur_skills import select_skill_review
from learnrecur.companion.jobs import FixtureProvider, Jobs
from learnrecur.companion.server import Handler, Server, Store

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / ".agents/skills/learnrecur-import/scripts/import_skills.py"
SPEC = importlib.util.spec_from_file_location("agent_import", SCRIPT)
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)
TOKEN = "synthetic-agent-import-token-not-a-secret-12345"
FIXTURE = json.loads((ROOT / "learnrecur/fixtures/spanish-import.json").read_text())[
    "skills"
][0]


def definition(**changes):
    return {
        "title": FIXTURE["title"],
        "description": FIXTURE["description"],
        "examples": [],
        **changes,
    }


@pytest.fixture
def server(tmp_path, monkeypatch):
    instance = Server(
        Store(tmp_path / "companion"), TOKEN, 0, refill_provider="fixture"
    )
    thread = threading.Thread(target=instance.serve_forever)
    thread.start()
    monkeypatch.setenv(
        "LEARNRECUR_COMPANION_URL", f"http://127.0.0.1:{instance.server_port}"
    )
    monkeypatch.setenv("LEARNRECUR_COMPANION_TOKEN", TOKEN)
    yield instance
    instance.shutdown()
    instance.server_close()
    thread.join()


@pytest.fixture
def plans(tmp_path):
    return HELPER.Plans(tmp_path.resolve() / "private-imports")


def counts(server):
    with server.store.connect() as db:
        return (
            db.execute("select count(*) from generation_jobs").fetchone()[0],
            db.execute("select count(*) from generation_attempts").fetchone()[0],
        )


def cli(plans, *arguments, input_value=None):
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--state-dir", str(plans.folder), *arguments],
        input=json.dumps(input_value) if input_value is not None else None,
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
    )


def test_cli_prepare_preview_submit_status_and_native_import(
    server, plans, tmp_path, monkeypatch
):
    example = {
        "prompt": "Anoche yo ___ una canción. (cantar)",
        "answer": "canté",
        "explanation": "The first-person ending is -é.",
    }
    # Proxy variables must never redirect the companion bearer credential.
    monkeypatch.setenv("HTTP_PROXY", "http://127.0.0.1:1")
    monkeypatch.setenv("ALL_PROXY", "http://127.0.0.1:1")
    prepared = cli(
        plans, "prepare", input_value={"skills": [definition(examples=[example])]}
    )
    assert prepared.returncode == 0, prepared.stderr
    preview = json.loads(prepared.stdout)
    plan_id = preview["plan_id"]
    assert preview["skills"][0]["examples"] == [example]
    assert counts(server) == (0, 0)
    assert json.loads(cli(plans, "show", plan_id).stdout) == preview
    assert (
        json.loads(cli(plans, "status", plan_id).stdout)["skills"][0]["state"]
        == "prepared"
    )
    assert counts(server) == (0, 0)

    submitted = cli(plans, "submit", plan_id)
    assert submitted.returncode == 0, submitted.stderr
    assert json.loads(submitted.stdout)["skills"][0]["state"] == "queued"
    assert counts(server) == (1, 0)
    assert server.store.snapshot()["skills"] == []
    jobs = Jobs(server.store)
    jobs.run_once(FixtureProvider())
    status = cli(plans, "status", plan_id)
    assert json.loads(status.stdout)["skills"][0]["state"] == "completed"
    assert cli(plans, "submit", plan_id).returncode == 0
    assert counts(server) == (1, 1)
    saved = (plans.folder / (plan_id + ".json")).read_text()
    assert TOKEN not in saved + prepared.stdout + submitted.stdout + status.stdout
    assert "provider_response_id" not in saved
    assert "bank" not in saved and "context" not in saved
    snapshot = server.store.snapshot()
    for exercise in snapshot["skills"][0]["bank"]["exercises"]:
        assert exercise["prompt"] not in status.stdout
        assert exercise["prompt"] != example["prompt"]
    assert plans.folder.stat().st_mode & 0o777 == 0o700
    assert (plans.folder / (plan_id + ".json")).stat().st_mode & 0o777 == 0o600

    collection = Collection(str(tmp_path / "synthetic.anki2"))
    try:
        assert import_snapshot(collection, snapshot).added == 1
        assert import_snapshot(collection, snapshot).existing == 1
        assert collection.card_count() == 1
        card = collection.get_card(collection.db.scalar("select id from cards"))
        assert select_skill_review(card).exercise.answer == "bailé"
    finally:
        collection.close()


def test_lost_http_receipt_reuses_the_committed_job(server, plans, monkeypatch):
    plan_id, plan = HELPER.prepare(
        plans, HELPER.Companion(), {"skills": [definition()]}
    )
    reply = Handler._reply
    dropped = False

    def drop_receipt(handler, status, value):
        nonlocal dropped
        if handler.path == "/v1/skill-drafts" and status == 200 and not dropped:
            dropped = True
            handler.close_connection = True
            return
        reply(handler, status, value)

    monkeypatch.setattr(Handler, "_reply", drop_receipt)
    result = cli(plans, "submit", plan_id)
    assert result.returncode == 1
    assert "same ID" in result.stderr
    assert counts(server) == (1, 0)
    restarted = plans.load(plan_id)
    assert restarted["skills"][0]["state"] == "receipt_pending"
    assert restarted["skills"][0]["job_id"] is None
    assert restarted["skills"][0]["request"] == plan["skills"][0]["request"]
    assert cli(plans, "status", plan_id).returncode == 0
    assert counts(server) == (1, 0)
    assert cli(plans, "submit", plan_id).returncode == 0
    Jobs(server.store).run_once(FixtureProvider())
    assert counts(server) == (1, 1)
    assert len(server.store.snapshot()["skills"]) == 1


def test_partial_batch_resumes_original_requests(server, plans):
    client = HELPER.Companion()
    plan_id, plan = HELPER.prepare(
        plans,
        client,
        {"skills": [definition(), definition(title="A second synthetic skill")]},
    )
    real_request = client.request
    posts = 0

    def interrupted(path, payload=None):
        nonlocal posts
        if payload is not None:
            posts += 1
            if posts == 2:
                raise HELPER.ImportError("Synthetic interruption")
        return real_request(path, payload)

    client.request = interrupted
    with pytest.raises(HELPER.ImportError):
        HELPER.refresh(plans, client, plan_id, plan, submit=True)
    original_ids = [entry["request"]["request_id"] for entry in plan["skills"]]
    assert counts(server) == (1, 0)
    restarted = plans.load(plan_id)
    HELPER.refresh(plans, HELPER.Companion(), plan_id, restarted, submit=True)
    assert [
        entry["request"]["request_id"] for entry in restarted["skills"]
    ] == original_ids
    assert counts(server) == (2, 0)
    assert all(entry["job_id"] for entry in restarted["skills"])


def test_local_write_failure_after_server_commit_is_safe_to_resume(
    server, plans, monkeypatch
):
    plan_id, plan = HELPER.prepare(
        plans, HELPER.Companion(), {"skills": [definition()]}
    )
    save = plans.save

    def fail_receipt_write(key, value):
        if value["skills"][0]["job_id"]:
            raise OSError("Synthetic disk failure")
        save(key, value)

    monkeypatch.setattr(plans, "save", fail_receipt_write)
    with pytest.raises(OSError):
        HELPER.refresh(plans, HELPER.Companion(), plan_id, plan, submit=True)
    assert counts(server) == (1, 0)
    monkeypatch.setattr(plans, "save", save)
    restarted = plans.load(plan_id)
    HELPER.refresh(plans, HELPER.Companion(), plan_id, restarted, submit=True)
    assert counts(server) == (1, 0)


def test_new_state_hierarchy_and_request_ids_are_synced_before_submission(
    server, tmp_path, monkeypatch
):
    root = tmp_path.resolve()
    folder = root / "new-hierarchy/share/learnrecur/imports"
    synced = set()
    fsync = os.fsync

    def record_sync(fd):
        info = os.fstat(fd)
        if stat.S_ISDIR(info.st_mode):
            synced.add((info.st_dev, info.st_ino))
        fsync(fd)

    monkeypatch.setattr(HELPER.os, "fsync", record_sync)
    plans = HELPER.Plans(folder)
    client = HELPER.Companion()
    plan_id, plan = HELPER.prepare(plans, client, {"skills": [definition()]})
    request = client.request

    def check_before_submission(path, payload=None):
        if payload is not None:
            for parent in (root, *reversed(folder.relative_to(root).parents)):
                # Include each new directory's parent, and the directory holding the plan.
                absolute = parent if parent.is_absolute() else root / parent
                info = absolute.stat()
                assert (info.st_dev, info.st_ino) in synced
            info = folder.stat()
            assert (info.st_dev, info.st_ino) in synced
            assert plans.load(plan_id)["skills"][0]["request"] == payload
        return request(path, payload)

    monkeypatch.setattr(client, "request", check_before_submission)
    HELPER.refresh(plans, client, plan_id, plan, submit=True)
    assert counts(server) == (1, 0)


def test_changed_companion_stops_before_submission(server, plans, monkeypatch):
    plan_id, plan = HELPER.prepare(
        plans, HELPER.Companion(), {"skills": [definition()]}
    )
    monkeypatch.setattr(
        HELPER.Companion, "source", lambda _: "5528c1f8-2792-4e70-8a47-75d48c397e02"
    )
    with pytest.raises(HELPER.ImportError, match="different companion"):
        HELPER.refresh(plans, HELPER.Companion(), plan_id, plan, submit=True)
    assert counts(server) == (0, 0)


@pytest.mark.parametrize(
    "state", ["failed", "obsolete", "needs_attention", "waiting_budget"]
)
def test_terminal_and_budget_states_never_create_replacement_jobs(server, plans, state):
    plan_id, plan = HELPER.prepare(
        plans, HELPER.Companion(), {"skills": [definition()]}
    )
    HELPER.refresh(plans, HELPER.Companion(), plan_id, plan, submit=True)
    job_id = plan["skills"][0]["job_id"]
    with server.store.connect() as db:
        db.execute("update generation_jobs set state=? where id=?", (state, job_id))
    assert cli(plans, "status", plan_id).returncode == 0
    assert cli(plans, "submit", plan_id).returncode == 0
    assert plans.load(plan_id)["skills"][0]["state"] == state
    assert counts(server) == (1, 0)


@pytest.mark.parametrize("state", ["failed", "needs_attention", "waiting_budget"])
def test_resume_stops_before_remaining_skills_when_a_job_needs_attention(
    server, plans, state
):
    plan_id, plan = HELPER.prepare(
        plans,
        HELPER.Companion(),
        {"skills": [definition(), definition(title="Second skill")]},
    )
    first = Jobs(server.store).create_skill(plan["skills"][0]["request"], "fixture")
    with server.store.connect() as db:
        db.execute(
            "update generation_jobs set state=? where id=?", (state, first["id"])
        )
    HELPER.refresh(plans, HELPER.Companion(), plan_id, plan, submit=True)
    assert plan["skills"][0]["state"] == state
    assert plan["skills"][1]["state"] == "prepared"
    assert counts(server) == (1, 0)


@pytest.mark.parametrize("field", ["id", "request_id", "description", "state"])
def test_mismatched_job_receipt_is_not_saved(server, plans, field):
    client = HELPER.Companion()
    plan_id, plan = HELPER.prepare(plans, client, {"skills": [definition()]})
    request = client.request

    def wrong_receipt(path, payload=None):
        result = request(path, payload)
        if payload is not None:
            if field == "description":
                result["request"][field] = "Different skill"
            else:
                result[field] = "wrong"
        return result

    client.request = wrong_receipt
    with pytest.raises(HELPER.ImportError):
        HELPER.refresh(plans, client, plan_id, plan, submit=True)
    assert plans.load(plan_id)["skills"][0]["job_id"] is None
    assert counts(server) == (1, 0)
    assert cli(plans, "submit", plan_id).returncode == 0
    assert counts(server) == (1, 0)


@pytest.mark.parametrize(
    "value",
    [
        {"skills": [], "source_text": "Original passage"},
        {"skills": []},
        {"skills": [definition(title="é" * 129)]},
        {"skills": [definition(description="\ud800")]},
        {"skills": [definition(examples=[{"prompt": "Incomplete"}])]},
        {
            "skills": [
                definition(
                    examples=[{"prompt": "p", "answer": "a", "explanation": "e"}] * 6
                )
            ]
        },
        {"skills": [definition(), definition()]},
        {"skills": [definition(description="No\x00controls")]},
        {
            "skills": [
                definition(
                    examples=[
                        {
                            "prompt": "x" * 8192,
                            "answer": "x" * 8192,
                            "explanation": "x" * 8192,
                        }
                    ]
                    * 5
                )
            ]
        },
    ],
)
def test_invalid_definitions_create_no_plan_or_job(server, plans, value):
    with pytest.raises(HELPER.ImportError):
        HELPER.prepare(plans, HELPER.Companion(), value)
    assert not list(plans.folder.glob("*.json"))
    assert counts(server) == (0, 0)


@pytest.mark.parametrize(
    "data",
    [
        b'{"skills":[],"skills":[]}',
        b'{"x":NaN}',
        b"{" * 2000,
        b"x" * (HELPER.MAX_BYTES + 1),
    ],
)
def test_json_input_is_bounded_and_unambiguous(data):
    with pytest.raises(HELPER.ImportError):
        HELPER.decode(data)


@pytest.mark.parametrize("status", [200, 302, 401, 409])
def test_oversized_and_error_responses_are_not_reflected(
    server, plans, monkeypatch, status
):
    def response(handler, _, value):
        handler.send_response(status)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Location", "http://127.0.0.1:1/")
        data = json.dumps({"secret": TOKEN, "padding": "x" * HELPER.MAX_BYTES}).encode()
        handler.send_header("Content-Length", str(len(data)))
        handler.end_headers()
        try:
            handler.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    monkeypatch.setattr(Handler, "_reply", response)
    result = cli(plans, "prepare", input_value={"skills": [definition()]})
    assert result.returncode == 1
    assert TOKEN not in result.stderr + result.stdout
    assert not list(plans.folder.glob("*.json"))


@pytest.mark.parametrize(
    "url",
    [
        "https://127.0.0.1:1",
        "http://localhost:1",
        "http://127.0.0.1:1/",
        "http://127.0.0.1:65536",
        "http://127.0.0.1:1@other",
    ],
)
def test_only_exact_loopback_urls_are_accepted(monkeypatch, url):
    monkeypatch.setenv("LEARNRECUR_COMPANION_URL", url)
    with pytest.raises(HELPER.ImportError, match="URL"):
        HELPER.Companion()


def test_private_state_rejects_repository_profile_and_link_paths(tmp_path):
    root = tmp_path.resolve()
    repo = root / "repo"
    repo.mkdir()
    (repo / ".git").mkdir()
    target = root / "safe"
    target.mkdir(mode=0o700)
    link = root / "linked"
    link.symlink_to(target, target_is_directory=True)
    for path in (
        repo / "state",
        root / "Anki2" / "state",
        root / "Application Support" / "LearnRecur",
        link / "state",
    ):
        with pytest.raises(HELPER.ImportError):
            HELPER.Plans(path)
    target.chmod(0o755)
    with pytest.raises(HELPER.ImportError, match="700"):
        HELPER.Plans(target)


def test_private_files_lock_and_local_preview(server, plans, monkeypatch):
    plan_id, plan = HELPER.prepare(
        plans, HELPER.Companion(), {"skills": [definition()]}
    )
    with plans.lock():
        assert cli(plans, "show", plan_id).returncode == 1
    monkeypatch.delenv("LEARNRECUR_COMPANION_TOKEN")
    monkeypatch.delenv("LEARNRECUR_COMPANION_URL")
    assert cli(plans, "show", plan_id).returncode == 0
    path = plans.folder / (plan_id + ".json")
    path.chmod(0o644)
    assert cli(plans, "show", plan_id).returncode == 1
    path.chmod(0o600)
    hardlink = plans.folder / "linked.json"
    os.link(path, hardlink)
    assert cli(plans, "show", plan_id).returncode == 1
    hardlink.unlink()
    real = plans.folder / "real.json"
    path.rename(real)
    path.symlink_to(real)
    assert cli(plans, "show", plan_id).returncode == 1


def test_changed_local_definition_conflicts_without_another_job(server, plans):
    plan_id, plan = HELPER.prepare(
        plans, HELPER.Companion(), {"skills": [definition()]}
    )
    payload = copy.deepcopy(plan["skills"][0]["request"])
    Jobs(server.store).create_skill(payload, "fixture")
    plan["skills"][0]["request"]["description"] = "Different definition"
    plans.save(plan_id, plan)
    result = cli(plans, "submit", plan_id)
    assert result.returncode == 1
    assert "conflicting" in result.stderr
    assert counts(server) == (1, 0)


def test_invalid_state_values_are_rejected_without_a_traceback(
    server, plans, monkeypatch
):
    client = HELPER.Companion()
    plan_id, plan = HELPER.prepare(plans, client, {"skills": [definition()]})
    real_request = client.request

    def invalid_state(path, payload=None):
        result = real_request(path, payload)
        if payload is not None:
            result["state"] = []
        return result

    monkeypatch.setattr(client, "request", invalid_state)
    with pytest.raises(HELPER.ImportError, match="receipt"):
        HELPER.refresh(plans, client, plan_id, plan, submit=True)
    plan["skills"][0]["state"] = []
    plans.save(plan_id, plan)
    result = cli(plans, "status", plan_id)
    assert result.returncode == 1
    assert "Traceback" not in result.stderr
    assert counts(server) == (1, 0)
