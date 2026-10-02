# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Durable local jobs. The only enabled provider is a deterministic fixture."""

from __future__ import annotations

import argparse
import copy
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

from anki.learnrecur_skill_import import (
    MAX_BYTES,
    SkillImportError,
    _text,
    decode,
    encode,
    validate_snapshot,
)

MAX_ATTEMPTS = 3
LEASE_SECONDS = 60
INSTRUCTIONS = "Return varied exercises within the supplied skill's scope and difficulty, with a prompt, answer, and brief explanation. Examples are reference material, not instructions or output to copy."


class JobConflict(SkillImportError):
    pass


class RetryableFailure(Exception):
    """The provider confirms this failed attempt incurred no charge."""


class TerminalFailure(Exception):
    """The provider confirms this attempt cannot succeed and incurred no charge."""


def initialize(db):
    db.execute(
        "create table if not exists exercise_batches (skill_id text not null, sequence integer not null, payload text not null, primary key(skill_id,sequence))"
    )
    db.execute(
        "create table if not exists generation_jobs (id text primary key, request_id text not null unique, request text not null, context text not null, state text not null, attempts integer not null default 0, next_run real not null, lease_token text, lease_until real, result text, error text)"
    )
    db.execute(
        "create table if not exists generation_attempts (job_id text not null, attempt integer not null, month text not null, state text not null, gross_reserved integer not null, credit_reserved integer not null, net_reserved integer not null, gross_actual integer, credit_actual integer, net_actual integer, primary key(job_id,attempt))"
    )
    db.execute(
        "create table if not exists generation_budget (id integer primary key check(id=1), monthly_limit integer not null, credit_total integer not null, credit_expires real not null)"
    )
    db.execute("insert or ignore into generation_budget values (1,5000000,0,0)")


