"""Round-trip ordinary packages through the pinned upstream Python library."""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from anki.collection import Collection
from tests.learnrecur_deck_fixture import (
    DECK,
    content,
    export,
    import_package,
    scheduling,
)
from tests.learnrecur_upstream import extract_upstream

ROOT = Path(__file__).resolve().parents[2]
HELPER = Path(__file__).with_name("learnrecur_deck_fixture.py")


@pytest.fixture(scope="module")
def upstream(tmp_path_factory) -> Path:
    source = tmp_path_factory.mktemp("learnrecur-upstream")
    extract_upstream(source)
    return source


def run_upstream(source: Path, action: str, collection: Path, package: Path) -> dict:
    result = subprocess.run(
        [sys.executable, str(HELPER), action, str(collection), str(package)],
        cwd=source,
        env={
            **os.environ,
            "PYTHONPATH": str(source),
            "ANKI_TEST_MODE": "1",
        },
        capture_output=True,
        text=True,
        check=True,
    )
    snapshot = json.loads(result.stdout)
    assert Path(snapshot["library"]).is_relative_to(source)
    assert Path(snapshot["backend"]).is_relative_to(source)
    return snapshot


@pytest.mark.parametrize("with_scheduling", [True, False])
@pytest.mark.parametrize("legacy", [False, True])
@pytest.mark.parametrize("fsrs", [False, True])
def test_ordinary_deck_round_trip(
    upstream, tmp_path, with_scheduling, legacy, fsrs
) -> None:
    incoming = tmp_path / "synthetic.apkg"
    baseline = run_upstream(
        upstream, "seed", tmp_path / "upstream-source/collection.anki2", incoming
    )
    col = Collection(str(tmp_path / "learnrecur.anki2"))
    try:
        import_package(col, incoming)
        assert content(col) == baseline["content"]
        assert col.note_count() == 4
        assert len(col.find_cards("")) == 5

        col.set_config("fsrs", fsrs)
        basic = col.get_note(col.find_notes('"note:Compatibility Basic"')[0])
        basic["Back"] = "Five (edited in LearnRecur)"
        col.update_note(basic)
        added = col.new_note(basic.note_type())
        added["Front"] = "What is 3 + 3?"
        added["Back"] = "6"
        added.tags = ["synthetic", "created-in-learnrecur"]
        col.add_note(added, col.decks.id(DECK))
        html = col.models.by_name("Compatibility HTML")
        html["css"] += " .example { padding: 8px; }"
        col.models.update_dict(html)

        col.decks.select(col.decks.id(DECK))
        card = col.sched.getCard()
        assert card is not None
        before = scheduling(col)
        col.sched.answerCard(card, 1)
        assert col.get_card(card.id).reps == 1
        col.undo()
        assert scheduling(col) == before
        # Leave one card learning, one graduated, and the others new.
        card = col.sched.getCard()
        col.sched.answerCard(card, 3)
        next_card = col.sched.getCard()
        assert next_card is not None and next_card.id != card.id
        col.sched.answerCard(next_card, 4)
        assert {col.get_card(cid).type for cid in col.find_cards("")} == {0, 1, 2}

        expected_content = content(col)
        expected_schedule = scheduling(col)
        assert (
            any(
                state["memory_state"] is not None
                for state in expected_schedule.values()
            )
            == fsrs
        )
        col.close()
        col = Collection(str(tmp_path / "learnrecur.anki2"))
        assert content(col) == expected_content
        assert scheduling(col) == expected_schedule
        outgoing = tmp_path / "learnrecur.apkg"
        export(col, outgoing, scheduling=with_scheduling, legacy=legacy)
    finally:
        col.close()

    restored = run_upstream(
        upstream, "inspect", tmp_path / "upstream-restored/collection.anki2", outgoing
    )
    assert restored["content"] == expected_content
    if with_scheduling:
        assert restored["scheduling"] == expected_schedule
    else:
        for state in restored["scheduling"].values():
            assert state["type"] == state["queue"] == state["reps"] == 0
            assert state["reviews"] == []
