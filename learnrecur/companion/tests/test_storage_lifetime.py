"""Free synthetic refills exercise bank growth, revisions, and native restore."""

import json
import time

from anki.collection import Collection
from anki.learnrecur_reports import pending_reports
from anki.learnrecur_restore import reconnect_skills
from anki.learnrecur_skill_import import DECK_NAME, encode, import_snapshot
from anki.learnrecur_skills import (
    prepare_skill_answer,
    report_skill_review,
    select_skill_review,
)
from anki.scheduler.v3 import CardAnswer
from learnrecur.companion.jobs import FixtureProvider, JobConflict, Jobs
from learnrecur.companion.server import Store


class SyntheticProvider(FixtureProvider):
    """Procedural arithmetic data for storage checks; never contacts a provider."""

    def generate(self, context):
        start = len(context["existing_prompts"])
        key = context["skill"]["id"]
        revision = context["skill"]["bank"]["revision"]
        return {
            "exercises": [
                {
                    "prompt": f"Storage fixture {key}/{revision}/{index}: what is {index} + 1?",
                    "answer": str(index + 1),
                    "explanation": "Add one. " + "Synthetic storage fixture. " * 25,
                }
                for index in range(start, start + context["count"])
            ],
            "usage": {"input_tokens": 0, "output_tokens": 0, "gross_cost_microusd": 0},
        }


def definition(store, index, revision):
    return {
        "request_id": f"{index * 100 + revision:032x}",
        "source_id": store.snapshot()["source_id"],
        "title": f"Synthetic addition {index}",
        "description": f"Add one to an integer. Synthetic revision {revision}.",
        "examples": [
            {"prompt": "What is 2 + 1?", "answer": "3", "explanation": "Add one."}
        ],
    }


def rows(col):
    return (
        col.db.all("select * from cards order by id"),
        col.db.all("select * from revlog order by id"),
    )


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


def test_growth_revisions_reports_native_undo_export_and_backend_restore(tmp_path):
    store = Store(tmp_path / "companion")
    jobs = Jobs(store)
    provider = SyntheticProvider()
    col = Collection(str(tmp_path / "collection.anki2"))
    keys = []
    started = time.monotonic()
    try:
        for revision in range(1, 4):
            for index in range(1, 4):
                value = definition(store, index, revision)
                if revision == 1:
                    job = jobs.create_skill(value, "fixture")
                    keys.append(job["request"]["skill_id"])
                else:
                    job = jobs.edit_skill(
                        {
                            **value,
                            "skill_id": keys[index - 1],
                            "base_revision": revision - 1,
                        },
                        "fixture",
                    )
                jobs.run_once(provider)
                assert jobs.get(job["id"])["state"] == "completed"
                while True:
                    with store.connect() as db:
                        sequence = db.execute(
                            "select coalesce(max(sequence),0) from exercise_batches where skill_id=?",
                            (keys[index - 1],),
                        ).fetchone()[0]
                    checkpoint = {
                        "source_id": value["source_id"],
                        "skill_id": keys[index - 1],
                        "revision": revision,
                        "bank_sequence": sequence,
                        "remaining": 0,
                    }
                    try:
                        result = jobs.request_refill(checkpoint, "fixture")
                    except JobConflict as error:
                        assert "bank is full" in str(error)
                        break
                    frozen = jobs.get(result["job_id"])
                    assert frozen["context"]["examples"] == value["examples"]
                    assert (
                        jobs.request_refill(checkpoint, "fixture")["job_id"]
                        == result["job_id"]
                    )
                    jobs.run_once(provider)
                    assert jobs.get(result["job_id"])["state"] == "completed"
                # Worker restart keeps the configured limits and checkpoint IDs.
                jobs = Jobs(Store(store.path.parent))

            before = rows(col)
            imported = import_snapshot(col, store.snapshot())
            assert (imported.added, imported.updated) == (
                (3, 0) if revision == 1 else (0, 3)
            )
            if revision > 1:
                assert rows(col) == before
            for _ in range(310 if revision == 1 else 6):
                cid = rate(col)
            # Rating remains one native undo entry even above bit 100.
            before = rows(col)
            cid = rate(col)
            after = rows(col)
            if revision == 1:
                assert (
                    max(
                        select_skill_review(col.get_card(card_id)).used.bit_length()
                        for card_id in col.find_cards("")
                    )
                    > 100
                )
            col.undo()
            assert rows(col) == before
            col.redo()
            assert rows(col) == after
            review = select_skill_review(col.get_card(cid))
            report_skill_review(col, review, "incorrect")
            assert rows(col) == after
            assert (
                select_skill_review(col.get_card(cid)).exercise.id != review.exercise.id
            )
            col.undo()
            assert select_skill_review(col.get_card(cid)) == review
            col.redo()

        final = store.snapshot()
        with store.connect() as db:
            count = db.execute("select count(*) from generation_jobs").fetchone()[0]
            max_sequence = db.execute(
                "select max(sequence) from exercise_batches"
            ).fetchone()[0]
            gross = db.execute(
                "select sum(gross_actual) from generation_attempts"
            ).fetchone()[0]
        snapshot_bytes = len(encode(final).encode())
        assert count == 603 and max_sequence == 198 and gross == 0
        assert 1024 * 1024 < snapshot_bytes < 8 * 1024 * 1024
        assert col.card_count() == 3 and len(rows(col)[1]) == 325
        expected_rows = rows(col)
        expected_reports = pending_reports(col, final["source_id"])
        bank_fields = col.db.all("select flds from notes order by id")
        package = tmp_path / "synthetic.colpkg"
        col.export_collection_package(str(package), include_media=True, legacy=False)
        restored_path = tmp_path / "restored.anki2"
        col._backend.import_collection_package(
            col_path=str(restored_path),
            backup_path=str(package),
            media_folder=str(tmp_path / "restored.media"),
            media_db=str(tmp_path / "restored.media.db2"),
        )
        col.reopen()
        restored = Collection(str(restored_path))
        try:
            assert rows(restored) == expected_rows
            assert restored.db.all("select flds from notes order by id") == bank_fields
            assert pending_reports(restored, final["source_id"]) == []
            reconnect_skills(restored, final)
            assert pending_reports(restored, final["source_id"]) == expected_reports
            assert rows(restored) == expected_rows
            assert import_snapshot(restored, final).existing == 3
        finally:
            restored.close()
        target = Store(tmp_path / "restored-companion")
        with store.connect() as source, target.connect() as destination:
            source.backup(destination)
        assert Store(target.path.parent).snapshot() == final
        stats = {
            "jobs": count,
            "exercises": 1800,
            "max_sequence": max_sequence,
            "snapshot_bytes": snapshot_bytes,
            "companion_bytes": store.path.stat().st_size,
            "collection_bytes": (tmp_path / "collection.anki2").stat().st_size,
            "package_bytes": package.stat().st_size,
            "elapsed_seconds": round(time.monotonic() - started, 3),
        }
        (tmp_path / "metrics.json").write_text(json.dumps(stats, indent=2))
        print(json.dumps(stats))
    finally:
        col.close()
