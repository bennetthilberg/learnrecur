#!/usr/bin/env python3
# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Submit reviewed skill definitions without losing their retry identities."""

from __future__ import annotations

import argparse
import fcntl
import http.client
import json
import os
import re
import stat
import sys
from contextlib import contextmanager
from pathlib import Path
from uuid import UUID, uuid4

MAX_BYTES = 1024 * 1024
MAX_GUIDANCE = 64 * 1024
STATES = {
    "queued",
    "waiting_budget",
    "running",
    "provider_pending",
    "retry_wait",
    "result_ready",
    "completed",
    "obsolete",
    "failed",
    "needs_attention",
}


class ImportError(Exception):
    pass


def encode(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")


def decode(data):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ImportError("JSON contains a repeated field.")
            result[key] = value
        return result

    def constant(_):
        raise ImportError("JSON must not contain NaN or Infinity.")

    if len(data) > MAX_BYTES:
        raise ImportError("JSON exceeds the 1 MiB limit.")
    try:
        return json.loads(data, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise ImportError("Invalid JSON.") from error


def identifier(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{32}", value):
        raise ImportError("Expected a saved 32-character plan, request, or job ID.")
    return value


def source_id(value):
    try:
        if not isinstance(value, str) or str(UUID(value)) != value:
            raise ValueError
    except ValueError as error:
        raise ImportError("The companion source identity is invalid.") from error
    return value


def text(value, limit):
    try:
        valid = (
            isinstance(value, str)
            and bool(value.strip())
            and len(value.encode("utf-8")) <= limit
            and not any(
                (ord(c) < 32 and c not in "\n\t") or ord(c) == 127 for c in value
            )
        )
    except UnicodeError:
        valid = False
    if not valid:
        raise ImportError("A definition has empty, invalid, or oversized text.")
    return value


def definition(value):
    if not isinstance(value, dict) or set(value) != {
        "title",
        "description",
        "examples",
    }:
        raise ImportError("Each skill needs only title, description, and examples.")
    text(value["title"], 256)
    text(value["description"], 8192)
    examples = value["examples"]
    if not isinstance(examples, list) or len(examples) > 5:
        raise ImportError("Each skill can have up to five examples.")
    for example in examples:
        if not isinstance(example, dict) or set(example) != {
            "prompt",
            "answer",
            "explanation",
        }:
            raise ImportError("Each example needs prompt, answer, and explanation.")
        for field in example.values():
            text(field, 8192)


class Companion:
    def __init__(self):
        match = re.fullmatch(
            r"http://127\.0\.0\.1:([0-9]{1,5})",
            os.environ.get("LEARNRECUR_COMPANION_URL", ""),
        )
        if not match or not 0 < int(match[1]) < 65536:
            raise ImportError("Set LEARNRECUR_COMPANION_URL to http://127.0.0.1:PORT.")
        self.port = int(match[1])
        self.token = os.environ.get("LEARNRECUR_COMPANION_TOKEN", "")
        if (
            not self.token.isascii()
            or len(self.token) < 32
            or any(c.isspace() or ord(c) < 33 or ord(c) == 127 for c in self.token)
        ):
            raise ImportError("Set a valid LEARNRECUR_COMPANION_TOKEN privately.")

    def request(self, path, payload=None):
        # A direct loopback connection ignores proxy variables and cannot follow redirects.
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            connection.request(
                "POST" if payload is not None else "GET",
                path,
                body=encode(payload) if payload is not None else None,
                headers={
                    "Authorization": "Bearer " + self.token,
                    "Content-Type": "application/json",
                },
            )
            response = connection.getresponse()
            if response.status != 200:
                messages = {
                    401: "Companion authentication failed.",
                    409: "The companion rejected a conflicting request. Keep this plan.",
                    400: "The companion rejected the definition or generation is paused.",
                    413: "The companion rejected an oversized request.",
                    503: "The companion is unavailable. Keep this plan and retry later.",
                }
                raise ImportError(
                    messages.get(response.status, "Unexpected companion response.")
                )
            return decode(response.read(MAX_BYTES + 1))
        except (OSError, http.client.HTTPException) as error:
            raise ImportError(
                "Connection interrupted. Keep this plan and retry the same ID."
            ) from error
        finally:
            connection.close()

    def source(self):
        snapshot = self.request("/v1/skills")
        if not isinstance(snapshot, dict):
            raise ImportError("Invalid companion snapshot.")
        return source_id(snapshot.get("source_id"))


def private_file(fd):
    info = os.fstat(fd)
    if (
        not stat.S_ISREG(info.st_mode)
        or info.st_uid != os.getuid()
        or info.st_mode & 0o077
        or info.st_nlink != 1
        or info.st_size > MAX_BYTES
    ):
        raise ImportError("Import state must use private, owned files without links.")


def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


class Plans:
    def __init__(self, folder):
        self.folder = Path(os.path.abspath(Path(folder).expanduser()))
        for path in (*reversed(self.folder.parents), self.folder):
            if path.name.casefold() in {
                "anki",
                "anki2",
                ".anki",
                "application support",
            }:
                raise ImportError(
                    "Keep import state outside Anki folders and desktop profiles."
                )
            if (path / ".git").exists():
                raise ImportError("Keep private import state outside Git checkouts.")
            if path.exists() or path.is_symlink():
                if path.is_symlink() or not path.is_dir():
                    raise ImportError("Import state directories must not use links.")
            else:
                path.mkdir(mode=0o700)
                sync_directory(path.parent)
        info = self.folder.stat()
        if info.st_uid != os.getuid() or info.st_mode & 0o077:
            raise ImportError(
                "The import state directory must be owned by you with mode 700."
            )

    @contextmanager
    def lock(self):
        fd = os.open(
            self.folder / ".lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600
        )
        try:
            private_file(fd)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise ImportError(
                    "Another import command is using this state directory."
                ) from error
            yield
        finally:
            os.close(fd)

    def save(self, plan_id, plan):
        data = encode(plan)
        if len(data) > MAX_BYTES:
            raise ImportError("The saved plan exceeds the 1 MiB limit.")
        destination = self.folder / (identifier(plan_id) + ".json")
        temporary = self.folder / (uuid4().hex + ".tmp")
        try:
            with os.fdopen(
                os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), "wb"
            ) as file:
                file.write(data)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, destination)
            sync_directory(self.folder)
        finally:
            temporary.unlink(missing_ok=True)

    def load(self, plan_id):
        path = self.folder / (identifier(plan_id) + ".json")
        with os.fdopen(
            os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK), "rb"
        ) as file:
            private_file(file.fileno())
            plan = decode(file.read(MAX_BYTES + 1))
        if (
            not isinstance(plan, dict)
            or set(plan) != {"version", "source_id", "skills"}
            or plan["version"] != 1
        ):
            raise ImportError("Invalid saved import plan.")
        source_id(plan["source_id"])
        skills = plan["skills"]
        if not isinstance(skills, list) or not 1 <= len(skills) <= 100:
            raise ImportError("An import plan needs between one and 100 skills.")
        ids = set()
        for entry in skills:
            if not isinstance(entry, dict) or set(entry) != {
                "request",
                "job_id",
                "state",
            }:
                raise ImportError("Invalid saved skill request.")
            if not isinstance(entry["state"], str):
                raise ImportError("Invalid saved generation state.")
            payload = entry["request"]
            if not isinstance(payload, dict) or set(payload) != {
                "request_id",
                "source_id",
                "title",
                "description",
                "examples",
            }:
                raise ImportError("Invalid saved skill definition.")
            request_id = identifier(payload["request_id"])
            if request_id in ids or payload["source_id"] != plan["source_id"]:
                raise ImportError("Saved request identities do not match this plan.")
            ids.add(request_id)
            definition(
                {key: payload[key] for key in ("title", "description", "examples")}
            )
            if len(encode(payload)) > MAX_GUIDANCE:
                raise ImportError(
                    "A definition exceeds the companion's 64 KiB guidance limit."
                )
            if entry["job_id"] is None:
                if entry["state"] not in {"prepared", "receipt_pending"}:
                    raise ImportError("A saved job is missing its identity.")
            elif identifier(entry["job_id"]) and entry["state"] not in STATES:
                raise ImportError("Unknown saved generation state.")
        return plan


