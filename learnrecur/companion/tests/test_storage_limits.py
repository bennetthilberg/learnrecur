"""Growth limits must survive restart without invalidating saved work."""

from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from pathlib import Path
from unittest.mock import Mock

import pytest

from anki.learnrecur_limits import StorageLimits
from anki.learnrecur_skill_import import SkillImportError, encode
from learnrecur.companion.jobs import FixtureProvider, JobConflict, Jobs
from learnrecur.companion.server import Store
from learnrecur.companion.tests.test_jobs import jobs, payload

__all__ = ["jobs", "payload"]


def limits(store):
    with store.connect() as db:
        return store.limits(db)


def counts(store):
    with store.connect() as db:
        return tuple(
            db.execute(f"select count(*) from {table}").fetchone()[0]
            for table in ("generation_jobs", "generation_attempts", "exercise_batches")
        )


def test_defaults_configuration_and_worker_restart(jobs):
    assert limits(jobs.store) == StorageLimits()
    updated = jobs.store.configure_limits(
        max_exercises=240,
        max_jobs=2000,
        max_snapshot_bytes=16 * 1024 * 1024,
        max_skills=750,
        max_batches=1500,
    )
    restarted = Store(jobs.store.path.parent)
    assert limits(restarted) == updated
    # Partial updates retain every other setting.
    assert restarted.configure_limits(max_jobs=3000) == updated.updated(
        {"max_jobs": 3000}
    )
    assert limits(jobs.store).max_jobs == 3000


@pytest.mark.parametrize(
    "changes",
    [
        {"max_jobs": True},
        {"max_jobs": 0},
        {"max_jobs": -1},
        {"max_jobs": "1000"},
        {"max_exercises": 257},
        {"max_snapshot_bytes": 64 * 1024 * 1024 + 1},
        {"max_skills": 5001},
        {"max_jobs": 10001},
        {"max_batches": 5001},
        {"unknown": 50},
    ],
)
def test_bad_configuration_preserves_the_store(jobs, changes):
    before = jobs.store.snapshot()
    jobs.store.configure_limits(max_jobs=50)
    with pytest.raises(ValueError):
        jobs.store.configure_limits(**changes)
    assert limits(jobs.store).max_jobs == 50
    assert jobs.store.snapshot() == before
    assert counts(jobs.store) == (0, 0, 0)


def test_environment_settings_are_persisted_and_empty_values_keep_them(
    jobs, monkeypatch
):
    monkeypatch.setenv("LEARNRECUR_MAX_JOBS", "2500")
    monkeypatch.setenv("LEARNRECUR_MAX_EXERCISES", "240")
    jobs.store.configure_environment_limits()
    assert limits(Store(jobs.store.path.parent)).max_jobs == 2500
    monkeypatch.setenv("LEARNRECUR_MAX_JOBS", "")
    jobs.store.configure_environment_limits()
    assert limits(jobs.store).max_jobs == 2500
    monkeypatch.setenv("LEARNRECUR_MAX_JOBS", "junk")
    with pytest.raises(ValueError, match="integer"):
        jobs.store.configure_environment_limits()
    assert limits(jobs.store).max_jobs == 2500
    jobs.store.configure_environment_limits(max_jobs=3000)
    assert limits(jobs.store).max_jobs == 3000
    monkeypatch.setenv("LEARNRECUR_MAX_EXERCISES", "junk")
    with pytest.raises(ValueError):
        jobs.store.configure_environment_limits(max_jobs=3500)
    assert limits(jobs.store).max_jobs == 3000


