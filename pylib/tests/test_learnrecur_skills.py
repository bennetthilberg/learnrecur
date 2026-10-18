"""Exercise selection and use must follow native review history."""

import json

import pytest

from anki.collection import Collection
from anki.errors import InvalidInput
from anki.learnrecur_skills import (
    BANK_FIELD,
    MODEL_MARKER,
    SkillReviewError,
    prepare_skill_answer,
    render_skill_review,
    select_skill_review,
)
from anki.scheduler.v3 import CardAnswer
from tests import learnrecur_skill_fixture as fixture
from tests.learnrecur_skill_fixture import seed


@pytest.fixture
def col(tmp_path):
    collection = Collection(str(tmp_path / "collection.anki2"))
    seed(collection)
    yield collection
    collection.close()


def next_answer(col, rating):
    queued = col.sched.get_queued_cards().cards[0]
    card = col.get_card(queued.card.id)
    card.start_timer()
    queued.states.current.custom_data = card.custom_data
    answer = col.sched.build_answer(card=card, states=queued.states, rating=rating)
    return card, answer


def snapshot(col, card_id):
    return col.get_card(card_id)._to_backend_card().SerializeToString(), col.db.all(
        "select * from revlog where cid = ?", card_id
    )


@pytest.mark.parametrize("fsrs", [False, True])
@pytest.mark.parametrize(
    "rating", [CardAnswer.AGAIN, CardAnswer.HARD, CardAnswer.GOOD, CardAnswer.EASY]
)
def test_native_rating_undo_redo(col, rating, fsrs):
    col.set_config("fsrs", fsrs)
    card, answer = next_answer(col, rating)
    review = select_skill_review(card)
    before = snapshot(col, card.id)
    render_skill_review(card, review)
    assert "Ana" in card.question()
    assert "hablé" in card.answer()
    assert snapshot(col, card.id) == before
    prepare_skill_answer(col, answer, review)
    col.sched.answer_card(answer)
    after = snapshot(col, card.id)
    assert col.get_card(card.id).reps == 1
    assert col.db.scalar("select ease from revlog where cid = ?", card.id) == rating + 1
    assert select_skill_review(col.get_card(card.id)).exercise.answer == "trabajé"
    col.undo()
    assert snapshot(col, card.id) == before
    assert select_skill_review(col.get_card(card.id)) == review
    col.redo()
    assert snapshot(col, card.id) == after


def test_again_variation_and_restart(col):
    card, answer = next_answer(col, CardAnswer.AGAIN)
    review = select_skill_review(card)
    prepare_skill_answer(col, answer, review)
    col.sched.answer_card(answer)
    card, answer = next_answer(col, CardAnswer.AGAIN)
    assert select_skill_review(card).exercise.id == "trabajar"
    # Redraw and reveal do not consume an exercise.
    selected = select_skill_review(card)
    render_skill_review(card, selected)
    before = snapshot(col, card.id)
    card.load()
    render_skill_review(card, selected)
    assert "oficina" in card.question() and "trabajé" in card.answer()
    assert snapshot(col, card.id) == before
    col.close()
    col.reopen()
    assert select_skill_review(col.get_card(card.id)) == selected
    assert snapshot(col, card.id) == before


@pytest.mark.parametrize(
    "change", ["empty", "reported", "retired", "invalid", "duplicate", "revision"]
)
def test_bank_change_cannot_rate_stale_prompt(col, change):
    card, answer = next_answer(col, CardAnswer.GOOD)
    review = select_skill_review(card)
    note = card.note()
    bank = json.loads(note[BANK_FIELD])
    if change == "empty":
        bank["exercises"] = []
    elif change in ("reported", "retired"):
        for exercise in bank["exercises"]:
            exercise["status"] = change
    elif change == "duplicate":
        bank["exercises"].append(bank["exercises"][0])
    else:
        bank["revision"] = 2
    note[BANK_FIELD] = "broken" if change == "invalid" else json.dumps(bank)
    col.update_note(note)
    before = snapshot(col, card.id)
    with pytest.raises(SkillReviewError):
        prepare_skill_answer(col, answer, review)
    assert snapshot(col, card.id) == before


