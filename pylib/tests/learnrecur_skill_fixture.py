"""Create a synthetic skill package in a fresh collection."""

from __future__ import annotations

import argparse
import html
import json
import os
from pathlib import Path

from anki.collection import Collection
from anki.import_export_pb2 import ExportAnkiPackageOptions
from anki.learnrecur_skills import BANK_FIELD

BANK = (
    Path(__file__).resolve().parents[2] / "learnrecur/fixtures/spanish-preterite.json"
)
DECK = "Spanish skill"
STORAGE = Path(__file__).resolve().parents[2] / "out/learnrecur"


def seed(col: Collection) -> None:
    bank = json.loads(BANK.read_text())
    model = col.models.new("LearnRecur Skill")
    for name in ("Title", "Description", "Prompt", "Answer", "Explanation", BANK_FIELD):
        col.models.add_field(model, col.models.new_field(name))
    template = col.models.new_template("Skill")
    template["qfmt"] = "{{Prompt}}"
    template["afmt"] = '{{FrontSide}}<hr id="answer">{{Answer}}<br><br>{{Explanation}}'
    col.models.add_template(model, template)
    model["css"] = ".card { font: 24px Arial; text-align: center; }"
    model = col.models.get(col.models.add_dict(model).id)
    note = col.new_note(model)
    note["Title"] = "Regular -ar verbs: yo in the preterite"
    note["Description"] = (
        "Form the first-person singular preterite of regular Spanish -ar verbs. "
        "Exclude spelling changes, irregular verbs, other persons, and other tenses."
    )
    for field in ("Prompt", "Answer", "Explanation"):
        note[field] = html.escape(bank["exercises"][0][field.lower()])
    note[BANK_FIELD] = json.dumps(bank, ensure_ascii=False)
    note.tags = ["synthetic"]
    col.add_note(note, col.decks.id(DECK))
    ordinary = col.new_note(col.models.by_name("Basic (type in the answer)"))
    ordinary["Front"] = "Spanish for house"
    ordinary["Back"] = "casa"
    ordinary.tags = ["synthetic"]
    col.add_note(ordinary, col.decks.id("Ordinary sample"))
    col.decks.select(col.decks.id(DECK))


def fresh_fixture_paths(collection: Path, package: Path) -> tuple[Path, Path]:
    paths = [Path(os.path.abspath(path)) for path in (collection, package)]
    for path in paths:
        if not path.is_relative_to(STORAGE) or any(
            parent.is_symlink() for parent in (path, *path.parents)
        ):
            raise ValueError("Use paths inside out/learnrecur without symlinks")
    collection, package = paths
    if (
        collection.suffix != ".anki2"
        or package.suffix != ".apkg"
        or collection.parent != package.parent
        or collection.parent.exists()
    ):
        raise ValueError("Use a fresh fixture folder for the collection and package")
    return collection, package


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("collection", type=Path)
    parser.add_argument("package", type=Path)
    args = parser.parse_args()
    try:
        args.collection, args.package = fresh_fixture_paths(
            args.collection, args.package
        )
    except ValueError as error:
        parser.error(str(error))
    args.collection.parent.mkdir(parents=True, exist_ok=True)
    args.package.parent.mkdir(parents=True, exist_ok=True)
    col = Collection(str(args.collection))
    try:
        seed(col)
        col.export_anki_package(
            out_path=str(args.package),
            options=ExportAnkiPackageOptions(with_media=True, with_scheduling=True),
            limit=None,
        )
    finally:
        col.close()


if __name__ == "__main__":
    main()