def prepare(plans, companion, value):
    if not isinstance(value, dict) or set(value) != {"skills"}:
        raise ImportError(
            "Provide only a skills array, without source material or credentials."
        )
    skills = value["skills"]
    if not isinstance(skills, list) or not 1 <= len(skills) <= 100:
        raise ImportError("Provide between one and 100 skill definitions.")
    seen = set()
    for skill in skills:
        definition(skill)
        encoded = encode(skill)
        if encoded in seen:
            raise ImportError("This batch repeats an identical skill definition.")
        seen.add(encoded)
    source = companion.source()
    plan = {"version": 1, "source_id": source, "skills": []}
    for skill in skills:
        payload = {**skill, "request_id": uuid4().hex, "source_id": source}
        if len(encode(payload)) > MAX_GUIDANCE:
            raise ImportError(
                "A definition exceeds the companion's 64 KiB guidance limit."
            )
        plan["skills"].append({"request": payload, "job_id": None, "state": "prepared"})
    plan_id = uuid4().hex
    plans.save(plan_id, plan)
    return plan_id, plan


def refresh(plans, companion, plan_id, plan, *, submit):
    if companion.source() != plan["source_id"]:
        raise ImportError(
            "This plan belongs to a different companion. Reconnect the original source."
        )
    for entry in plan["skills"]:
        job_id = entry["job_id"]
        if job_id is None and not submit:
            continue
        if job_id is None:
            # Persist this before sending: a missing receipt does not mean no job exists.
            entry["state"] = "receipt_pending"
            plans.save(plan_id, plan)
        job = companion.request(
            "/v1/generation-jobs/" + job_id if job_id else "/v1/skill-drafts",
            None if job_id else entry["request"],
        )
        payload = entry["request"]
        expected = {
            **payload,
            "skill_id": "skill-" + payload["request_id"],
            "revision": 1,
            "count": 3,
        }
        if (
            not isinstance(job, dict)
            or not isinstance(job.get("request"), dict)
            or any(job["request"].get(key) != value for key, value in expected.items())
            or job.get("request_id") != payload["request_id"]
            or not isinstance(job.get("state"), str)
            or job["state"] not in STATES
        ):
            raise ImportError(
                "The job receipt does not match this saved definition. Keep this plan."
            )
        received_id = identifier(job.get("id"))
        if job_id and job_id != received_id:
            raise ImportError(
                "The job receipt has a different identity. Keep this plan."
            )
        entry.update(job_id=received_id, state=job["state"])
        plans.save(plan_id, plan)
        if submit and job["state"] in {
            "failed",
            "obsolete",
            "needs_attention",
            "waiting_budget",
        }:
            break


