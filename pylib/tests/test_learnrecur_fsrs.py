"""Enable FSRS for new collections without changing existing preferences."""

import pytest

from anki.collection import Collection
from anki.decks import DeckId


def test_new_collection_enables_fsrs_and_preserves_opt_out(tmp_path):
    path = str(tmp_path / "collection.anki2")
    col = Collection(path)
    assert col.get_config("fsrs") is True
    assert col.decks.get_deck_configs_for_update(DeckId(1)).fsrs
    col.close()

    col = Collection(path)
    assert col.get_config("fsrs") is True
    col.set_config("fsrs", False)
    col.close()

    col = Collection(path)
    assert col.get_config("fsrs") is False
    assert not col.decks.get_deck_configs_for_update(DeckId(1)).fsrs
    col.close()


def test_new_collection_good_uses_fsrs_and_native_learning_steps(tmp_path):
    col = Collection(str(tmp_path / "collection.anki2"))
    note = col.new_note(col.models.by_name("Basic"))
    note.fields = ["What is 2 + 3?", "5"]
    col.add_note(note, DeckId(1))
    card = col.sched.getCard()
    before = col.get_card(card.id)._to_backend_card().SerializeToString()
    col.sched.answerCard(card, 3)
    after = col.get_card(card.id)._to_backend_card().SerializeToString()
    assert col.get_card(card.id).memory_state is not None
    assert col.db.scalar("select ivl from revlog where cid = ?", card.id) == -600
    col.undo()
    assert col.get_card(card.id)._to_backend_card().SerializeToString() == before
    assert col.db.scalar("select count(*) from revlog") == 0
    col.redo()
    col.close()
    col.reopen()
    assert col.get_card(card.id)._to_backend_card().SerializeToString() == after
    assert col.db.scalar("select count(*) from revlog") == 1
    col.close()


@pytest.mark.parametrize("downgrade", [False, True])
def test_existing_collection_without_fsrs_keeps_legacy_scheduler(tmp_path, downgrade):
    path = str(tmp_path / "collection.anki2")
    col = Collection(path)
    col.remove_config("fsrs")
    col.close(downgrade=downgrade)

    col = Collection(path)
    assert col.get_config("fsrs") is None
    assert not col.decks.get_deck_configs_for_update(DeckId(1)).fsrs
    col.close()
