# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Retire a source before transferring complete paid-generation history."""

import json
import os
import re
import sqlite3
import time
from contextlib import closing
from pathlib import Path
from uuid import uuid4

RETIRED = ".generation-source-retired"
RECEIPT = ".generation-recovery.json"
PAID_PAUSE = ".paid-restore-pending"


class RecoveryRefused(ValueError):
    """A refusal whose message tells the operator what to do next."""


def require_active(folder):
    path = Path(folder) / RETIRED
    if path.exists() or path.is_symlink():
        raise ValueError(
            "This backend source is retired; use its recovered replacement."
        )


def retirement_id(root):
    from learnrecur.deploy.backup import safe_path, validate_root

    root = validate_root(root)
    values = [
        safe_path(root / name / RETIRED).read_text().strip()
        for name in ("sync", "companion")
    ]
    if len(set(values)) != 1 or not re.fullmatch(r"[a-f0-9]{32}", values[0]):
        raise ValueError("Both source stores must have the same retirement ID.")
    return values[0]


def retire_source(root):
    from learnrecur.deploy.backup import safe_path, validate_root

    root = validate_root(root)
    paths = [safe_path(root / name / RETIRED) for name in ("sync", "companion")]
    existing = {path.read_text().strip() for path in paths if path.exists()}
    if len(existing) > 1 or any(
        not re.fullmatch(r"[a-f0-9]{32}", value) for value in existing
    ):
        raise ValueError("Conflicting source retirement records.")
    value = next(iter(existing), uuid4().hex)
    for path in paths:
        if not path.exists():
            fd = os.open(
                path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
            )
            with os.fdopen(fd, "w") as stream:
                stream.write(value + "\n")
                stream.flush()
                os.fsync(stream.fileno())
        fd = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    from learnrecur.companion.jobs import Jobs
    from learnrecur.companion.server import Store

    # Reserved attempts have not reached the provider, even if their worker died.
    Jobs(Store(root / "companion")).abandon_retired_claims()
    return retirement_id(root)


def recovery_receipt(root, handoff_id, database_hash):
    if retirement_id(root) != handoff_id:
        raise ValueError("The handoff does not match its retired source.")
    path = root / "companion/skills.sqlite3"
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        source_id = db.execute(
            "select value from metadata where key='source_id'"
        ).fetchone()[0]
    receipt = {
        "format": 1,
        "handoff_id": handoff_id,
        "source_id": source_id,
        "database_sha256": database_hash,
    }
    (root / RECEIPT).write_text(json.dumps(receipt, sort_keys=True))
    (root / RECEIPT).chmod(0o600)
    for name in ("sync", "companion"):
        (root / name / RETIRED).unlink()


