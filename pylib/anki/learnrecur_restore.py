# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Reconnect restored cards only after checking their published content."""

from dataclasses import dataclass

from anki.collection import Collection, OpChanges
from anki.learnrecur_skill_import import (
    FIELDS,
    SkillImportError,
    _fields,
    decode,
    snapshot_history,
    snapshot_identities,
    validate_snapshot,
)
from anki.learnrecur_skill_links import link_key
from anki.learnrecur_skills import MODEL_KIND, MODEL_MARKER
from anki.notes_pb2 import ReconnectSkillNoteRequest


@dataclass
class ReconnectResult:
    changes: OpChanges
    connected: int
    existing: int


def reconnect_skills(col: Collection, snapshot: object) -> ReconnectResult:
    """The caller must fetch this snapshot from the authenticated companion."""
    source, skills = validate_snapshot(snapshot)
    identities = snapshot_identities(snapshot, skills)
    if skills and not identities:
        raise SkillImportError("Update the companion before reconnecting skills.")
    history = snapshot_history(snapshot, skills)
    requests = []
    existing = 0
    for skill in skills:
        key = skill["id"]
        nids = col.db.list(
            "select nid from learnrecur_skill_links where source_id=? and skill_id=? limit 2",
            source,
            key,
        )
        if not nids:
            continue  # Reconnect never imports missing cards.
        if len(nids) != 1:
            raise SkillImportError(
                "Duplicate skill cards. Resolve them before reconnecting."
            )
        note = col.get_note(nids[0])
        identity = identities[key]
        model = note.note_type()
        cards = note.cards()
        if (
            link_key(note) != (source, key)
            or model.get(MODEL_MARKER) != MODEL_KIND
            or model["type"] != 0
            or len(model["tmpls"]) != 1
            or len(model["flds"]) != len(FIELDS)
            or any(field not in note for field in FIELDS)
            or note.id != identity["native_id"]
            or note.guid != identity["guid"]
            or len(cards) != 1
            or cards[0].id != identity["native_id"]
        ):
            raise SkillImportError(
                "A restored skill's card identity changed. No cards were connected."
            )
        if col.db.scalar(
            "select exists(select 1 from learnrecur_skill_identities where nid=? and cid=? and guid=?)",
            note.id,
            cards[0].id,
            note.guid,
        ):
            existing += 1
            continue
        bank = decode(note["LearnRecurSkill"].encode())
        if not isinstance(bank, dict):
            raise SkillImportError("Invalid restored exercise bank.")
        versions = [*history.get(key, []), skill]
        revision = bank.get("revision")
        sequence = bank.get("bank_sequence", 0)
        batches = snapshot.get("bank_updates", {}).get(key, [])
        index = next(
            (
                i
                for i, version in enumerate(versions)
                if version["bank"]["revision"] == revision
            ),
            None,
        )
        if (
            type(revision) is not int
            or index is None
            or type(sequence) is not int
            or not 0 <= sequence <= len(batches)
            or any(batch["revision"] > revision for batch in batches[:sequence])
            or [note[field] for field in FIELDS]
            != _fields(source, versions[index], versions[:index], batches[:sequence])
        ):
            raise SkillImportError(
                "A restored skill does not match the companion's published history. No cards were connected."
            )
        requests.append(
            ReconnectSkillNoteRequest(
                expected=note._to_backend_note(), card_id=cards[0].id
            )
        )
    if requests:
        col._backend.reconnect_skill_notes(notes=requests)
    return ReconnectResult(OpChanges(), len(requests), existing)
