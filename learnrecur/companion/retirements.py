# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Retire skills that a client deleted, with versioned requests it can withdraw."""

import re
import time

from anki.learnrecur_skill_import import SkillImportError, decode

RETIRED_ERROR = "The skill was deleted."
MAX_RETIREMENTS = 10000
# Jobs in these states hold no lease, so stopping them can't lose a charge.
IDLE_STATES = (
    "queued",
    "retry_wait",
    "waiting_budget",
    "waiting_capacity",
    "result_ready",
)


def initialize(db):
    db.execute(
        "create table if not exists skill_retirements (retirement_id text primary key, "
        "skill_id text not null, guid text not null, native_id integer not null, "
        "version integer not null, active integer not null, received_at real not null)"
    )
    db.execute(
        "create index if not exists active_skill_retirements "
        "on skill_retirements(skill_id,active)"
    )


def retired_skill_ids(db):
    # A request applies only to the skill identity it names. One for a skill
    # this store doesn't have changes nothing, even if that ID is used later.
    return {
        row[0]
        for row in db.execute(
            "select r.skill_id from skill_retirements r join identities i "
            "on i.skill_id=r.skill_id and i.guid=r.guid and i.native_id=r.native_id "
            "where r.active=1"
        )
    }


def is_retired(db, skill_id):
    return skill_id in retired_skill_ids(db)


class Retirements:
    def __init__(self, store, *, clock=time.time):
        self.store = store
        self.clock = clock

    def receive(self, value):
        fields = {
            "retirement_id",
            "version",
            "active",
            "source_id",
            "skill_id",
            "guid",
            "native_id",
        }
        if not isinstance(value, dict) or set(value) != fields:
            raise SkillImportError("Supply a complete skill retirement.")
        for field, pattern in (
            ("retirement_id", r"[0-9a-f]{32}"),
            ("guid", r"[0-9a-f]{32}"),
            ("skill_id", r"[a-zA-Z0-9_-]{1,128}"),
        ):
            if not isinstance(value[field], str) or not re.fullmatch(
                pattern, value[field]
            ):
                raise SkillImportError("Invalid skill retirement identity.")
        for field in ("version", "native_id"):
            if type(value[field]) is not int or not 1 <= value[field] < 2**53 - 1:
                raise SkillImportError("Invalid skill retirement version or ID.")
        if type(value["active"]) is not bool:
            raise SkillImportError("Invalid skill retirement state.")
        from learnrecur.companion.jobs import JobConflict

        key = value["skill_id"]
        with self.store.connect() as db:
            db.execute("begin immediate")
            source = db.execute(
                "select value from metadata where key='source_id'"
            ).fetchone()[0]
            if value["source_id"] != source:
                raise JobConflict("Retire a skill imported from this companion.")
            identity = db.execute(
                "select native_id,guid from identities where skill_id=?", (key,)
            ).fetchone()
            if identity and identity != (value["native_id"], value["guid"]):
                raise JobConflict("This skill has a different identity here.")
            saved = db.execute(
                "select version,active,skill_id,guid,native_id from skill_retirements "
                "where retirement_id=?",
                (value["retirement_id"],),
            ).fetchone()
            if saved:
                if saved[2:] != (key, value["guid"], value["native_id"]):
                    raise JobConflict("This retirement belongs to another skill.")
                if saved[0] == value["version"] and saved[1] != value["active"]:
                    raise JobConflict("This retirement version has a different state.")
            elif (
                db.execute("select count(*) from skill_retirements").fetchone()[0]
                >= MAX_RETIREMENTS
            ):
                raise JobConflict("The retirement history is full.")
            # The newest version wins, so a delayed request can't undo a later one.
            if saved is None or value["version"] > saved[0]:
                db.execute(
                    "insert into skill_retirements values(?,?,?,?,?,?,?) "
                    "on conflict(retirement_id) do update set "
                    "version=excluded.version,active=excluded.active,"
                    "received_at=excluded.received_at",
                    (
                        value["retirement_id"],
                        key,
                        value["guid"],
                        value["native_id"],
                        value["version"],
                        value["active"],
                        self.clock(),
                    ),
                )
            version, active = db.execute(
                "select version,active from skill_retirements where retirement_id=?",
                (value["retirement_id"],),
            ).fetchone()
            retired = is_retired(db, key)
            if retired:
                obsolete_idle_jobs(db, key)
            return {
                "retirement_id": value["retirement_id"],
                "version": version,
                "active": bool(active),
                "status": "retired" if retired else "active" if identity else "unknown",
            }


def obsolete_idle_jobs(db, skill_id):
    """Stop waiting work for a retired skill now, keeping every recorded charge.

    Running and pending jobs finish their current call; the worker then sees the
    retirement and marks them obsolete without publishing.
    """
    for job_id, context in db.execute(
        "select id,context from generation_jobs where state in (%s)"
        % ",".join("?" * len(IDLE_STATES)),
        IDLE_STATES,
    ).fetchall():
        if decode(context.encode())["skill"]["id"] != skill_id:
            continue
        if db.execute(
            "select 1 from generation_attempts where job_id=? and net_actual is null",
            (job_id,),
        ).fetchone():
            continue
        db.execute(
            "update generation_jobs set state='obsolete',error=? where id=?",
            (RETIRED_ERROR, job_id),
        )