def allow_paid_worker(root, handoff_id, confirm_sole_active_host):
    from learnrecur.deploy.backup import digest, safe_path, validate_root

    root = validate_root(root)
    for name in ("sync", "companion"):
        require_active(root / name)
    if confirm_sole_active_host is not True:
        raise ValueError("Confirm this will be the only active replacement host.")
    receipt = json.loads(safe_path(root / RECEIPT).read_text())
    if (
        not isinstance(receipt, dict)
        or set(receipt) != {"format", "handoff_id", "source_id", "database_sha256"}
        or receipt["format"] != 1
        or not isinstance(handoff_id, str)
        or not re.fullmatch(r"[a-f0-9]{32}", handoff_id)
        or receipt["handoff_id"] != handoff_id
    ):
        raise ValueError("Use the ID from the final source handoff.")
    database = root / "companion/skills.sqlite3"
    if any(
        Path(str(database) + suffix).exists()
        and Path(str(database) + suffix).stat().st_size
        for suffix in ("-wal", "-journal")
    ):
        raise ValueError(
            "Generation history has uncheckpointed changes; keep recovery paused."
        )
    if digest(database) != receipt["database_sha256"]:
        raise ValueError("Generation history changed; recover a fresh final snapshot.")
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
        if (
            db.execute("select value from metadata where key='source_id'").fetchone()[0]
            != receipt["source_id"]
        ):
            raise ValueError("The recovered companion has a different source identity.")
        if (
            db.execute(
                "select 1 from generation_attempts where gross_actual is null or credit_actual is null or net_actual is null limit 1"
            ).fetchone()
            or db.execute(
                "select 1 from generation_jobs where state in ('running','provider_pending','needs_attention') limit 1"
            ).fetchone()
        ):
            raise ValueError("Unsettled generation keeps paid recovery paused.")
    if digest(database) != receipt["database_sha256"]:
        raise ValueError("Generation history changed during inspection.")
    # An interrupted release stays paused until both markers have been removed.
    for name in (".restore-pending", ".paid-restore-pending"):
        (root / "companion" / name).unlink(missing_ok=True)
    fd = os.open(root / "companion", os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def pause_marker(created_at):
    """Text for a restored copy's paid pause, with a fresh restore ID."""
    lines = [
        "Paid calls after this backup may be missing. Keep paid generation paused."
    ]
    if isinstance(created_at, str) and re.fullmatch(r"[0-9T:.+-]{10,40}", created_at):
        lines.append("backup_created_at=" + created_at)
    lines.append("restore_id=" + uuid4().hex)
    return "\n".join(lines) + "\n"


def pause_details(root):
    """Read the restore ID and backup time without changing anything."""
    from learnrecur.deploy.backup import safe_path

    path = safe_path(Path(root) / "companion" / PAID_PAUSE)
    text = path.read_text() if path.exists() else ""
    values = dict(
        re.findall(r"^(restore_id|backup_created_at)=(\S+)$", text, re.MULTILINE)
    )
    created = values.get("backup_created_at")
    restore_id = values.get("restore_id")
    return (
        restore_id
        if restore_id and re.fullmatch(r"[a-f0-9]{32}", restore_id)
        else None,
        created if created and re.fullmatch(r"[0-9T:.+-]{10,40}", created) else None,
        text,
    )


def paid_pause(root):
    """Return this restore's ID and backup time from its paid pause marker.

    Older restores wrote no ID. Add one before recording anything, so a retry
    after an interruption finds the same ID. A later restore of a newer backup
    gets a new marker and a new ID.
    """
    restore_id, created, text = pause_details(root)
    if not restore_id:
        restore_id = uuid4().hex
        path = Path(root) / "companion" / PAID_PAUSE
        temporary = path.with_name(PAID_PAUSE + ".new")
        temporary.unlink(missing_ok=True)
        fd = os.open(
            temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
        )
        with os.fdopen(fd, "w") as stream:
            stream.write(text.rstrip("\n") + f"\nrestore_id={restore_id}\n")
            stream.flush()
            os.fsync(stream.fileno())
        # The marker stays in place throughout, so paid generation stays paused.
        os.replace(temporary, path)
    return restore_id, created


def check_loss_release(usage_microusd, confirm_original_host_lost, unretrievable=()):
    # The tool can't see the lost host or the provider, so the operator vouches.
    if len(unretrievable) > 100 or any(
        not isinstance(job_id, str) or not re.fullmatch(r"[a-f0-9]{32}", job_id)
        for job_id in unretrievable
    ):
        raise RecoveryRefused(
            "Pass each job ID from inspect-generation to --settle-unretrievable-job."
        )
    if confirm_original_host_lost is not True:
        raise RecoveryRefused(
            "Confirm that the original host is gone for good with "
            "--confirm-original-host-lost. If it still runs, use a final handoff."
        )
    if type(usage_microusd) is not int or not 0 <= usage_microusd <= 5000000:
        raise RecoveryRefused(
            "Supply --post-backup-usage-microusd: the OpenAI usage since the "
            "backup, from 0 to 5000000."
        )


def release_paid_after_loss(
    root,
    usage_microusd,
    confirm_original_host_lost,
    *,
    unretrievable=(),
    clock=time.time,
):
    """Resume paid generation on an ordinary restore whose source is gone."""
    from learnrecur.companion.jobs import JobConflict, Jobs
    from learnrecur.companion.server import Store
    from learnrecur.deploy.backup import validate_root

    root = validate_root(root)
    for name in ("sync", "companion"):
        try:
            require_active(root / name)
        except ValueError as error:
            raise RecoveryRefused(str(error)) from None
    check_loss_release(usage_microusd, confirm_original_host_lost, unretrievable)
    if (root / RECEIPT).exists():
        raise RecoveryRefused(
            "This copy came from a final handoff. Use allow-paid-worker instead."
        )
    companion = root / "companion"
    if not (companion / PAID_PAUSE).exists():
        raise RecoveryRefused("Paid generation isn't paused here. Nothing changed.")
    restore_id, created = paid_pause(root)
    try:
        result = Jobs(Store(companion), clock=clock).settle_after_host_loss(
            restore_id, usage_microusd, created, unretrievable
        )
    except JobConflict as error:
        raise RecoveryRefused(str(error)) from None
    # The paid marker goes last, so an interrupted release stays paused.
    for name in (".restore-pending", PAID_PAUSE):
        (companion / name).unlink(missing_ok=True)
    fd = os.open(companion, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return {"restore_id": restore_id, "backup_created_at": created, **result}
