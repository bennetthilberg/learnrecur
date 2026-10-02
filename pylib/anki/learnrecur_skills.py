# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Review a local exercise bank without changing Anki's scheduler."""

from __future__ import annotations

import hashlib
import html
import json
import re
from dataclasses import dataclass

from anki.cards import Card, CardId
from anki.collection import Collection
from anki.scheduler.v3 import CardAnswer
from anki.template import TemplateRenderOutput

BANK_FIELD = "LearnRecurSkill"
MODEL_MARKER = "learnrecur"
MODEL_KIND = "skill-v1"
CURSOR_KEY = "lr"


class SkillReviewError(ValueError):
    pass


@dataclass(frozen=True)
class Exercise:
    id: str
    prompt: str
    answer: str
    explanation: str
    ordinal: int


@dataclass(frozen=True)
class SkillReview:
    card_id: CardId
    bank_hash: str
    position: int
    exercise: Exercise
    cursor_hash: str
    used: int


def _text(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SkillReviewError("This skill has an invalid exercise bank.")
    return value


def _bank(card: Card) -> tuple[str, str, list[Exercise]] | None:
    note = card.note()
    model = card.note_type()
    if model.get(MODEL_MARKER) != MODEL_KIND:
        return None
    if BANK_FIELD not in note:
        raise SkillReviewError("This skill is missing its exercise bank.")
    if model["type"] != 0 or len(model["tmpls"]) != 1:
        raise SkillReviewError("A skill needs one card template.")
    from anki.learnrecur_skill_links import assert_unique_link

    assert_unique_link(card)
    try:
        raw = json.loads(note[BANK_FIELD])
        if (
            not isinstance(raw, dict)
            or type(raw.get("version")) is not int
            or raw["version"] != 1
        ):
            raise ValueError()
        _text(raw["skill_id"])
        if type(raw["revision"]) is not int or raw["revision"] < 1:
            raise ValueError()
        if not isinstance(raw["exercises"], list) or len(raw["exercises"]) > 100:
            raise ValueError()
        exercises = []
        ids = set()
        for ordinal, item in enumerate(raw["exercises"]):
            exercise = Exercise(
                *(
                    _text(item[key])
                    for key in ("id", "prompt", "answer", "explanation")
                ),
                ordinal,
            )
            if exercise.id in ids:
                raise ValueError()
            ids.add(exercise.id)
            status = item.get("status", "active")
            if status not in ("active", "reported", "retired"):
                raise ValueError()
            if status == "active":
                exercises.append(exercise)
        digest = hashlib.sha256(json.dumps(raw, sort_keys=True).encode()).hexdigest()[
            :16
        ]
        from anki.learnrecur_batches import cursor_bank

        cursor_hash = hashlib.sha256(
            json.dumps(cursor_bank(raw), sort_keys=True).encode()
        ).hexdigest()[:16]
        return digest, cursor_hash, exercises
    except (KeyError, TypeError, ValueError, RecursionError) as error:
        raise SkillReviewError("This skill has an invalid exercise bank.") from error


def _custom_data(value: str) -> dict:
    try:
        data = json.loads(value or "{}")
        if not isinstance(data, dict):
            raise ValueError()
        return data
    except ValueError as error:
        raise SkillReviewError("This skill has invalid review data.") from error


def _position(card: Card, bank_hash: str) -> int:
    cursor = _custom_data(card.custom_data).get(CURSOR_KEY)
    if cursor is None:
        return 0
    if (
        not isinstance(cursor, dict)
        or not isinstance(cursor.get("b"), str)
        or type(cursor.get("n")) is not int
        or cursor["n"] < 0
    ):
        raise SkillReviewError("This skill has invalid review data.")
    return cursor["n"] if cursor["b"] == bank_hash else 0


def _used(card: Card, bank_hash: str, position: int) -> int:
    cursor = _custom_data(card.custom_data).get(CURSOR_KEY)
    if not cursor or cursor["b"] != bank_hash:
        return 0
    if "u" not in cursor:
        # Older clients only stored a counter. Treat the first n items as used.
        return (1 << min(position, 100)) - 1
    value = cursor["u"]
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{1,25}", value):
        raise SkillReviewError("This skill has invalid review data.")
    return int(value, 16)


def select_skill_review(card: Card) -> SkillReview | None:
    if (bank := _bank(card)) is None:
        return None
    bank_hash, cursor_hash, exercises = bank
    if not exercises:
        raise SkillReviewError("This skill has no available exercises.")
    position = _position(card, cursor_hash)
    used = _used(card, cursor_hash, position)
    exercise = next(
        (exercise for exercise in exercises if not used & (1 << exercise.ordinal)),
        exercises[position % len(exercises)],
    )
    return SkillReview(card.id, bank_hash, position, exercise, cursor_hash, used)


def skill_refill_request(card: Card) -> dict | None:
    """Describe a low bank using only its companion identity and native usage."""
    if (bank := _bank(card)) is None:
        return None
    from anki.learnrecur_skill_links import link_key

    if (key := link_key(card.note())) is None:
        return None
    if not card.col.db.scalar(
        "select exists(select 1 from learnrecur_skill_identities where nid=? and cid=? and guid=?)",
        card.nid,
        card.id,
        card.note().guid,
    ):
        return None  # A deck package cannot authorize background generation.
    _, cursor_hash, exercises = bank
    used = _used(card, cursor_hash, _position(card, cursor_hash))
    remaining = sum(not used & (1 << exercise.ordinal) for exercise in exercises)
    if remaining > 2:
        return None
    raw = json.loads(card.note()[BANK_FIELD])
    sequence = raw.get("bank_sequence", 0)
    if type(sequence) is not int or not 0 <= sequence <= 100:
        raise SkillReviewError("This skill has an invalid exercise bank.")
    return {
        "source_id": key[0],
        "skill_id": key[1],
        "revision": raw["revision"],
        "bank_sequence": sequence,
        "remaining": remaining,
    }


def validate_skill_review(card: Card, review: SkillReview) -> None:
    if select_skill_review(card) != review:
        raise SkillReviewError(
            "This skill changed. Review the current exercise before rating it."
        )


def render_skill_review(card: Card, review: SkillReview) -> None:
    """Pin both sides, including the answer preloaded by the native reviewer."""
    validate_skill_review(card, review)

    def plain_text(text: str) -> str:
        # Brackets must not become native typed-answer or media instructions.
        return html.escape(text).replace("[", "&#91;").replace("\n", "<br>")

    question = plain_text(review.exercise.prompt)
    answer = plain_text(review.exercise.answer)
    explanation = plain_text(review.exercise.explanation)
    card.set_render_output(
        TemplateRenderOutput(
            question_text=question,
            answer_text=f'{question}<hr id="answer">{answer}<br><br>{explanation}',
            question_av_tags=[],
            answer_av_tags=[],
            css=card.note_type()["css"],
        )
    )


def prepare_skill_answer(
    col: Collection, answer: CardAnswer, review: SkillReview
) -> None:
    """Advance the cursor inside the native rating transaction and undo entry."""
    card = col.get_card(answer.card_id)
    validate_skill_review(card, review)
    data = _custom_data(
        answer.new_state.custom_data
        if answer.new_state.HasField("custom_data")
        else card.custom_data
    )
    data[CURSOR_KEY] = {
        "b": review.cursor_hash,
        "n": review.position + 1,
        "u": format(review.used | (1 << review.exercise.ordinal), "x"),
    }
    encoded = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    # Native card custom data allows 100 bytes and keys of at most eight bytes.
    if len(encoded.encode()) > 100 or any(len(key.encode()) > 8 for key in data):
        raise SkillReviewError("This card has no room for skill review data.")
    answer.new_state.custom_data = encoded