@pytest.mark.parametrize("value", ["3", "junk"])
def test_container_worker_applies_limits_before_starting_jobs(
    jobs, payload, monkeypatch, value
):
    from learnrecur.deploy import container

    job = jobs.enqueue(payload)
    monkeypatch.setenv("LEARNRECUR_MAX_EXERCISES", value)
    monkeypatch.delenv("LEARNRECUR_GENERATION_PROVIDER", raising=False)
    monkeypatch.setattr(container.sys, "argv", ["container", "worker"])
    monkeypatch.setattr(
        container,
        "Path",
        lambda path: (
            jobs.store.path.parent if path == "/state/companion" else Path(path)
        ),
    )
    transfer = Mock(side_effect=StopIteration)
    monkeypatch.setattr(container.os, "execv", transfer)
    previous_umask = container.os.umask(0o077)
    try:
        if value == "junk":
            with pytest.raises(ValueError, match="integer"):
                container.main()
            transfer.assert_not_called()
            assert jobs.get(job["id"])["state"] == "queued"
        else:
            with pytest.raises(StopIteration):
                container.main()
            assert limits(jobs.store).max_exercises == 3
            provider = FixtureProvider()
            provider.generate = Mock(wraps=provider.generate)
            assert jobs.run_once(provider) is None
            assert jobs.get(job["id"])["state"] == "waiting_capacity"
            provider.generate.assert_not_called()
        assert counts(jobs.store) == (1, 0, 0)
    finally:
        container.os.umask(previous_umask)


def test_lowered_limits_allow_restart_read_and_idempotent_import(jobs):
    before = jobs.store.snapshot()
    jobs.store.configure_limits(max_exercises=1, max_snapshot_bytes=1)
    restarted = Store(jobs.store.path.parent)
    assert restarted.snapshot() == before
    assert restarted.import_batch({"skills": before["skills"]}) == before
    skill = {
        **before["skills"][0],
        "bank": {**before["skills"][0]["bank"], "revision": 2},
    }
    with pytest.raises(SkillImportError, match="storage limits"):
        restarted.import_batch({"skills": [skill]})
    assert restarted.snapshot() == before


def test_job_quota_is_atomic_and_retries_keep_the_original_identity(jobs, payload):
    jobs.store.configure_limits(max_jobs=1)

    def enqueue(index):
        try:
            return jobs.enqueue({**payload, "request_id": f"request-{index}"})
        except JobConflict:
            return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(enqueue, range(2)))
    original = next(result for result in results if result)
    assert sum(result is not None for result in results) == 1
    jobs.run_once(FixtureProvider())
    assert jobs.enqueue(original["request"])["id"] == original["id"]
    assert counts(jobs.store) == (1, 1, 1)
    # Completed jobs retain their deduplication and spend records.
    with pytest.raises(JobConflict, match="job limit"):
        jobs.enqueue(payload)
    jobs.store.configure_limits(max_jobs=2)
    assert jobs.enqueue(payload)["id"] != original["id"]


@pytest.mark.parametrize(
    "changes",
    [
        {"max_exercises": 3},
        {"max_snapshot_bytes": 10000},
        {"max_batches": 1},
    ],
)
def test_storage_exhaustion_stops_before_new_jobs_or_paid_attempts(
    jobs, payload, changes
):
    if "max_batches" in changes:
        job = jobs.enqueue(payload)
        jobs.run_once(FixtureProvider())
        assert jobs.get(job["id"])["state"] == "completed"
    before = counts(jobs.store)
    jobs.store.configure_limits(**changes)
    with pytest.raises(JobConflict, match="full|no room"):
        jobs.enqueue({**payload, "request_id": "paid-blocked", "provider": "openai"})
    assert counts(jobs.store) == before


def test_queued_job_waits_without_a_charge_and_resumes_after_capacity_increase(
    jobs, payload
):
    job = jobs.enqueue(payload)
    jobs.store.configure_limits(max_exercises=3)
    provider = FixtureProvider()
    provider.generate = Mock(wraps=provider.generate)
    assert jobs.run_once(provider) is None
    assert jobs.get(job["id"])["state"] == "waiting_capacity"
    assert counts(jobs.store) == (1, 0, 0)
    provider.generate.assert_not_called()
    jobs.store.configure_limits(max_exercises=6)
    restarted = Jobs(Store(jobs.store.path.parent), clock=jobs.clock)
    assert restarted.run_once(provider) == job["id"]
    assert restarted.get(job["id"])["state"] == "completed"
    assert counts(jobs.store) == (1, 1, 1)
    provider.generate.assert_called_once()


