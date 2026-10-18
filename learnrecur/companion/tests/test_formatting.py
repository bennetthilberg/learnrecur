"""Presentation survives frozen jobs, revisions, reports, and private import plans."""

import json
from uuid import uuid4

import pytest

from anki.collection import Collection
from anki.learnrecur_reports import pending_reports
from anki.learnrecur_skill_import import SkillImportError, import_snapshot
from anki.learnrecur_skills import report_skill_review, select_skill_review
from learnrecur.companion.jobs import FixtureProvider, JobConflict, Jobs
from learnrecur.companion.reports import Reports
from learnrecur.companion.server import Store
from learnrecur.companion.tests.test_agent_import import HELPER, plans, server
from learnrecur.companion.tests.test_creation import definition, jobs
from learnrecur.companion.tests.test_refills import checkpoint

__all__ = ["jobs", "plans", "server"]


class StructuredFixture(FixtureProvider):
    def generate(self, context):
        result = super().generate(context)
        for exercise in result["exercises"]:
            exercise["instruction"] = "Complete with the preterite."
            exercise["context"] = "Use the supplied verb."
        return result


def test_saved_result_and_preference_only_edits_survive_restart(jobs):
    preferences = "Put supporting information below the exercise."
    value = definition(jobs, formatting_preferences=preferences)
    created = jobs.create_skill(value, "fixture")
    provider = StructuredFixture()
    job_id, token, context = jobs.claim(provider)
    assert context["skill"]["formatting_preferences"] == preferences
    assert jobs.calling(job_id, token)
    jobs.save_result(job_id, token, provider.generate(context))
    restarted = Jobs(Store(jobs.store.path.parent))
    restarted.run_once(provider)
    assert restarted.create_skill(value, None)["id"] == created["id"]
    original = restarted.store.snapshot()
    skill_id = original["skills"][0]["id"]
    assert original["skills"][0]["formatting_preferences"] == preferences
    assert original["skills"][0]["bank"]["exercises"][0]["context"]
    assert restarted.definition(skill_id)["formatting_preferences"] == preferences
    changed = {
        **restarted.definition(skill_id),
        "request_id": uuid4().hex,
        "formatting_preferences": "Use concise instructions.",
    }
    restarted.edit_skill(changed, "fixture")
    assert restarted.store.snapshot() == original
    restarted.run_once(provider)
    revised = restarted.store.snapshot()
    assert revised["identities"] == original["identities"]
    assert revised["skills"][0]["bank"]["revision"] == 2
    assert revised["previous_revisions"][skill_id] == original["skills"]
    cleared = {**restarted.definition(skill_id), "request_id": uuid4().hex}
    cleared.pop("formatting_preferences")
    restarted.edit_skill(cleared, "fixture")
    restarted.run_once(provider)
    assert "formatting_preferences" not in restarted.definition(skill_id)
    assert restarted.store.snapshot()["skills"][0]["bank"]["revision"] == 3
    with restarted.store.connect() as db:
        assert db.execute("select count(*) from generation_attempts").fetchone()[0] == 3


@pytest.mark.parametrize("replacement", [None, "Different layout"])
def test_request_identity_cannot_drop_or_change_saved_preferences(jobs, replacement):
    value = definition(jobs, formatting_preferences="Supporting text below.")
    jobs.create_skill(value, "fixture")
    changed = dict(value)
    if replacement is None:
        changed.pop("formatting_preferences")
    else:
        changed["formatting_preferences"] = replacement
    with pytest.raises(JobConflict, match="different skill"):
        jobs.create_skill(changed, "fixture")


@pytest.mark.parametrize("invalid", [None, 1, "é" * 1025, "bad\x00text"])
def test_bad_preferences_do_not_create_jobs_or_reservations(jobs, invalid):
    with pytest.raises(SkillImportError):
        jobs.create_skill(definition(jobs, formatting_preferences=invalid), "fixture")
    with jobs.store.connect() as db:
        assert db.execute("select count(*) from generation_jobs").fetchone()[0] == 0
        assert db.execute("select count(*) from generation_attempts").fetchone()[0] == 0


