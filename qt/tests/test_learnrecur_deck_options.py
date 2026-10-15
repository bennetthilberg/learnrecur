"""Skill wording follows deck contents without changing collection state."""

import runpy
from pathlib import Path

import pytest

from anki.collection import Collection
from anki.learnrecur_skills import BANK_FIELD, MODEL_MARKER
from aqt.deckoptions import deck_options_path

ROOT = Path(__file__).resolve().parents[2]


@pytest.fixture
def col(tmp_path):
    collection = Collection(str(tmp_path / "collection.anki2"))
    runpy.run_path(str(ROOT / "pylib/tests/learnrecur_skill_fixture.py"))["seed"](
        collection
    )
    yield collection
    collection.close()


def rows(col):
    return [
        col.db.all(f"select * from {table}")
        for table in ("cards", "notes", "revlog", "decks", "deck_config")
    ]


def test_skill_and_ordinary_share_preset_but_keep_their_wording(col):
    skill = col.decks.id("Spanish skill")
    ordinary = col.decks.id("Ordinary sample")
    assert col.decks.get(skill)["conf"] == col.decks.get(ordinary)["conf"]
    before = rows(col)
    assert deck_options_path(col, skill).endswith("?skills=1")
    assert deck_options_path(col, ordinary) == f"deck-options/{ordinary}"
    assert rows(col) == before


def test_names_do_not_determine_wording(col):
    skill = col.decks.id("Spanish skill")
    ordinary = col.decks.id("Ordinary sample")
    col.decks.rename(skill, "Grammar")
    col.decks.rename(ordinary, "LearnRecur skills")
    model = col.get_card(col.find_cards(f"did:{skill}")[0]).note_type()
    model["name"] = "Renamed type"
    col.models.update_dict(model)
    assert deck_options_path(col, skill).endswith("?skills=1")
    assert deck_options_path(col, ordinary) == f"deck-options/{ordinary}"


def test_empty_and_mixed_decks_keep_cards(col):
    empty = col.decks.id("Empty skills")
    skill = col.decks.id("Spanish skill")
    assert deck_options_path(col, empty) == f"deck-options/{empty}"
    col.set_deck(col.find_cards('deck:"Ordinary sample"'), skill)
    assert deck_options_path(col, skill) == f"deck-options/{skill}"


def test_subdecks_are_included(col):
    parent = col.decks.id("Practice")
    skill = col.decks.id("Spanish skill")
    ordinary = col.decks.id("Ordinary sample")
    col.decks.rename(skill, "Practice::Grammar")
    assert deck_options_path(col, parent).endswith("?skills=1")
    col.decks.rename(ordinary, "Practice::Vocabulary")
    assert deck_options_path(col, parent) == f"deck-options/{parent}"
    assert deck_options_path(col, skill).endswith("?skills=1")


def test_filtered_cards_still_classify_their_home_deck(col):
    skill = col.decks.id("Spanish skill")
    filtered = col.decks.new_filtered("Filtered practice")
    deck = col.decks.get(filtered)
    deck["terms"] = [[f"did:{skill}", 100, 0]]
    col.decks.update(deck)
    col.sched.rebuild_filtered_deck(filtered)
    card = col.get_card(col.find_cards(f"did:{filtered}")[0])
    assert card.odid == skill
    assert deck_options_path(col, skill).endswith("?skills=1")


@pytest.mark.parametrize("change", ["marker", "field", "template"])
def test_incomplete_skill_types_keep_cards(col, change):
    skill = col.decks.id("Spanish skill")
    model = col.get_card(col.find_cards(f"did:{skill}")[0]).note_type()
    if change == "marker":
        del model[MODEL_MARKER]
    elif change == "field":
        next(field for field in model["flds"] if field["name"] == BANK_FIELD)[
            "name"
        ] = "Other"
    else:
        template = col.models.new_template("Extra")
        template["qfmt"] = "{{Description}}"
        template["afmt"] = "{{Answer}}"
        col.models.add_template(model, template)
    col.models.update_dict(model)
    assert deck_options_path(col, skill) == f"deck-options/{skill}"
