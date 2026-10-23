"""Fill-in-the-blank answers: the v5 schema, publication, reports, and refills."""

import json

import pytest

from anki.collection import Collection
from anki.learnrecur_reports import pending_reports
from anki.learnrecur_skill_import import import_snapshot
from anki.learnrecur_skills import report_skill_review, select_skill_review
from learnrecur.companion.jobs import FixtureProvider, Jobs
from learnrecur.companion.openai_provider import (
    GUIDANCE,
    GUIDANCE_VERSION,
    OpenAIProvider,
    request_body,
)
from learnrecur.companion.reports import Reports
from learnrecur.companion.server import Store
from learnrecur.companion.tests.test_creation import definition
from learnrecur.companion.tests.test_jobs import jobs, payload
from learnrecur.companion.tests.test_openai_provider import (
    SYNTHETIC_KEY,
    Transport,
    openai_job,
)
from learnrecur.companion.tests.test_refills import checkpoint

__all__ = ["jobs", "payload"]


class Answering(Transport):
    """Return these exercises as the model's structured output."""

    def __init__(self, exercises):
        super().__init__()
        self.exercises = exercises

    def __call__(self, method, path, body=None, trace=None):
        result = super().__call__(method, path, body, trace)
        result["output"][0]["content"][0]["text"] = json.dumps(
            {"exercises": self.exercises}
        )
        return result


class BlankFixture(FixtureProvider):
    def generate(self, context):
        result = super().generate(context)
        for exercise in result["exercises"]:
            exercise["blanks"] = [exercise["answer"]]
        return result


def exercise(prompt, answer, blanks):
    return {
        "instruction": "Complete with the preterite.",
        "prompt": prompt,
        "context": "",
        "answer": answer,
        "explanation": "For yo, replace -ar with -é.",
        "blanks": blanks,
    }


@pytest.mark.parametrize("version", [1, 2, 3, 4, 5])
def test_each_saved_version_keeps_its_own_schema(jobs, payload, version):
    context = {**openai_job(jobs, payload)["context"], "instructions_version": version}
    schema = request_body(context)["text"]["format"]["schema"]
    item = schema["properties"]["exercises"]["items"]
    fields = {
        1: {"prompt", "answer", "explanation"},
        4: {"instruction", "prompt", "context", "answer", "explanation"},
        5: {"instruction", "prompt", "context", "answer", "explanation", "blanks"},
    }[max(v for v in (1, 4, 5) if v <= version)]
    assert set(item["properties"]) == set(item["required"]) == fields
    assert item["additionalProperties"] is False
    if version >= 5:
        assert item["properties"]["blanks"] == {
            "type": "array",
            "items": {"type": "string"},
            "maxItems": 16,
        }


def test_new_jobs_save_version_5_guidance(jobs, payload):
    job = openai_job(jobs, payload)
    assert job["context"]["instructions_version"] == GUIDANCE_VERSION == 5
    assert job["context"]["instructions"].startswith(GUIDANCE)
    assert "In blanks, list the exact text that fills each blank" in GUIDANCE


def test_publication_keeps_matching_blanks_and_drops_the_rest(jobs, payload):
    output = [
        exercise("Ayer yo ______ con Luis. (bailar)", "bailé", ["bailé"]),
        # A mismatch publishes without blanks rather than failing a paid batch.
        exercise("Yo ______ y ______. (cantar, tomar)", "canté, tomé", ["canté"]),
        exercise("¿Qué forma usas con yo? (caminar)", "caminé", []),
    ]
    job = openai_job(jobs, payload)
    jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=Answering(output)))
    assert jobs.get(job["id"])["state"] == "completed"
    published = jobs.store.snapshot()["bank_updates"][payload["skill_id"]][0]
    first, second, third = published["exercises"]
    assert first["blanks"] == ["bailé"]
    assert "blanks" not in second and second["answer"] == "canté, tomé"
    assert "blanks" not in third


@pytest.mark.parametrize(
    "blanks", ["bailé", None, {"0": "bailé"}, [1], ["a\nb"], ["é" * 257], [""]]
)
def test_malformed_blanks_publish_without_them(jobs, payload, blanks):
    output = [
        exercise("Ayer yo ______ con Luis. (bailar)", "bailé", blanks),
        exercise("Anoche yo ______ una canción. (cantar)", "canté", ["canté"]),
        exercise("Hoy yo ______ un café. (tomar)", "tomé", ["tomé"]),
    ]
    job = openai_job(jobs, payload)
    jobs.run_once(OpenAIProvider(SYNTHETIC_KEY, transport=Answering(output)))
    assert jobs.get(job["id"])["state"] == "completed"
    published = jobs.store.snapshot()["bank_updates"][payload["skill_id"]][0]
    assert "blanks" not in published["exercises"][0]
    assert published["exercises"][1]["blanks"] == ["canté"]


def test_reports_and_refills_carry_blanks(tmp_path):
    jobs = Jobs(Store(tmp_path / "companion"))
    jobs.create_skill(definition(jobs), "fixture")
    jobs.run_once(BlankFixture())
    snapshot = jobs.store.snapshot()
    skill = snapshot["skills"][0]
    assert all(e["blanks"] == [e["answer"]] for e in skill["bank"]["exercises"])
    # With no saved examples, a refill uses a cached exercise, blanks included.
    refill = jobs.get(
        jobs.request_refill(checkpoint(jobs, skill_id=skill["id"]), "openai")["job_id"]
    )
    example = refill["context"]["examples"][0]
    assert example["blanks"] == [example["answer"]]
    assert json.loads(request_body(refill["context"])["input"])["examples"] == [example]
    col = Collection(str(tmp_path / "synthetic.anki2"))
    try:
        import_snapshot(col, snapshot)
        card = col.get_card(col.db.scalar("select id from cards"))
        review = select_skill_review(card)
        assert review.exercise.blanks == (review.exercise.answer,)
        report_skill_review(col, review, "unclear")
        sent = pending_reports(col, snapshot["source_id"])[0]
        assert sent["exercise"] == skill["bank"]["exercises"][0]
        assert Reports(jobs.store).receive(sent, "fixture")["active"]
    finally:
        col.close()