@pytest.mark.parametrize("key", ["instruction", "context"])
@pytest.mark.parametrize("invalid", [None, 3, "é" * 4097, "bad\x00text"])
def test_bad_optional_provider_text_is_not_published(jobs, key, invalid):
    created = jobs.create_skill(definition(jobs), "fixture")
    provider = StructuredFixture()
    job_id, token, context = jobs.claim(provider)
    assert jobs.calling(job_id, token)
    result = provider.generate(context)
    result["exercises"][0][key] = invalid
    jobs.save_result(job_id, token, result)
    jobs.run_once(provider)
    assert jobs.get(created["id"])["state"] == "failed"
    assert jobs.store.snapshot()["skills"] == []


def test_structured_report_delivery_and_refill_keep_context(jobs, tmp_path):
    jobs.create_skill(
        definition(jobs, formatting_preferences="Concise context."), "fixture"
    )
    jobs.run_once(StructuredFixture())
    original = jobs.store.snapshot()
    col = Collection(str(tmp_path / "synthetic.anki2"))
    try:
        import_snapshot(col, original)
        card = col.get_card(col.db.scalar("select id from cards"))
        pinned = select_skill_review(card)
        before = col.db.all("select * from cards"), col.db.all("select * from revlog")
        report_skill_review(col, pinned, "unclear")
        sent = pending_reports(col, original["source_id"])[0]
        assert sent["exercise"] == original["skills"][0]["bank"]["exercises"][0]
        assert (
            select_skill_review(col.get_card(card.id)).exercise.id != pinned.exercise.id
        )
        receipt = Reports(jobs.store).receive(sent, "fixture")
        job = jobs.get(receipt["job_id"])
        assert job["context"]["skill"]["formatting_preferences"] == "Concise context."
        assert job["context"]["examples"][0]["context"] == "Use the supplied verb."
        assert job["context"]["examples"][0]["prompt"] != pinned.exercise.prompt
        assert (
            jobs.request_refill(checkpoint(jobs, skill_id=sent["skill_id"]), "fixture")[
                "job_id"
            ]
            == job["id"]
        )
        assert (
            col.db.all("select * from cards"),
            col.db.all("select * from revlog"),
        ) == before
        col.undo()
        withdrawal = pending_reports(col, original["source_id"])[0]
        assert not Reports(jobs.store).receive(withdrawal, "fixture")["active"]
        assert select_skill_review(col.get_card(card.id)) == pinned
        col.redo()
        assert Reports(jobs.store).receive(
            pending_reports(col, original["source_id"])[0], "fixture"
        )["active"]
    finally:
        col.close()


def test_private_import_plan_round_trips_preferences_and_example_parts(server, plans):
    example = {
        "instruction": "Complete with the preterite.",
        "prompt": "Ayer yo ______ con Ana. (hablar)",
        "context": "A completed action yesterday.",
        "answer": "hablé",
        "explanation": "The first-person ending is -é.",
    }
    value = definition(
        Jobs(server.store),
        formatting_preferences="Supporting text below.",
        examples=[example],
    )
    value = {
        k: value[k]
        for k in ("title", "description", "examples", "formatting_preferences")
    }
    plan_id, plan = HELPER.prepare(plans, HELPER.Companion(), {"skills": [value]})
    assert plans.load(plan_id) == plan
    preview = HELPER.summary(plan_id, plan, preview=True)
    assert (
        preview["skills"][0]["formatting_preferences"]
        == value["formatting_preferences"]
    )
    HELPER.refresh(plans, HELPER.Companion(), plan_id, plan, submit=True)
    job = Jobs(server.store).get(plans.load(plan_id)["skills"][0]["job_id"])
    assert job["context"]["examples"] == [example]
    assert (
        job["context"]["skill"]["formatting_preferences"]
        == value["formatting_preferences"]
    )


def test_storage_reservation_covers_all_five_text_fields():
    reserved = Store.reserved_exercises(3)
    assert set(reserved[0]) == {
        "id",
        "instruction",
        "prompt",
        "context",
        "answer",
        "explanation",
    }
    assert len(json.dumps(reserved)) > 3 * 5 * 8192