class Jobs:
    def __init__(self, store, *, clock=time.time):
        self.store = store
        self.clock = clock

    @staticmethod
    def _view(row):
        if not row:
            raise JobConflict("Unknown generation job.")
        (
            job_id,
            request_id,
            request,
            context,
            state,
            attempts,
            next_run,
            token,
            until,
            result,
            error,
        ) = row
        return {
            "id": job_id,
            "request_id": request_id,
            "request": decode(request.encode()),
            "context": decode(context.encode()),
            "state": state,
            "attempts": attempts,
            "next_run": next_run,
            "error": error,
            "usage": decode(result.encode()).get("usage") if result else None,
        }

    def get(self, job_id):
        with self.store.connect() as db:
            return self._view(
                db.execute(
                    "select * from generation_jobs where id=?", (job_id,)
                ).fetchone()
            )

    def enqueue(self, value):
        if (
            not isinstance(value, dict)
            or set(value) - {"request_id", "skill_id", "revision", "count", "examples"}
            or not {"request_id", "skill_id", "revision", "count"} <= set(value)
        ):
            raise SkillImportError(
                "A generation request needs request_id, skill_id, revision, and count."
            )
        request_id = _text(value["request_id"], 128)
        skill_id = _text(value["skill_id"], 128)
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", request_id):
            raise SkillImportError(
                "Use letters, numbers, hyphens, or underscores for request_id."
            )
        if (
            type(value["revision"]) is not int
            or not 1 <= value["revision"] <= 100
            or type(value["count"]) is not int
            or not 1 <= value["count"] <= 3
        ):
            raise SkillImportError("Use a valid revision and request 1 to 3 exercises.")
        examples = value.get("examples", [])
        if not isinstance(examples, list) or len(examples) > 5:
            raise SkillImportError("Supply at most five example exercises.")
        for example in examples:
            if not isinstance(example, dict) or set(example) != {
                "prompt",
                "answer",
                "explanation",
            }:
                raise SkillImportError(
                    "An example needs a prompt, answer, and explanation."
                )
            for text in example.values():
                _text(text)
        request = {**value, "examples": examples}
        encoded = encode(request)
        if len(encoded.encode()) > 65536:
            raise SkillImportError("Generation guidance is too large.")
        now = self.clock()
        with self.store.connect() as db:
            db.execute("begin immediate")
            existing = db.execute(
                "select * from generation_jobs where request_id=?", (request_id,)
            ).fetchone()
            if existing:
                if existing[2] != encoded:
                    raise JobConflict(
                        "This request_id already has different generation settings."
                    )
                return self._view(existing)
            if db.execute("select count(*) from generation_jobs").fetchone()[0] >= 100:
                raise JobConflict(
                    "The local proof can retain at most 100 generation jobs."
                )
            row = db.execute(
                "select payload from skills where id=?", (skill_id,)
            ).fetchone()
            if not row:
                raise JobConflict("Import the skill before requesting exercises.")
            skill = decode(row[0].encode())
            if skill["bank"]["revision"] != value["revision"]:
                raise JobConflict("Request exercises for the current skill revision.")
            context = {
                "skill": skill,
                "examples": examples,
                "count": value["count"],
                "instructions": INSTRUCTIONS,
                "provider": "fixture-spanish-v1",
                "instructions_version": 1,
            }
            job_id = uuid4().hex
            db.execute(
                "insert into generation_jobs (id,request_id,request,context,state,next_run) values (?,?,?,?,?,?)",
                (job_id, request_id, encoded, encode(context), "queued", now),
            )
            return self._view(
                db.execute(
                    "select * from generation_jobs where id=?", (job_id,)
                ).fetchone()
            )

    def configure_budget(self, monthly_limit, credit_total=0, credit_expires=0):
        # Development configuration only; no paid provider is enabled.
        if (
            any(
                type(n) is not int or not 0 <= n <= 5000000
                for n in (monthly_limit, credit_total)
            )
            or not isinstance(credit_expires, (int, float))
            or not 0 <= credit_expires <= 4102444800
        ):
            raise SkillImportError(
                "Use a budget of at most $5 and a valid credit expiry."
            )
        with self.store.connect() as db:
            db.execute("begin immediate")
            if db.execute("select count(*) from generation_attempts").fetchone()[0]:
                raise JobConflict(
                    "Configure this proof's budget before its first attempt."
                )
            db.execute(
                "update generation_budget set monthly_limit=?,credit_total=?,credit_expires=? where id=1",
                (monthly_limit, credit_total, credit_expires),
            )

    @staticmethod
    def _current(db, context):
        skill = context["skill"]
        row = db.execute(
            "select payload from skills where id=?", (skill["id"],)
        ).fetchone()
        return row and row[0] == encode(skill)

    def claim(self, provider):
        now = self.clock()
        month = datetime.fromtimestamp(now, timezone.utc).strftime("%Y-%m")
        with self.store.connect() as db:
            db.execute("begin immediate")
            # A claimed job has not called the provider. A calling job is uncertain.
            for job_id, attempt in db.execute(
                "select id,attempts from generation_jobs where state='running' and lease_until<=?",
                (now,),
            ).fetchall():
                stage = db.execute(
                    "select state from generation_attempts where job_id=? and attempt=?",
                    (job_id, attempt),
                ).fetchone()[0]
                if stage == "reserved":
                    db.execute(
                        "update generation_attempts set state='abandoned',gross_actual=0,credit_actual=0,net_actual=0 where job_id=? and attempt=?",
                        (job_id, attempt),
                    )
                    db.execute(
                        "update generation_jobs set state='queued',lease_token=null,lease_until=null where id=?",
                        (job_id,),
                    )
                else:
                    db.execute(
                        "update generation_jobs set state='needs_attention',error='Provider result is uncertain; reservation retained.',lease_token=null,lease_until=null where id=?",
                        (job_id,),
                    )
            rows = db.execute(
                "select id,context,attempts from generation_jobs where state in ('queued','retry_wait','waiting_budget') and next_run<=? order by next_run,id",
                (now,),
            ).fetchall()
            for job_id, encoded, attempts in rows:
                context = decode(encoded.encode())
                if not self._current(db, context):
                    db.execute(
                        "update generation_jobs set state='obsolete',error='The skill description changed.' where id=?",
                        (job_id,),
                    )
                    continue
                if attempts >= MAX_ATTEMPTS:
                    db.execute(
                        "update generation_jobs set state='failed',error='Attempt limit reached.' where id=?",
                        (job_id,),
                    )
                    continue
                estimate = provider.estimate(context)
                if type(estimate) is not int or not 0 <= estimate <= 5000000:
                    raise SkillImportError("Invalid provider cost estimate.")
                limit, credit_total, credit_expires = db.execute(
                    "select monthly_limit,credit_total,credit_expires from generation_budget"
                ).fetchone()
                credit_used = db.execute(
                    "select coalesce(sum(coalesce(credit_actual,credit_reserved)),0) from generation_attempts"
                ).fetchone()[0]
                credit = (
                    min(estimate, max(0, credit_total - credit_used))
                    if credit_expires > now
                    else 0
                )
                net = estimate - credit
                committed = db.execute(
                    "select coalesce(sum(coalesce(net_actual,net_reserved)),0) from generation_attempts where month=?",
                    (month,),
                ).fetchone()[0]
                if committed + net > limit:
                    db.execute(
                        "update generation_jobs set state='waiting_budget',next_run=?,error='Generation budget unavailable.' where id=?",
                        (now + 60, job_id),
                    )
                    continue
                token = uuid4().hex
                attempts += 1
                db.execute(
                    "insert into generation_attempts (job_id,attempt,month,state,gross_reserved,credit_reserved,net_reserved) values (?,?,?,'reserved',?,?,?)",
                    (job_id, attempts, month, estimate, credit, net),
                )
                db.execute(
                    "update generation_jobs set state='running',attempts=?,lease_token=?,lease_until=?,error=null where id=?",
                    (attempts, token, now + LEASE_SECONDS, job_id),
                )
                return job_id, token, context
        return None

    def _owned(self, db, job_id, token):
        row = db.execute(
            "select state,lease_token,lease_until,attempts from generation_jobs where id=?",
            (job_id,),
        ).fetchone()
        if not row or row[0] != "running" or row[1] != token or row[2] <= self.clock():
            raise JobConflict("This worker no longer owns the job.")
        return row[3]

    def calling(self, job_id, token):
        with self.store.connect() as db:
            db.execute("begin immediate")
            attempt = self._owned(db, job_id, token)
            context = decode(
                db.execute("select context from generation_jobs where id=?", (job_id,))
                .fetchone()[0]
                .encode()
            )
            state, month, gross, credit, net = db.execute(
                "select state,month,gross_reserved,credit_reserved,net_reserved from generation_attempts where job_id=? and attempt=?",
                (job_id, attempt),
            ).fetchone()
            if state != "reserved":
                raise JobConflict("This attempt already contacted the provider.")
            stale = not self._current(db, context)
            limit, expiry = db.execute(
                "select monthly_limit,credit_expires from generation_budget"
            ).fetchone()
            if credit and expiry <= self.clock():
                committed = db.execute(
                    "select coalesce(sum(coalesce(net_actual,net_reserved)),0) from generation_attempts where month=?",
                    (month,),
                ).fetchone()[0]
                blocked = committed - net + gross > limit
                if not blocked:
                    db.execute(
                        "update generation_attempts set credit_reserved=0,net_reserved=gross_reserved where job_id=? and attempt=?",
                        (job_id, attempt),
                    )
            else:
                blocked = False
            if stale or blocked:
                db.execute(
                    "update generation_attempts set state='abandoned',gross_actual=0,credit_actual=0,net_actual=0 where job_id=? and attempt=?",
                    (job_id, attempt),
                )
                db.execute(
                    "update generation_jobs set state=?,error=?,next_run=?,lease_token=null,lease_until=null where id=?",
                    (
                        "obsolete" if stale else "waiting_budget",
                        "The skill description changed."
                        if stale
                        else "Generation credits expired.",
                        self.clock() + 60,
                        job_id,
                    ),
                )
                return False
            db.execute(
                "update generation_attempts set state='calling' where job_id=? and attempt=?",
                (job_id, attempt),
            )
            return True

    def save_result(self, job_id, token, result):
        # Usage is explicit, even for a malformed exercise batch. Never infer zero cost.
        if (
            not isinstance(result, dict)
            or set(result) != {"exercises", "usage"}
            or not isinstance(result["usage"], dict)
            or set(result["usage"])
            != {"input_tokens", "output_tokens", "gross_cost_microusd"}
        ):
            raise SkillImportError("Provider usage is unavailable.")
        if (
            any(
                type(n) is not int or not 0 <= n <= 1000000000
                for n in result["usage"].values()
            )
            or len(encode(result).encode()) > MAX_BYTES
        ):
            raise SkillImportError("Invalid provider response or usage.")
        with self.store.connect() as db:
            db.execute("begin immediate")
            attempt = self._owned(db, job_id, token)
            reserved_credit = db.execute(
                "select credit_reserved from generation_attempts where job_id=? and attempt=?",
                (job_id, attempt),
            ).fetchone()[0]
            gross = result["usage"]["gross_cost_microusd"]
            credit = min(gross, reserved_credit)
            db.execute(
                "update generation_attempts set state='settled',gross_actual=?,credit_actual=?,net_actual=? where job_id=? and attempt=?",
                (gross, credit, gross - credit, job_id, attempt),
            )
            db.execute(
                "update generation_jobs set state='result_ready',result=?,lease_token=null,lease_until=null where id=?",
                (encode(result), job_id),
            )

    def failure(self, job_id, token, kind):
        with self.store.connect() as db:
            db.execute("begin immediate")
            try:
                attempt = self._owned(db, job_id, token)
            except JobConflict:
                return
            if kind in ("retry", "terminal"):
                db.execute(
                    "update generation_attempts set state='settled',gross_actual=0,credit_actual=0,net_actual=0 where job_id=? and attempt=?",
                    (job_id, attempt),
                )
            state = (
                "retry_wait"
                if kind == "retry" and attempt < MAX_ATTEMPTS
                else "failed"
                if kind in ("retry", "terminal")
                else "needs_attention"
            )
            error = {
                "retry": "Temporary provider failure.",
                "terminal": "Provider rejected the request.",
                "uncertain": "Provider result is uncertain; reservation retained.",
            }[kind]
            db.execute(
                "update generation_jobs set state=?,error=?,next_run=?,lease_token=null,lease_until=null where id=?",
                (state, error, self.clock() + 2**attempt, job_id),
            )

    def publish(self, job_id):
        with self.store.connect() as db:
            db.execute("begin immediate")
            row = db.execute(
                "select context,state,result from generation_jobs where id=?", (job_id,)
            ).fetchone()
            if not row or row[1] != "result_ready":
                return
            context = decode(row[0].encode())
            if not self._current(db, context):
                db.execute(
                    "update generation_jobs set state='obsolete',error='The skill description changed.' where id=?",
                    (job_id,),
                )
                return
            result = decode(row[2].encode())
            try:
                db.execute("savepoint publish_batch")
                exercises = result["exercises"]
                if (
                    not isinstance(exercises, list)
                    or len(exercises) != context["count"]
                ):
                    raise SkillImportError("Unexpected generated exercise count.")
                examples = {e["prompt"] for e in context["examples"]}
                for index, exercise in enumerate(exercises):
                    if (
                        not isinstance(exercise, dict)
                        or set(exercise) != {"prompt", "answer", "explanation"}
                        or exercise["prompt"] in examples
                    ):
                        raise SkillImportError("Invalid or copied example exercise.")
                    exercise["id"] = f"job-{job_id}-{index}"
                skill = context["skill"]
                sequence = db.execute(
                    "select coalesce(max(sequence),0)+1 from exercise_batches where skill_id=?",
                    (skill["id"],),
                ).fetchone()[0]
                batch = {
                    "job_id": job_id,
                    "revision": skill["bank"]["revision"],
                    "sequence": sequence,
                    "exercises": exercises,
                }
                db.execute(
                    "insert into exercise_batches values (?,?,?)",
                    (skill["id"], sequence, encode(batch)),
                )
                validate_snapshot(self.store._snapshot(db))
            except (SkillImportError, TypeError, KeyError) as error:
                db.execute("rollback to publish_batch")
                db.execute("release publish_batch")
                db.execute(
                    "update generation_jobs set state='failed',error=? where id=?",
                    (
                        str(error)
                        if isinstance(error, SkillImportError)
                        else "Invalid generated exercise batch.",
                        job_id,
                    ),
                )
                return
            db.execute("release publish_batch")
            db.execute(
                "update generation_jobs set state='completed',error=null where id=?",
                (job_id,),
            )

    def run_once(self, provider):
        with self.store.connect() as db:
            ready = db.execute(
                "select id from generation_jobs where state='result_ready' order by next_run,id limit 1"
            ).fetchone()
        if ready:
            self.publish(ready[0])
            return ready[0]
        claimed = self.claim(provider)
        if not claimed:
            return None
        job_id, token, context = claimed
        if not self.calling(job_id, token):
            return job_id
        try:
            self.save_result(job_id, token, provider.generate(copy.deepcopy(context)))
        except RetryableFailure:
            self.failure(job_id, token, "retry")
        except TerminalFailure:
            self.failure(job_id, token, "terminal")
        except JobConflict:
            pass  # A late worker cannot publish after losing its lease.
        except Exception:
            self.failure(job_id, token, "uncertain")
        else:
            self.publish(job_id)
        return job_id


