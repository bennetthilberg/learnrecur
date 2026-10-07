# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Validate companion snapshots and create linked cards through native APIs."""

from __future__ import annotations

import hashlib
import html
import json
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING
from unicodedata import normalize
from uuid import UUID

from anki.learnrecur_limits import MAX_BYTES, MAX_EXERCISES, MAX_SKILLS

if TYPE_CHECKING:
    from anki.collection import Collection, OpChanges

LINK_FIELD = "LearnRecurLink"
MODEL_NAME = "LearnRecur Imported Skill"
DECK_NAME = "LearnRecur skills"
FIELDS = (
    "Title",
    "Description",
    "Prompt",
    "Answer",
    "Explanation",
    "LearnRecurSkill",
    LINK_FIELD,
)


class SkillImportError(ValueError):
    pass


def encode(value: object) -> str:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )


def decode(data: bytes) -> object:
    def unique_keys(pairs: list[tuple[str, object]]) -> dict:
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON key")
            result[key] = value
        return result

    if len(data) > MAX_BYTES:
        raise SkillImportError("The skill batch is too large.")
    try:
        return json.loads(data, object_pairs_hook=unique_keys)
    except (ValueError, UnicodeError, RecursionError) as error:
        raise SkillImportError("Invalid skill JSON.") from error


def _text(value: object, limit: int = 8192) -> str:
    try:
        valid = (
            isinstance(value, str)
            and bool(value.strip())
            and len(value.encode()) <= limit
        )
    except UnicodeError:
        valid = False
    if valid and any(
        ord(char) < 32 and char not in "\n\t" or ord(char) == 127 for char in value
    ):
        valid = False
    if not valid:
        raise SkillImportError("A skill contains missing or oversized text.")
    return value


def validate_skills(value: object) -> list[dict]:
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_SKILLS:
        raise SkillImportError(f"Import between 1 and {MAX_SKILLS} skills at a time.")
    ids = set()
    for skill in value:
        if not isinstance(skill, dict) or set(skill) != {
            "id",
            "title",
            "description",
            "bank",
        }:
            raise SkillImportError(
                "A skill needs an ID, title, description, and exercise bank."
            )
        skill_id = _text(skill["id"], 128)
        if not re.fullmatch(r"[a-zA-Z0-9_-]+", skill_id) or skill_id in ids:
            raise SkillImportError(
                "Skill IDs must be unique and use letters, numbers, hyphens, or underscores."
            )
        ids.add(skill_id)
        _text(skill["title"], 256)
        _text(skill["description"])
        bank = skill["bank"]
        if not isinstance(bank, dict) or set(bank) != {
            "version",
            "skill_id",
            "revision",
            "exercises",
        }:
            raise SkillImportError("Invalid exercise bank.")
        if (
            type(bank["version"]) is not int
            or bank["version"] != 1
            or bank["skill_id"] != skill_id
        ):
            raise SkillImportError(
                "The exercise bank must match its skill ID and format."
            )
        if type(bank["revision"]) is not int or bank["revision"] < 1:
            raise SkillImportError("Invalid skill revision.")
        exercises = bank["exercises"]
        if not isinstance(exercises, list) or not 1 <= len(exercises) <= MAX_EXERCISES:
            raise SkillImportError(
                f"A skill needs between 1 and {MAX_EXERCISES} cached exercises."
            )
        exercise_ids = set()
        for exercise in exercises:
            if not isinstance(exercise, dict) or set(exercise) != {
                "id",
                "prompt",
                "answer",
                "explanation",
            }:
                raise SkillImportError("Invalid cached exercise.")
            exercise_id = _text(exercise["id"], 128)
            if exercise_id in exercise_ids:
                raise SkillImportError("Duplicate exercise ID.")
            exercise_ids.add(exercise_id)
            for key in ("prompt", "answer", "explanation"):
                _text(exercise[key])
    if len(encode(value).encode()) > MAX_BYTES:
        raise SkillImportError("The skill batch is too large.")
    return value


def validate_snapshot(value: object) -> tuple[str, list[dict]]:
    if (
        not isinstance(value, dict)
        or not {"source_id", "skills"} <= set(value)
        or set(value)
        - {"source_id", "skills", "identities", "previous_revisions", "bank_updates"}
    ):
        raise SkillImportError("Invalid companion response.")
    try:
        source = value["source_id"]
        if not isinstance(source, str) or str(UUID(source)) != source:
            raise ValueError()
    except (ValueError, AttributeError) as error:
        raise SkillImportError("Invalid companion identity.") from error
    # An empty server is valid, unlike an empty import request.
    skills = validate_skills(value["skills"]) if value["skills"] != [] else []
    snapshot_identities(value, skills)
    history = snapshot_history(value, skills)
    from anki.learnrecur_batches import validate_batches

    if value.get("bank_updates") and "identities" not in value:
        raise SkillImportError("Exercise batches need companion identities.")
    validate_batches(value.get("bank_updates", {}), skills, history)
    if len(encode(value).encode()) > MAX_BYTES:
        raise SkillImportError("The skill batch is too large.")
    return source, skills


