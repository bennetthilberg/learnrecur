# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Detect conflicting skill links without changing learner state."""

from __future__ import annotations

import json
import re
from collections import defaultdict
from uuid import UUID

from anki.collection import Collection
from anki.learnrecur_skill_import import LINK_FIELD
from anki.learnrecur_skills import MODEL_KIND, MODEL_MARKER, SkillReviewError
from anki.notes import Note


class SkillLinkError(SkillReviewError):
    pass


def link_key(note: Note) -> tuple[str, str] | None:
    if LINK_FIELD not in note or not note[LINK_FIELD]:
        return None
    try:
        link = json.loads(note[LINK_FIELD])
        source, skill = link["source_id"], link["skill_id"]
        if (
            set(link) != {"source_id", "skill_id", "digest"}
            or not isinstance(source, str)
            or str(UUID(source)) != source
            or not isinstance(skill, str)
            or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", skill)
            or not isinstance(link["digest"], str)
            or not re.fullmatch(r"[0-9a-f]{64}", link["digest"])
        ):
            raise ValueError()
        return source, skill
    except (ValueError, KeyError, TypeError, AttributeError, RecursionError) as error:
        raise SkillLinkError("A skill has invalid link data.") from error


def linked_notes(
    col: Collection, *, current_key: tuple[str, str] | None = None
) -> dict[tuple[str, str], list[Note]]:
    groups = defaultdict(list)
    for model in col.models.all():
        if LINK_FIELD not in [field["name"] for field in model["flds"]]:
            continue
        for nid in col.models.nids(model["id"]):
            note = col.get_note(nid)
            try:
                key = link_key(note)
            except SkillLinkError:
                if current_key is None and model.get(MODEL_MARKER) == MODEL_KIND:
                    raise
                if current_key is not None:
                    # A damaged digest must not hide a duplicate of this skill.
                    try:
                        raw = json.loads(note[LINK_FIELD])
                        if (raw.get("source_id"), raw.get("skill_id")) == current_key:
                            groups[current_key].append(note)
                    except (ValueError, TypeError, AttributeError, RecursionError):
                        pass
                continue
            if key and (current_key is None or key == current_key):
                groups[key].append(note)
    return groups


def assert_unique_link(card) -> None:
    if key := link_key(card.note()):
        if len(linked_notes(card.col, current_key=key)[key]) != 1:
            raise SkillLinkError(
                "This skill has duplicate cards. Resolve them before reviewing."
            )


def validate_skill_links(col: Collection) -> None:
    if any(len(notes) > 1 for notes in linked_notes(col).values()):
        raise SkillLinkError(
            "This collection has duplicate skill cards. Resolve them before reviewing."
        )
