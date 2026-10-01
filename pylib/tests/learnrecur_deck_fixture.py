"""Create and inspect synthetic packages without opening desktop profiles."""

from __future__ import annotations

import argparse
import hashlib
import inspect
import json
from pathlib import Path
from typing import Any

from anki.collection import Collection
from anki.import_export_pb2 import (
    ExportAnkiPackageOptions,
    ImportAnkiPackageOptions,
    ImportAnkiPackageRequest,
)

DECK = "Ordinary compatibility"
IMAGE_NAME = "synthetic-dot.png"
IMAGE = (Path(__file__).parent / "support/learnrecur-dot.png").read_bytes()


def export(col: Collection, path: Path, *, scheduling: bool, legacy: bool) -> None:
    col.export_anki_package(
        out_path=str(path),
        options=ExportAnkiPackageOptions(
            with_scheduling=scheduling,
            with_deck_configs=True,
            with_media=True,
            legacy=legacy,
        ),
        limit=None,
    )


def import_package(col: Collection, path: Path) -> None:
    col.import_anki_package(
        ImportAnkiPackageRequest(
            package_path=str(path),
            options=ImportAnkiPackageOptions(
                with_scheduling=True, with_deck_configs=True
            ),
        )
    )


def seed(col: Collection) -> None:
    deck_id = col.decks.id(DECK)
    html = col.models.copy(col.models.by_name("Basic"))
    html["name"] = "Compatibility HTML"
    html["css"] = (
        ".card { font: 24px sans-serif; text-align: center; } .example { color: #397caa; }"
    )
    html["tmpls"][0]["qfmt"] = '<section class="example">{{Front}}</section>'
    html["tmpls"][0]["afmt"] = '{{FrontSide}}<hr id="answer"><strong>{{Back}}</strong>'
    col.models.update_dict(html)
    for name, fields in (
        ("Basic", ["What is 2 + 3?", "5"]),
        ("Basic (type in the answer)", ["Spanish for house", "casa"]),
        (
            "Cloze",
            ["Yo {{c1::hablé}} y ella {{c2::trabajó}} ayer.", "Regular -ar verbs."],
        ),
        (
            "Compatibility HTML",
            [f'<em>Blue</em><br><img src="{IMAGE_NAME}">', "Azul &amp; blue"],
        ),
    ):
        model = col.models.by_name(name)
        if name != "Compatibility HTML":
            model["name"] = f"Compatibility {name}"
            col.models.update_dict(model)
        note = col.new_note(model)
        note.fields = fields
        note.tags = ["synthetic", "compatibility"]
        col.add_note(note, deck_id)
    col.media.write_data(IMAGE_NAME, IMAGE)


def content(col: Collection) -> dict[str, Any]:
    notes = {}
    models = {}
    for nid in col.find_notes(""):
        note = col.get_note(nid)
        model = note.note_type()
        models[model["name"]] = {
            "fields": [field["name"] for field in model["flds"]],
            "css": model["css"],
            "templates": [
                {key: template[key] for key in ("name", "qfmt", "afmt")}
                for template in model["tmpls"]
            ],
        }
        notes[note.guid] = {
            "fields": note.fields,
            "tags": sorted(note.tags),
            "model": model["name"],
            "cards": [
                {
                    "ordinal": card.ord,
                    "deck": col.decks.name(card.did),
                    "question": card.question(),
                    "answer": card.answer(),
                }
                for card in sorted(note.cards(), key=lambda card: card.ord)
            ],
        }
    return {
        "notes": notes,
        "models": models,
        "media": hashlib.sha256(
            (Path(col.media.dir()) / IMAGE_NAME).read_bytes()
        ).hexdigest(),
    }


def scheduling(col: Collection) -> dict[str, Any]:
    cards = {}
    for cid in col.find_cards(""):
        card = col.get_card(cid)
        # Import may change database identities and sync metadata.
        state = {
            key: getattr(card, key)
            for key in (
                "type",
                "queue",
                "due",
                "ivl",
                "factor",
                "reps",
                "lapses",
                "left",
                "odue",
                "original_position",
                "custom_data",
                "desired_retention",
                "decay",
                "last_review_time",
            )
        }
        state["memory_state"] = (
            {
                "stability": card.memory_state.stability,
                "difficulty": card.memory_state.difficulty,
            }
            if card.memory_state
            else None
        )
        state["reviews"] = col.db.all(
            "select id, ease, ivl, lastIvl, factor, time, type from revlog where cid = ? order by id",
            cid,
        )
        cards[f"{card.note().guid}:{card.ord}"] = state
    return cards


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("seed", "inspect"))
    parser.add_argument("collection", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    if args.collection.exists():
        parser.error("Use a fresh synthetic collection path")
    args.collection.parent.mkdir(parents=True, exist_ok=True)
    col = Collection(str(args.collection))
    try:
        if args.action == "seed":
            seed(col)
            export(col, args.output, scheduling=True, legacy=False)
        else:
            import_package(col, args.output)
        print(
            json.dumps(
                {
                    "library": str(Path(inspect.getfile(Collection)).resolve()),
                    "backend": str(
                        Path(
                            __import__("anki._rsbridge", fromlist=["__file__"]).__file__
                        ).resolve()
                    ),
                    "content": content(col),
                    "scheduling": scheduling(col),
                }
            )
        )
    finally:
        col.close()


if __name__ == "__main__":
    main()