def snapshot_history(value: dict, skills: list[dict]) -> dict[str, list[dict]]:
    history = value.get("previous_revisions", {})
    current = {skill["id"]: skill for skill in skills}
    if (
        not isinstance(history, dict)
        or set(history) - set(current)
        or history
        and "identities" not in value
    ):
        raise SkillImportError("Invalid skill revision history.")
    for key, versions in history.items():
        if not isinstance(versions, list) or not 1 <= len(versions) < 100:
            raise SkillImportError("Invalid skill revision history.")
        for revision, skill in enumerate(versions, 1):
            validate_skills([skill])
            if skill["id"] != key or skill["bank"]["revision"] != revision:
                raise SkillImportError("Invalid skill revision history.")
        if current[key]["bank"]["revision"] != len(versions) + 1:
            raise SkillImportError("Invalid skill revision history.")
    if "identities" in value and any(
        skill["bank"]["revision"] > 100
        or len(history.get(skill["id"], [])) != skill["bank"]["revision"] - 1
        for skill in skills
    ):
        raise SkillImportError("Missing skill revision history.")
    return history


def snapshot_identities(value: dict, skills: list[dict]) -> dict:
    # Older snapshots remain readable for local fixtures. The companion always
    # supplies identities; legacy linked cards are never silently replaced.
    if "identities" not in value:
        return {}
    identities = value["identities"]
    if not isinstance(identities, dict) or set(identities) != {
        skill["id"] for skill in skills
    }:
        raise SkillImportError("Missing companion card identities.")
    ids, guids = set(), set()
    for identity in identities.values():
        if (
            not isinstance(identity, dict)
            or set(identity) != {"native_id", "guid"}
            or type(identity["native_id"]) is not int
            or not 1 <= identity["native_id"] <= 2**53 - 1
            or not isinstance(identity["guid"], str)
            or not re.fullmatch(r"[0-9a-f]{32}", identity["guid"])
            or identity["native_id"] in ids
            or identity["guid"] in guids
        ):
            raise SkillImportError("Invalid companion card identity.")
        ids.add(identity["native_id"])
        guids.add(identity["guid"])
    return identities


def _link(source: str, skill: dict, batches: list | None = None) -> str:
    return encode(
        {
            "source_id": source,
            "skill_id": skill["id"],
            "digest": hashlib.sha256(
                encode(
                    {"skill": skill, "batches": batches} if batches else skill
                ).encode()
            ).hexdigest(),
        }
    )


def _fields(
    source: str,
    skill: dict,
    previous: list[dict] | None = None,
    batches: list | None = None,
) -> list[str]:
    first = skill["bank"]["exercises"][0]
    bank = skill["bank"]
    if previous:
        bank = {
            **bank,
            "definition": {key: skill[key] for key in ("title", "description")},
            "retired_revisions": previous,
        }
    if batches:
        bank = {
            **bank,
            "base_skill": skill,
            "bank_updates": batches,
            "bank_sequence": len(batches),
            "exercises": [
                *bank["exercises"],
                *(
                    e
                    for batch in batches
                    if batch["revision"] == bank["revision"]
                    for e in batch["exercises"]
                ),
            ],
        }
    return [
        html.escape(normalize("NFC", skill["title"])),
        html.escape(normalize("NFC", skill["description"])),
        *(
            html.escape(normalize("NFC", first[key]))
            for key in ("prompt", "answer", "explanation")
        ),
        # Escapes protect bank text from native field normalization.
        json.dumps(bank, sort_keys=True, separators=(",", ":"), ensure_ascii=True),
        _link(source, skill, batches),
    ]


@dataclass
class SkillImportResult:
    changes: OpChanges
    added: int
    existing: int
    updated: int = 0


def _matches_newer_cache(note, source: str, incoming: dict) -> bool:
    """An old snapshot can confirm an ancestor, but cannot roll a card back."""
    try:
        bank = json.loads(note["LearnRecurSkill"])
        previous = bank.pop("retired_revisions")
        definition = bank.pop("definition")
        current = {"id": bank["skill_id"], **definition, "bank": bank}
        validate_skills([current])
        snapshot_history(
            {"previous_revisions": {current["id"]: previous}, "identities": {}},
            [current],
        )
        return (
            bank["revision"] > incoming["bank"]["revision"]
            and incoming in previous
            and [note[field] for field in FIELDS] == _fields(source, current, previous)
        )
    except (ValueError, KeyError, TypeError, RecursionError):
        return False


