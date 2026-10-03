# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Retire a source before transferring complete paid-generation history."""

import json
import os
import re
import sqlite3
from contextlib import closing
from pathlib import Path
from uuid import uuid4

RETIRED = ".generation-source-retired"
RECEIPT = ".generation-recovery.json"


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