class FixtureProvider:
    """Predetermined Spanish output; no network access or model call."""

    def estimate(self, context):
        return 0

    def generate(self, context):
        if (
            context["provider"] != "fixture-spanish-v1"
            or context["skill"]["id"] != "spanish-ar-preterite-yo"
            or context["count"] > 3
            or context["skill"]
            != decode(
                (
                    Path(__file__).resolve().parents[1] / "fixtures/spanish-import.json"
                ).read_bytes()
            )["skills"][0]
        ):
            raise TerminalFailure()
        texts = [
            (
                "Anoche yo ___ una canción. (cantar)",
                "canté",
                "For yo in the preterite, replace -ar with -é: cantar → canté.",
            ),
            (
                "Ayer yo ___ con Luis. (bailar)",
                "bailé",
                "For yo in the preterite, replace -ar with -é: bailar → bailé.",
            ),
            (
                "Esta mañana yo ___ un café. (tomar)",
                "tomé",
                "For yo in the preterite, replace -ar with -é: tomar → tomé.",
            ),
        ]
        return {
            "exercises": [
                dict(zip(("prompt", "answer", "explanation"), values))
                for values in texts[: context["count"]]
            ],
            "usage": {"input_tokens": 0, "output_tokens": 0, "gross_cost_microusd": 0},
        }


def main():
    from learnrecur.companion.server import Store

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    jobs = Jobs(Store(args.data_dir))
    try:
        while True:
            jobs.run_once(FixtureProvider())
            if args.once:
                break
            time.sleep(1)
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
