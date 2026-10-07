# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Receive versioned client reports and share the existing refill checkpoints."""

import re

from anki.learnrecur_limits import MAX_BATCHES
from anki.learnrecur_skill_import import SkillImportError, decode, encode
from learnrecur.companion.jobs import JobConflict, Jobs


def initialize(db):
    db.execute(
        "create table if not exists exercise_reports (report_id text primary key, "
        "skill_id text not null, revision integer not null, exercise_id text not null, "
        "version integer not null, active integer not null, payload text not null, job_id text)"
    )
    db.execute(
        "create index if not exists active_exercise_reports "
        "on exercise_reports(skill_id,revision,active)"
    )


class Reports:
    def __init__(self, store):
        self.store = store

    def receive(self, value, provider):
        fields = {
            "report_id",
            "version",
            "active",
            "source_id",
            "skill_id",
            "revision",
            "guid",
            "exercise_id",
            "reason",
            "exercise",
            "created_at_ms",
            "bank_sequence",
        }
        if not isinstance(value, dict) or set(value) != fields:
            raise SkillImportError("Supply a complete exercise report.")
        for field, pattern in (
            ("report_id", r"[0-9a-f]{32}"),
            ("guid", r"[0-9a-f]{32}"),
            ("skill_id", r"[a-zA-Z0-9_-]{1,128}"),
        ):
            if not isinstance(value[field], str) or not re.fullmatch(
                pattern, value[field]
            ):
                raise SkillImportError("Invalid report identity.")
        for field, maximum in (
            ("version", 9_007_199_254_740_990),
            ("revision", 100),
            ("created_at_ms", 9_007_199_254_740_990),
        ):
            if type(value[field]) is not int or not 1 <= value[field] <= maximum:
                raise SkillImportError("Invalid report version or timestamp.")
        if (
            type(value["active"]) is not bool
            or type(value["bank_sequence"]) is not int
            or not 0 <= value["bank_sequence"] <= MAX_BATCHES
            or not isinstance(value["reason"], str)
            or value["reason"] not in ("incorrect", "unclear", "out_of_scope", "other")
        ):
            raise SkillImportError("Invalid report state or reason.")
        # Bank sequence is delivery guidance, not part of the report's versioned state.
        payload = {k: value[k] for k in fields - {"version", "active", "bank_sequence"}}
        with self.store.connect() as db:
            db.execute("begin immediate")
            snapshot = self.store._snapshot(db)
            identity = snapshot["identities"].get(value["skill_id"])
            if (
                value["source_id"] != snapshot["source_id"]
                or not identity
                or value["guid"] != identity["guid"]
            ):
                raise JobConflict("Report a skill imported from this companion.")
            key, revision = value["skill_id"], value["revision"]
            skill = next(s for s in snapshot["skills"] if s["id"] == key)
            versions = [skill, *snapshot.get("previous_revisions", {}).get(key, [])]
            exercises = [
                e
                for s in versions
                if s["bank"]["revision"] == revision
                for e in s["bank"]["exercises"]
            ]
            exercises.extend(
                e
                for b in snapshot.get("bank_updates", {}).get(key, [])
                if b["revision"] == revision
                for e in b["exercises"]
            )
            expected = next(
                (e for e in exercises if e["id"] == value["exercise_id"]), None
            )
            if expected is None or value["exercise"] != expected:
                raise JobConflict(
                    "The reported exercise does not match its published revision."
                )
            encoded = encode(payload)
            saved = db.execute(
                "select version,active,payload,job_id from exercise_reports where report_id=?",
                (value["report_id"],),
            ).fetchone()
            if saved:
                old = decode(saved[2].encode())
                if any(
                    old[k] != payload[k]
                    for k in (
                        "source_id",
                        "guid",
                        "skill_id",
                        "revision",
                        "exercise_id",
                    )
                ):
                    raise JobConflict(
                        "This report identity belongs to another exercise."
                    )
                if saved[0] == value["version"] and (
                    saved[1] != value["active"] or saved[2] != encoded
                ):
                    raise JobConflict("This report version has different content.")
            elif (
                db.execute("select count(*) from exercise_reports").fetchone()[0]
                >= 10000
            ):
                raise JobConflict("The report history is full.")
            if saved is None or value["version"] > saved[0]:
                db.execute(
                    "insert into exercise_reports values(?,?,?,?,?,?,?,null) "
                    "on conflict(report_id) do update set version=excluded.version,"
                    "active=excluded.active,payload=excluded.payload",
                    (
                        value["report_id"],
                        key,
                        revision,
                        value["exercise_id"],
                        value["version"],
                        value["active"],
                        encoded,
                    ),
                )
            version, active, job_id = db.execute(
                "select version,active,job_id from exercise_reports where report_id=?",
                (value["report_id"],),
            ).fetchone()
            result = {"status": "recorded", "job_id": job_id}
            if job_id:
                result["status"] = db.execute(
                    "select state from generation_jobs where id=?", (job_id,)
                ).fetchone()[0]
            if active and not job_id and skill["bank"]["revision"] == revision:
                db.execute("savepoint report_replacement")
                try:
                    result = Jobs(self.store).request_refill(
                        {
                            "source_id": snapshot["source_id"],
                            "skill_id": key,
                            "revision": revision,
                            "bank_sequence": value["bank_sequence"],
                            "remaining": 0,
                        },
                        provider,
                        _db=db,
                    )
                except (JobConflict, SkillImportError):
                    db.execute("rollback to report_replacement")
                    result = {"status": "blocked", "job_id": None}
                db.execute("release report_replacement")
                if result["job_id"]:
                    context = decode(
                        db.execute(
                            "select context from generation_jobs where id=?",
                            (result["job_id"],),
                        )
                        .fetchone()[0]
                        .encode()
                    )["skill"]
                    if context["id"] == key and context["bank"]["revision"] == revision:
                        db.execute(
                            "update exercise_reports set job_id=? where report_id=?",
                            (result["job_id"], value["report_id"]),
                        )
                    else:
                        # A store-wide uncertain charge blocks work but cannot
                        # become this skill's permanent replacement job.
                        result["job_id"] = None
            return {
                "report_id": value["report_id"],
                "version": version,
                "active": bool(active),
                **result,
            }