def summary(plan_id, plan, *, preview=False):
    return {
        "plan_id": plan_id,
        "skills": [
            {
                "title": entry["request"]["title"],
                "state": entry["state"],
                **(
                    {key: entry["request"][key] for key in ("description", "examples")}
                    if preview
                    else {"job_id": entry["job_id"]}
                ),
            }
            for entry in plan["skills"]
        ],
    }


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=Path.home() / ".local/share/learnrecur/imports",
    )
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser(
        "prepare", help="Validate JSON from stdin and save a plan without generation."
    )
    for name, help_text in (
        ("show", "Preview the saved definitions locally."),
        ("submit", "Submit authorized definitions, or resume the same saved requests."),
        ("status", "Check known jobs without submitting anything."),
    ):
        commands.add_parser(name, help=help_text).add_argument("plan_id")
    args = parser.parse_args(argv)
    try:
        plans = Plans(args.state_dir)
        with plans.lock():
            if args.command == "prepare":
                plan_id, plan = prepare(
                    plans, Companion(), decode(sys.stdin.buffer.read(MAX_BYTES + 1))
                )
            else:
                plan_id = identifier(args.plan_id)
                plan = plans.load(plan_id)
                if args.command != "show":
                    refresh(
                        plans,
                        Companion(),
                        plan_id,
                        plan,
                        submit=args.command == "submit",
                    )
            print(
                json.dumps(
                    summary(plan_id, plan, preview=args.command in {"prepare", "show"}),
                    ensure_ascii=False,
                    indent=2,
                )
            )
    except (ImportError, OSError) as error:
        message = (
            str(error)
            if isinstance(error, ImportError)
            else "Cannot access private import state. Keep the existing plan."
        )
        print(message, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