def test_saved_result_waits_and_publishes_after_restart_without_regeneration(
    jobs, payload
):
    job = jobs.enqueue(payload)
    provider = FixtureProvider()
    claimed, token, context = jobs.claim(provider)
    assert claimed == job["id"]
    assert jobs.calling(claimed, token)
    jobs.save_result(claimed, token, provider.generate(context))
    jobs.store.configure_limits(max_snapshot_bytes=1)
    jobs.publish(claimed)
    assert jobs.get(claimed)["state"] == "waiting_capacity"
    before = counts(jobs.store)
    restarted = Jobs(Store(jobs.store.path.parent), clock=jobs.clock)
    restarted.store.configure_limits(max_snapshot_bytes=8 * 1024 * 1024)
    provider.generate = Mock(side_effect=AssertionError("must reuse the saved result"))
    restarted.run_once(provider)
    assert restarted.get(claimed)["state"] == "completed"
    assert counts(jobs.store) == (before[0], before[1], 1)
    assert restarted.enqueue(payload)["id"] == claimed
    provider.generate.assert_not_called()


@pytest.mark.parametrize(
    "changes",
    [{"max_exercises": 6}, {"max_snapshot_bytes": 1}, {"max_batches": 1}],
)
def test_lowering_capacity_after_claim_releases_cost_before_provider_call(
    jobs, payload, changes
):
    jobs.enqueue(payload)
    provider = FixtureProvider()
    jobs.run_once(provider)
    job = jobs.enqueue({**payload, "request_id": "claimed-before-change"})
    claimed, token, _ = jobs.claim(provider)
    assert claimed == job["id"]
    jobs.store.configure_limits(**changes)
    assert not jobs.calling(claimed, token)
    assert jobs.get(claimed)["state"] == "waiting_capacity"
    with jobs.store.connect() as db:
        assert db.execute(
            "select state,gross_actual,credit_actual,net_actual "
            "from generation_attempts where job_id=?",
            (claimed,),
        ).fetchone() == ("abandoned", 0, 0, 0)
    provider.generate = Mock(wraps=provider.generate)
    assert jobs.run_once(provider) is None
    provider.generate.assert_not_called()
    jobs.store.configure_limits(
        **{name: getattr(StorageLimits(), name) for name in changes}
    )
    assert jobs.run_once(provider) == claimed
    assert jobs.get(claimed)["state"] == "completed"
    provider.generate.assert_called_once()


def test_saved_limits_are_part_of_the_backup_database(jobs, tmp_path):
    configured = jobs.store.configure_limits(
        max_jobs=2300, max_snapshot_bytes=16 * 1024 * 1024
    )
    before = jobs.store.snapshot()
    restored = Store(tmp_path / "restored")
    with jobs.store.connect() as source, restored.connect() as destination:
        source.backup(destination)
    restored = Store(restored.path.parent)
    assert restored.snapshot() == before
    assert asdict(limits(restored)) == asdict(configured)
    assert len(encode(before).encode()) < configured.max_snapshot_bytes


def test_concurrent_claims_cannot_spend_the_same_bank_capacity_twice(jobs, payload):
    jobs.store.configure_limits(max_exercises=6)
    first = jobs.enqueue(payload)
    second = jobs.enqueue({**payload, "request_id": "second-job"})
    provider = FixtureProvider()
    with ThreadPoolExecutor(max_workers=2) as pool:
        claimed = list(pool.map(lambda _: jobs.claim(provider), range(2)))
    assert sum(value is not None for value in claimed) == 1
    assert counts(jobs.store) == (2, 1, 0)
    assert {jobs.get(job["id"])["state"] for job in (first, second)} == {
        "running",
        "waiting_capacity",
    }


def test_claimed_batch_reserves_snapshot_space_against_new_imports(jobs, payload):
    jobs.store.configure_limits(max_snapshot_bytes=150000)
    claimed = jobs.claim(FixtureProvider())
    assert claimed is None
    jobs.enqueue(payload)
    assert jobs.claim(FixtureProvider()) is not None
    before = jobs.store.snapshot()
    extra = {
        **before["skills"][0],
        "id": "new-skill",
        "bank": {**before["skills"][0]["bank"], "skill_id": "new-skill"},
    }
    extra["bank"]["exercises"] = [
        {
            "id": "large",
            "prompt": "x" * 8192,
            "answer": "x" * 8192,
            "explanation": "x" * 8192,
        }
    ]
    with pytest.raises(SkillImportError, match="storage limits"):
        jobs.store.import_batch({"skills": [extra]})
    assert jobs.store.snapshot() == before
