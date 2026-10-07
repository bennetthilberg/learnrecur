# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Append exercise batches without changing a skill's description revision."""

from __future__ import annotations

from anki.learnrecur_limits import MAX_BATCHES, MAX_EXERCISES
from anki.learnrecur_skill_import import SkillImportError, _text, validate_skills


def validate_batches(value: object, skills: list[dict], history: dict) -> dict:
    if not isinstance(value, dict) or set(value) - {skill["id"] for skill in skills}:
        raise SkillImportError("Invalid exercise batches.")
    for skill in skills:
        batches = value.get(skill["id"], [])
        if not isinstance(batches, list) or len(batches) > MAX_BATCHES:
            raise SkillImportError("Too many exercise batches.")
        versions = {
            v["bank"]["revision"]: v for v in [*history.get(skill["id"], []), skill]
        }
        seen = {
            rev: {e["id"] for e in v["bank"]["exercises"]}
            for rev, v in versions.items()
        }
        prompts = {
            rev: {e["prompt"] for e in v["bank"]["exercises"]}
            for rev, v in versions.items()
        }
        jobs = set()
        last_revision = 1
        for sequence, batch in enumerate(batches, 1):
            if not isinstance(batch, dict) or set(batch) != {
                "job_id",
                "revision",
                "sequence",
                "exercises",
            }:
                raise SkillImportError("Invalid exercise batch.")
            rev = batch["revision"]
            if (
                type(rev) is not int
                or rev not in versions
                or rev < last_revision
                or type(batch["sequence"]) is not int
                or batch["sequence"] != sequence
            ):
                raise SkillImportError("Invalid exercise batch order.")
            last_revision = rev
            job = _text(batch["job_id"], 128)
            if job in jobs:
                raise SkillImportError("Duplicate generation job.")
            jobs.add(job)
            test_skill = {
                **versions[rev],
                "bank": {**versions[rev]["bank"], "exercises": batch["exercises"]},
            }
            validate_skills([test_skill])
            for exercise in batch["exercises"]:
                if exercise["id"] in seen[rev] or exercise["prompt"] in prompts[rev]:
                    raise SkillImportError("Duplicate generated exercise.")
                seen[rev].add(exercise["id"])
                prompts[rev].add(exercise["prompt"])
            if len(seen[rev]) > MAX_EXERCISES:
                raise SkillImportError(
                    f"A skill revision can cache at most {MAX_EXERCISES} exercises."
                )
    return value


def cursor_bank(bank: dict) -> dict:
    """Recover the original bank fingerprint used by existing review cursors."""
    if "bank_updates" not in bank:
        return bank
    result = dict(bank["base_skill"]["bank"])
    if bank.get("retired_revisions"):
        result["definition"] = {
            key: bank["base_skill"][key] for key in ("title", "description")
        }
        result["retired_revisions"] = bank["retired_revisions"]
    return result
