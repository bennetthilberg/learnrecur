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

if TYPE_CHECKING:
    from anki.collection import Collection, OpChanges

MAX_BYTES = 1024 * 1024
MAX_SKILLS = 100
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
        raise SkillImportError("Import between 1 and 100 skills at a time.")
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
        if not isinstance(exercises, list) or not 1 <= len(exercises) <= 100:
            raise SkillImportError("A skill needs between 1 and 100 cached exercises.")
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
    if not isinstance(value, dict) or set(value) != {"source_id", "skills"}:
        raise SkillImportError("Invalid companion response.")
    try:
        source = value["source_id"]
        if not isinstance(source, str) or str(UUID(source)) != source:
            raise ValueError()
    except (ValueError, AttributeError) as error:
        raise SkillImportError("Invalid companion identity.") from error
    # An empty server is valid, unlike an empty import request.
    skills = validate_skills(value["skills"]) if value["skills"] != [] else []
    return source, skills


def _link(source: str, skill: dict) -> str:
    return encode(
        {
            "source_id": source,
            "skill_id": skill["id"],
            "digest": hashlib.sha256(encode(skill).encode()).hexdigest(),
        }
    )


def _fields(source: str, skill: dict) -> list[str]:
    first = skill["bank"]["exercises"][0]
    return [
        html.escape(normalize("NFC", skill["title"])),
        html.escape(normalize("NFC", skill["description"])),
        *(
            html.escape(normalize("NFC", first[key]))
            for key in ("prompt", "answer", "explanation")
        ),
        # Escapes protect bank text from native field normalization.
        json.dumps(
            skill["bank"], sort_keys=True, separators=(",", ":"), ensure_ascii=True
        ),
        _link(source, skill),
    ]


@dataclass
class SkillImportResult:
    changes: OpChanges
    added: int
    existing: int


def import_snapshot(col: Collection, snapshot: object) -> SkillImportResult:
    from anki.collection import AddNoteRequest, OpChanges
    from anki.learnrecur_skills import MODEL_KIND, MODEL_MARKER

    source, skills = validate_snapshot(snapshot)
    pending = {skill["id"]: skill for skill in skills}
    seen = set()
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
            expected = _fields(source, pending[key])
            if (
                model.get(MODEL_MARKER) != MODEL_KIND
                or model["type"] != 0
                or len(model["tmpls"]) != 1
                or len(note.cards()) != 1
                or any(field not in note for field in FIELDS)
                or [note[field] for field in FIELDS] != expected
            ):
                raise SkillImportError(
                    "A linked skill changed. Importing revisions is not supported yet."
                )
    missing = [skill for skill in skills if skill["id"] not in seen]
    if not missing:
        return SkillImportResult(OpChanges(), 0, len(seen))
    model = col.models.by_name(MODEL_NAME)
    if model and (
        model.get(MODEL_MARKER) != MODEL_KIND
        or model["type"] != 0
        or len(model["tmpls"]) != 1
        or [field["name"] for field in model["flds"]] != list(FIELDS)
    ):
        raise SkillImportError(
            "The imported skill note type has changed. Restore it before importing."
        )
    did = col.decks.id_for_name(DECK_NAME)
    if did:
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
    if model is None:
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
    did = col.decks.id(DECK_NAME)
    requests = []
    for skill in missing:
        note = col.new_note(model)
        note.fields = _fields(source, skill)
        requests.append(AddNoteRequest(note=note, deck_id=did))
    col.add_notes(requests)
    changes = col.merge_undo_entries(undo)
    return SkillImportResult(changes, len(missing), len(seen))