def _cache_update_fields(
    source, key, note, skill, previous, incoming_batches, identities
):
    versions = [*previous, skill]
    actual = [note[field] for field in FIELDS]
    cached_batches = []
    cached_revision = None
    try:
        raw = json.loads(note["LearnRecurSkill"])
    except (ValueError, TypeError, RecursionError) as error:
        raise SkillImportError("Invalid cached exercise bank.") from error
    if not isinstance(raw, dict):
        raise SkillImportError("Invalid cached exercise bank.")
    if "bank_updates" in raw:
        from anki.learnrecur_batches import validate_batches

        base = raw.get("base_skill")
        validate_skills([base])
        cached_previous = raw.get("retired_revisions", [])
        snapshot_history(
            {
                "identities": {},
                "previous_revisions": {key: cached_previous} if cached_previous else {},
            },
            [base],
        )
        cached_batches = raw["bank_updates"]
        validate_batches({key: cached_batches}, [base], {key: cached_previous})
        if actual != _fields(source, base, cached_previous, cached_batches):
            raise SkillImportError(
                "A cached exercise batch changed. Restore it before importing."
            )
        if base in versions and cached_previous == versions[: versions.index(base)]:
            cached_revision = base["bank"]["revision"]
        elif (
            base["bank"]["revision"] > skill["bank"]["revision"]
            and skill in cached_previous
        ):
            if incoming_batches != cached_batches[: len(incoming_batches)]:
                raise SkillImportError("Conflicting exercise batch history.")
            return None
    else:
        matched = next(
            (
                index
                for index, version in enumerate(versions)
                if actual == _fields(source, version, versions[:index])
            ),
            None,
        )
        if matched is not None:
            cached_revision = versions[matched]["bank"]["revision"]
        elif identities and _matches_newer_cache(note, source, skill):
            return None
    if cached_revision is None:
        raise SkillImportError(
            "A linked skill changed. Restore its imported content before updating."
        )
    shared = min(len(cached_batches), len(incoming_batches))
    if cached_batches[:shared] != incoming_batches[:shared]:
        raise SkillImportError("Conflicting exercise batch history.")
    incoming_revision = skill["bank"]["revision"]
    if cached_revision == incoming_revision and len(cached_batches) >= len(
        incoming_batches
    ):
        return None
    if len(cached_batches) > len(incoming_batches):
        raise SkillImportError("Missing exercise batch history.")
    if not identities:
        raise SkillImportError("Update the companion before revising skills.")
    return _fields(source, skill, previous, incoming_batches)