def test_excluded_exercises_and_cycle(col):
    card, answer = next_answer(col, CardAnswer.AGAIN)
    note = card.note()
    bank = json.loads(note[BANK_FIELD])
    bank["exercises"][0]["status"] = "reported"
    bank["exercises"][1]["status"] = "retired"
    note[BANK_FIELD] = json.dumps(bank)
    col.update_note(note)
    card.load()
    review = select_skill_review(card)
    assert review.exercise.id == "comprar"
    prepare_skill_answer(col, answer, review)
    col.sched.answer_card(answer)
    assert select_skill_review(col.get_card(card.id)).exercise.id == "comprar"


@pytest.mark.parametrize("custom", [{"other": 42}, {"other": "x" * 70}])
def test_preserve_other_custom_data_and_capacity(col, custom):
    card, _ = next_answer(col, CardAnswer.GOOD)
    card.custom_data = json.dumps(custom)
    col.update_card(card)
    card, answer = next_answer(col, CardAnswer.GOOD)
    review = select_skill_review(card)
    before = snapshot(col, card.id)
    if isinstance(custom["other"], str):
        with pytest.raises(SkillReviewError, match="no room"):
            prepare_skill_answer(col, answer, review)
        assert snapshot(col, card.id) == before
    else:
        prepare_skill_answer(col, answer, review)
        col.sched.answer_card(answer)
        assert json.loads(col.get_card(card.id).custom_data)["other"] == 42


def test_ordinary_typed_card_is_unchanged(col):
    card = col.get_card(col.find_cards('deck:"Ordinary sample"')[0])
    before = (card.question(), card.answer(), snapshot(col, card.id))
    assert select_skill_review(card) is None
    assert "[[type:Back]]" in card.question()
    assert (card.question(), card.answer(), snapshot(col, card.id)) == before


def test_plain_text_is_escaped(col):
    card, _ = next_answer(col, CardAnswer.GOOD)
    note = card.note()
    bank = json.loads(note[BANK_FIELD])
    bank["exercises"][0]["prompt"] = (
        'Complete the sentence.\n<script>alert("x")</script> ______ ________ '
        "[[type:Answer]]"
    )
    bank["exercises"][0]["answer"] = "<input>"
    note[BANK_FIELD] = json.dumps(bank)
    col.update_note(note)
    card.load()
    render_skill_review(card, select_skill_review(card))
    assert "<script>" not in card.question()
    assert "&lt;script&gt;" in card.question()
    assert "Complete the sentence.<br>" in card.question()
    assert "______ ________" in card.question()
    assert card.question() in card.answer()
    assert "[[type:" not in card.question()
    assert "<input>" not in card.answer()


def test_failed_native_answer_does_not_consume(col):
    card, answer = next_answer(col, CardAnswer.AGAIN)
    review = select_skill_review(card)
    before = snapshot(col, card.id)
    prepare_skill_answer(col, answer, review)
    answer.current_state.Clear()
    with pytest.raises(InvalidInput):
        col.sched.answer_card(answer)
    assert snapshot(col, card.id) == before
    assert select_skill_review(col.get_card(card.id)) == review


def test_old_selection_cannot_rate_twice(col):
    card, answer = next_answer(col, CardAnswer.AGAIN)
    review = select_skill_review(card)
    prepare_skill_answer(col, answer, review)
    col.sched.answer_card(answer)
    _, next_review_answer = next_answer(col, CardAnswer.AGAIN)
    before = snapshot(col, card.id)
    with pytest.raises(SkillReviewError, match="changed"):
        prepare_skill_answer(col, next_review_answer, review)
    assert snapshot(col, card.id) == before


def test_custom_scheduling_data_is_preserved(col):
    card, answer = next_answer(col, CardAnswer.GOOD)
    answer.new_state.custom_data = '{"other": 7}'
    prepare_skill_answer(col, answer, select_skill_review(card))
    col.sched.answer_card(answer)
    assert json.loads(col.get_card(card.id).custom_data)["other"] == 7


def test_fixture_rejects_existing_and_external_storage(tmp_path, monkeypatch):
    monkeypatch.setattr(fixture, "STORAGE", tmp_path / "synthetic")
    base = fixture.STORAGE / "fresh"
    assert fixture.fresh_fixture_paths(
        base / "collection.anki2", base / "test.apkg"
    ) == (base / "collection.anki2", base / "test.apkg")
    base.mkdir(parents=True)
    with pytest.raises(ValueError, match="fresh"):
        fixture.fresh_fixture_paths(base / "collection.anki2", base / "test.apkg")
    with pytest.raises(ValueError, match="inside"):
        fixture.fresh_fixture_paths(
            tmp_path / "collection.anki2", tmp_path / "test.apkg"
        )
    link = fixture.STORAGE / "link"
    link.symlink_to(base, target_is_directory=True)
    with pytest.raises(ValueError, match="symlinks"):
        fixture.fresh_fixture_paths(
            link / "new/collection.anki2", link / "new/test.apkg"
        )