def import_snapshot(
    col: Collection, snapshot: object, *, cache_only: bool = False
) -> SkillImportResult:
    from anki.collection import AddNoteRequest, OpChanges
    from anki.learnrecur_skills import MODEL_KIND, MODEL_MARKER

    source, skills = validate_snapshot(snapshot)
    identities = snapshot_identities(snapshot, skills)
    history = snapshot_history(snapshot, skills)
    bank_updates = snapshot.get("bank_updates", {})
    pending = {skill["id"]: skill for skill in skills}
    seen = set()
    updates = []
    # Links survive note-type renames and copies. A removed marker is a conflict,
    # not permission to silently create another card.
    for model in col.models.all():
        if LINK_FIELD not in [field["name"] for field in model["flds"]]:
            continue
        for nid in col.models.nids(model["id"]):
            note = col.get_note(nid)
            if LINK_FIELD not in note or not note[LINK_FIELD]:
                continue
            try:
                link = json.loads(note[LINK_FIELD])
                if not isinstance(link, dict):
                    raise ValueError()
                key = link["skill_id"]
                if link["source_id"] != source or key not in pending:
                    continue
            except (ValueError, KeyError, TypeError, RecursionError) as error:
                raise SkillImportError(
                    "A linked skill has invalid import data."
                ) from error
            if key in seen:
                raise SkillImportError(
                    "Duplicate linked skill cards. Resolve them before importing."
                )
            seen.add(key)
            if (
                model.get(MODEL_MARKER) != MODEL_KIND
                or model["type"] != 0
                or len(model["tmpls"]) != 1
                or len(note.cards()) != 1
                or any(field not in note for field in FIELDS)
            ):
                raise SkillImportError(
                    "A linked skill changed. Restore its imported content before updating."
                )
            if identities:
                identity = identities[key]
                if (
                    note.id != identity["native_id"]
                    or note.guid != identity["guid"]
                    or note.cards()[0].id != identity["native_id"]
                ):
                    raise SkillImportError(
                        "This skill has an older or conflicting card identity. Use a fresh test profile; the existing card was kept."
                    )
                if not col.db.scalar(
                    "select exists(select 1 from learnrecur_skill_identities "
                    "where nid=? and cid=? and guid=?)",
                    note.id,
                    identity["native_id"],
                    identity["guid"],
                ):
                    if cache_only:
                        continue
                    raise SkillImportError(
                        "This card has no trusted import identity. Use a fresh test profile; the existing card was kept."
                    )
            if cache_only:
                # New descriptions still need a preview and explicit import.
                cached = decode(note["LearnRecurSkill"].encode())
                if cached.get("revision") != pending[key]["bank"]["revision"]:
                    continue
            target_fields = _cache_update_fields(
                source,
                key,
                note,
                pending[key],
                history.get(key, []),
                bank_updates.get(key, []),
                identities,
            )
            if target_fields is None:
                continue
            from anki.notes_pb2 import UpdateSkillNoteRequest

            expected = note._to_backend_note()
            for field, content in zip(FIELDS, target_fields):
                note[field] = content
            updates.append(
                UpdateSkillNoteRequest(
                    note=note._to_backend_note(),
                    expected=expected,
                    card_id=note.cards()[0].id,
                )
            )
    missing = (
        [] if cache_only else [skill for skill in skills if skill["id"] not in seen]
    )
    if cache_only:
        changes = (
            col.add_skill_notes([], [], updates=updates, cache_only=True)
            if updates
            else OpChanges()
        )
        return SkillImportResult(changes, 0, len(seen) - len(updates), len(updates))
    if not missing and not updates:
        return SkillImportResult(OpChanges(), 0, len(seen))
    if identities:
        for skill in missing:
            native_id = identities[skill["id"]]["native_id"]
            if col.db.scalar(
                "select exists(select 1 from notes where id=?) or "
                "exists(select 1 from cards where id=?) or "
                "exists(select 1 from graves where oid=? and type in (0,1))",
                native_id,
                native_id,
                native_id,
            ):
                raise SkillImportError(
                    "A companion card ID is already used or deleted. No cards were replaced."
                )
    model = col.models.by_name(MODEL_NAME)
    if (
        missing
        and model
        and (
            model.get(MODEL_MARKER) != MODEL_KIND
            or model["type"] != 0
            or len(model["tmpls"]) != 1
            or [field["name"] for field in model["flds"]] != list(FIELDS)
        )
    ):
        raise SkillImportError(
            "The imported skill note type has changed. Restore it before importing."
        )
    did = col.decks.id_for_name(DECK_NAME)
    if missing and did:
        deck = col.decks.get(did)
        if deck["dyn"] or any(
            col.get_card(cid).note_type().get(MODEL_MARKER) != MODEL_KIND
            for cid in col.find_cards(f'deck:"{DECK_NAME}"')
        ):
            raise SkillImportError(
                "The LearnRecur skills deck contains ordinary cards or is filtered. Rename it before importing."
            )
    # Setup can survive an interruption separately. The bulk native add is one
    # transaction; links and cards commit together, with no separate receipt.
    undo = col.add_custom_undo_entry("Import skills")
    if missing and model is None:
        model = col.models.new(MODEL_NAME)
        model[MODEL_MARKER] = MODEL_KIND
        for field in FIELDS:
            col.models.add_field(model, col.models.new_field(field))
        template = col.models.new_template("Skill")
        template["qfmt"] = "{{Prompt}}"
        template["afmt"] = (
            '{{FrontSide}}<hr id="answer">{{Answer}}<br><br>{{Explanation}}'
        )
        col.models.add_template(model, template)
        model["css"] = ".card { font: 24px Arial; text-align: center; }"
        model = col.models.get(col.models.add_dict(model).id)
    did = col.decks.id(DECK_NAME) if missing else None
    requests = []
    for skill in missing:
        note = col.new_note(model)
        note.fields = _fields(
            source, skill, history.get(skill["id"]), bank_updates.get(skill["id"])
        )
        if identities:
            identity = identities[skill["id"]]
            note.id = identity["native_id"]
            note.guid = identity["guid"]
        requests.append(AddNoteRequest(note=note, deck_id=did))
    if identities:
        if updates:
            col.add_skill_notes(
                requests,
                [identities[skill["id"]]["native_id"] for skill in missing],
                updates=updates,
            )
        else:
            col.add_skill_notes(
                requests, [identities[skill["id"]]["native_id"] for skill in missing]
            )
    else:
        col.add_notes(requests)
    changes = col.merge_undo_entries(undo)
    return SkillImportResult(
        changes, len(missing), len(seen) - len(updates), len(updates)
    )