@pytest.mark.parametrize("value", ["", "ordinary text", fixture.BANK.read_text()])
def test_field_name_alone_does_not_intercept_ordinary_notes(col, value):
    model = col.models.by_name("Basic")
    col.models.add_field(model, col.models.new_field(BANK_FIELD))
    col.models.update_dict(model)
    note = col.new_note(col.models.by_name("Basic"))
    note["Front"] = "Ordinary question"
    note["Back"] = "Ordinary answer"
    note[BANK_FIELD] = value
    col.add_note(note, col.decks.id("Ordinary sample"))
    card = note.cards()[0]
    before = card.render_output()
    assert select_skill_review(card) is None
    assert card.render_output() == before
    assert "Ordinary answer" in card.answer()


def test_model_marker_survives_native_package_import(col, tmp_path):
    from anki.import_export_pb2 import (
        ExportAnkiPackageOptions,
        ImportAnkiPackageOptions,
        ImportAnkiPackageRequest,
    )

    package = tmp_path / "skill.apkg"
    col.export_anki_package(
        out_path=str(package), options=ExportAnkiPackageOptions(), limit=None
    )
    target = Collection(str(tmp_path / "target.anki2"))
    try:
        target.import_anki_package(
            ImportAnkiPackageRequest(
                package_path=str(package), options=ImportAnkiPackageOptions()
            )
        )
        card = target.get_card(target.find_cards('deck:"Spanish skill"')[0])
        assert card.note_type()[MODEL_MARKER] == "skill-v1"
        assert select_skill_review(card).exercise.id == "hablar"
    finally:
        target.close()


@pytest.mark.parametrize(
    "raw",
    [
        fixture.BANK.read_text().replace('"version": 1', '"version": true'),
        "[" * 1100 + "0" + "]" * 1100,
    ],
)
def test_malformed_bank_stops_review(col, raw):
    card, _ = next_answer(col, CardAnswer.GOOD)
    note = card.note()
    note[BANK_FIELD] = raw
    col.update_note(note)
    card.load()
    with pytest.raises(SkillReviewError, match="invalid exercise bank"):
        select_skill_review(card)


@pytest.mark.parametrize("used", [True, 3, "", "-1", "G", "f" * 26])
def test_invalid_usage_mask_stops_review(col, used):
    card, _ = next_answer(col, CardAnswer.GOOD)
    review = select_skill_review(card)
    card.custom_data = json.dumps({"lr": {"b": review.cursor_hash, "n": 1, "u": used}})
    col.update_card(card)
    with pytest.raises(SkillReviewError, match="invalid review data"):
        select_skill_review(card)


def test_unlinked_fixture_and_ordinary_cards_never_request_refill(col):
    from anki.learnrecur_skills import skill_refill_request

    card, _ = next_answer(col, CardAnswer.GOOD)
    assert skill_refill_request(card) is None
    card = col.get_card(col.find_cards('deck:"Ordinary sample"')[0])
    assert skill_refill_request(card) is None


def test_full_bank_usage_fits_native_custom_data_and_undo(col):
    card, _ = next_answer(col, CardAnswer.AGAIN)
    note = card.note()
    bank = json.loads(note[BANK_FIELD])
    bank["exercises"] = [
        {
            "id": f"synthetic-{n}",
            "prompt": f"Exercise {n}",
            "answer": str(n),
            "explanation": "Synthetic capacity check.",
        }
        for n in range(100)
    ]
    note[BANK_FIELD] = json.dumps(bank)
    col.update_note(note)
    card.load()
    review = select_skill_review(card)
    card.custom_data = json.dumps(
        {"lr": {"b": review.cursor_hash, "n": 99, "u": format((1 << 99) - 1, "x")}}
    )
    col.update_card(card)
    card, answer = next_answer(col, CardAnswer.AGAIN)
    before = snapshot(col, card.id)
    review = select_skill_review(card)
    assert review.exercise.id == "synthetic-99"
    prepare_skill_answer(col, answer, review)
    assert len(answer.new_state.custom_data.encode()) <= 100
    col.sched.answer_card(answer)
    assert select_skill_review(col.get_card(card.id)).used == (1 << 100) - 1
    col.undo()
    assert snapshot(col, card.id) == before
