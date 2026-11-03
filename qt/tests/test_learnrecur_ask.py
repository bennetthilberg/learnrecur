"""AI help: provider requests, costs, card context, and the panel's lifecycle.

Provider tests replay recorded server-sent events through the real SDKs, so
no request leaves the machine.
"""

import json
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import MagicMock

import httpx2
import pytest

from aqt import learnrecur_ask as ask
from aqt import learnrecur_ask_client as client
from aqt.learnrecur_ask_client import AskError, Settings, Usage
from aqt.qt import QApplication, QEvent, QKeyEvent, Qt
from tests.test_learnrecur_import import server
from tests.test_learnrecur_review_navigation import start_review
from tests.test_learnrecur_skills import col, reviewer

__all__ = ["col", "reviewer", "server"]

KEY = "sk-test-0123456789abcdefghij"
SYSTEM = "Explain the card."
MESSAGES = [{"role": "user", "content": "Why?"}]


def sse(events):
    return "".join(
        f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events
    ).encode()


def recorder(*responses):
    """An HTTP client that returns `responses` in order and keeps each request."""
    requests = []
    queue = list(responses)

    def handle(request):
        requests.append(request)
        status, body = queue.pop(0)
        headers = {
            "content-type": "text/event-stream" if status == 200 else "application/json"
        }
        return httpx2.Response(status, content=body, headers=headers)

    return httpx2.Client(transport=httpx2.MockTransport(handle)), requests


def claude_events(text_parts, *, stop="end_turn", speed="standard"):
    events = [
        {
            "type": "message_start",
            "message": {
                "id": "msg_1",
                "type": "message",
                "role": "assistant",
                "model": "claude-haiku-5-5",
                "content": [],
                "stop_reason": None,
                "stop_sequence": None,
                "usage": {
                    "input_tokens": 1000,
                    "output_tokens": 1,
                    "cache_read_input_tokens": 0,
                    "cache_creation_input_tokens": 0,
                    "speed": speed,
                },
            },
        },
        {
            "type": "content_block_start",
            "index": 0,
            "content_block": {"type": "text", "text": ""},
        },
    ]
    for part in text_parts:
        events.append(
            {
                "type": "content_block_delta",
                "index": 0,
                "delta": {"type": "text_delta", "text": part},
            }
        )
    events += [
        {"type": "content_block_stop", "index": 0},
        {
            "type": "message_delta",
            "delta": {"stop_reason": stop, "stop_sequence": None},
            "usage": {"output_tokens": 2000},
        },
        {"type": "message_stop"},
    ]
    return sse(events)


def responses_events(
    text_parts, *, usage=None, tier="default", final="response.completed"
):
    events = [
        {
            "type": "response.output_text.delta",
            "item_id": "msg_1",
            "output_index": 0,
            "content_index": 0,
            "delta": part,
            "sequence_number": number,
            "logprobs": [],
        }
        for number, part in enumerate(text_parts, 1)
    ]
    events.append(
        {
            "type": final,
            "sequence_number": len(events) + 1,
            "response": {
                "id": "resp_1",
                "object": "response",
                "created_at": 0,
                "model": "gpt-6-luna",
                "status": "completed"
                if final == "response.completed"
                else "incomplete",
                "service_tier": tier,
                "output": [],
                "usage": usage
                or {
                    "input_tokens": 1500,
                    "input_tokens_details": {
                        "cached_tokens": 500,
                        "cache_write_tokens": 0,
                    },
                    "output_tokens": 3000,
                    "output_tokens_details": {"reasoning_tokens": 2500},
                    "total_tokens": 4500,
                },
            },
        }
    )
    return sse(events)


def run(settings, http, cancelled=lambda: False):
    parts = []
    usage = client.stream_reply(
        settings, KEY, SYSTEM, list(MESSAGES), parts.append, cancelled, http
    )
    return "".join(parts), usage


# Providers


def test_claude_streams_text_and_sends_effort_without_fast_mode_on_haiku():
    http, requests = recorder((200, claude_events(["Ha", "blé"])))
    settings = Settings("claude", "claude-haiku-5-5", "high", fast=True)
    text, usage = run(settings, http)
    body = json.loads(requests[0].content)
    assert text == "Hablé"
    assert requests[0].url.path == "/v1/messages"
    assert requests[0].headers["authorization"] == f"Bearer {KEY}"
    assert body["model"] == "claude-haiku-5-5"
    assert body["system"] == SYSTEM
    assert body["messages"] == MESSAGES
    assert body["output_config"] == {"effort": "high"}
    # Haiku doesn't support fast mode, and asking for it is an error.
    assert "speed" not in body
    assert usage.input_tokens == 1000 and usage.output_tokens == 2000
    # 1,000 input tokens at $0.10/M plus 2,000 output tokens at $0.50/M.
    assert client.cost_microusd(settings, usage) == 1100


def test_claude_fast_mode_on_opus_falls_back_to_standard_when_rate_limited():
    limited = json.dumps(
        {"type": "error", "error": {"type": "rate_limit_error", "message": "slow down"}}
    )
    http, requests = recorder(
        (429, limited.encode()),
        (429, limited.encode()),
        (429, limited.encode()),
        (200, claude_events(["ok"])),
    )
    settings = Settings("claude", "claude-opus-5-5", "medium", fast=True)
    text, usage = run(settings, http)
    speeds = [json.loads(r.content).get("speed") for r in requests]
    assert speeds == ["fast", "fast", "fast", None]
    assert text == "ok" and usage.fast is False


@pytest.mark.parametrize(
    "status, body, message",
    [
        (
            401,
            {"type": "authentication_error", "message": "bad key"},
            "rejected your API key",
        ),
        (
            404,
            {"type": "not_found_error", "message": "model"},
            "doesn't have a model called",
        ),
        (
            400,
            {
                "type": "invalid_request_error",
                "message": "Your credit balance is too low",
            },
            "credit balance is too low",
        ),
    ],
)
def test_claude_errors_say_what_to_do(status, body, message):
    http, _ = recorder((status, json.dumps({"type": "error", "error": body}).encode()))
    with pytest.raises(AskError, match=message):
        run(Settings("claude", "claude-haiku-5-5", "high", fast=False), http)


def test_claude_refusal_is_an_error():
    http, _ = recorder((200, claude_events([], stop="refusal")))
    with pytest.raises(AskError, match="declined"):
        run(Settings("claude", "claude-haiku-5-5", "high", fast=False), http)


def test_openai_streams_with_fast_mode_and_prices_cached_input():
    http, requests = recorder((200, responses_events(["Por", " qué"], tier="priority")))
    settings = Settings("openai", "gpt-6-luna", "xhigh", fast=True)
    text, usage = run(settings, http)
    body = json.loads(requests[0].content)
    assert text == "Por qué"
    assert requests[0].url.host == "api.openai.com"
    assert requests[0].url.path == "/v1/responses"
    assert body["instructions"] == SYSTEM
    assert body["input"] == MESSAGES
    assert body["reasoning"] == {"effort": "xhigh"}
    assert body["service_tier"] == "fast"
    assert body["store"] is False
    assert (usage.input_tokens, usage.cache_read_tokens, usage.fast) == (
        1000,
        500,
        True,
    )
    # Fast rates: 1,000 × $0.20 + 500 × $0.02 + 3,000 × $1.00, per million.
    assert client.cost_microusd(settings, usage) == 3210


def test_openai_downgraded_from_fast_is_billed_at_standard_rates():
    http, _ = recorder((200, responses_events(["x"], tier="default")))
    settings = Settings("openai", "gpt-6-luna", "low", fast=True)
    _, usage = run(settings, http)
    assert usage.fast is False
    assert client.cost_microusd(settings, usage) == 1605


def test_openai_without_fast_mode_sends_no_service_tier():
    http, requests = recorder((200, responses_events(["x"])))
    run(Settings("openai", "gpt-6-luna", "low", fast=False), http)
    assert "service_tier" not in json.loads(requests[0].content)


def test_openai_running_out_of_room_before_any_text_is_an_error():
    http, _ = recorder((200, responses_events([], final="response.incomplete")))
    with pytest.raises(AskError, match="lower reasoning level"):
        run(Settings("openai", "gpt-6-luna", "max", fast=False), http)


def test_openai_failed_response_is_an_error():
    body = sse(
        [
            {
                "type": "error",
                "code": "server_error",
                "message": "boom",
                "param": None,
                "sequence_number": 1,
            }
        ]
    )
    http, _ = recorder((200, body))
    with pytest.raises(AskError, match="boom"):
        run(Settings("openai", "gpt-6-luna", "low", fast=False), http)


def test_openrouter_uses_its_url_and_reported_cost():
    usage = {
        "input_tokens": 100,
        "input_tokens_details": {"cached_tokens": 0},
        "output_tokens": 50,
        "output_tokens_details": {"reasoning_tokens": 0},
        "total_tokens": 150,
        "cost": 0.000123,
    }
    http, requests = recorder((200, responses_events(["hi"], usage=usage)))
    settings = Settings("openrouter", "openai/gpt-6-luna", "xhigh", fast=False)
    text, result = run(settings, http)
    assert text == "hi"
    assert str(requests[0].url) == "https://openrouter.ai/api/v1/responses"
    assert requests[0].headers["authorization"] == f"Bearer {KEY}"
    assert requests[0].headers["x-openrouter-title"] == "LearnRecur"
    assert result.reported_cost == Decimal("0.000123")
    assert client.cost_microusd(settings, result) == 123


def test_openrouter_out_of_credits():
    body = json.dumps(
        {"error": {"code": 402, "message": "Insufficient credits"}}
    ).encode()
    http, _ = recorder((402, body))
    with pytest.raises(AskError, match="out of credits"):
        run(Settings("openrouter", "openai/gpt-6-luna", "xhigh", fast=False), http)


def test_cancelling_stops_reading_and_returns_nothing():
    http, _ = recorder((200, claude_events(["a", "b", "c"])))
    seen = []

    def cancelled():
        return len(seen) >= 1

    usage = client.stream_reply(
        Settings("claude", "claude-haiku-5-5", "high", fast=False),
        KEY,
        SYSTEM,
        list(MESSAGES),
        seen.append,
        cancelled,
        http,
    )
    assert usage is None and seen == ["a"]


# Costs and keys


def test_unknown_models_have_no_price():
    settings = Settings("claude", "claude-someday-9", "high", fast=False)
    assert not client.can_track_cost(settings)
    assert client.cost_microusd(settings, Usage(input_tokens=10)) is None
    assert client.can_track_cost(
        Settings("openrouter", "someone/model", "high", fast=False)
    )


def test_fast_mode_needs_a_fast_price_to_be_tracked():
    assert client.can_track_cost(
        Settings("claude", "claude-opus-5-5", "high", fast=True)
    )
    assert client.can_track_cost(
        Settings("claude", "claude-sonnet-5-5", "high", fast=True)
    )
    assert client.can_track_cost(Settings("openai", "gpt-6-luna", "high", fast=True))


@pytest.mark.parametrize(
    "key, ok",
    [
        ("sk-ant-api03-abcdefghijklmnopqrstuvwxyz_0123-AA", True),
        ("sk-or-v1-0123456789abcdef0123456789abcdef", True),
        ('sk-abc"; rm -rf ~ #0123456789', False),
        ("sk-short", False),
        ("sk-with space-0123456789abcdef", False),
        ("sk-newline\n0123456789abcdefgh", False),
    ],
)
def test_keys_with_unsafe_characters_are_refused(key, ok):
    assert client.valid_key(key) is ok


def test_saving_a_key_passes_it_on_stdin_only(monkeypatch):
    calls = []

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        if args[1] == "find-generic-password":
            return SimpleNamespace(returncode=0, stdout=KEY + "\n")
        return SimpleNamespace(returncode=0, stdout="")

    monkeypatch.setattr(client, "_keychain_available", lambda: True)
    monkeypatch.setattr(client.subprocess, "run", fake_run)
    client.save_key("claude", KEY)
    args, kwargs = calls[0]
    assert args == [client.SECURITY, "-i"]
    assert KEY in kwargs["input"]
    assert all(KEY not in arg for call in calls for arg in call[0])


# Settings and spending


@pytest.fixture
def mw():
    profile = {}
    return SimpleNamespace(pm=SimpleNamespace(profile=profile, save=MagicMock()))


def test_settings_default_to_claude_haiku_without_fast_mode(mw):
    settings = ask.load_settings(mw)
    assert (settings.provider, settings.model, settings.effort, settings.fast) == (
        "claude",
        "claude-haiku-5-5",
        "high",
        False,
    )
    assert ask.monthly_limit(mw) == 1_000_000
    mw.pm.profile[ask.PROFILE_KEY] = {"provider": "openrouter"}
    settings = ask.load_settings(mw)
    assert (settings.model, settings.effort) == ("openai/gpt-6-luna", "xhigh")


def test_spending_resets_each_month(mw, monkeypatch):
    monkeypatch.setattr(ask, "current_month", lambda: "2026-11")
    ask.record_spend(mw, 400)
    ask.record_spend(mw, 600)
    assert ask.spent_this_month(mw) == 1000
    monkeypatch.setattr(ask, "current_month", lambda: "2026-12")
    assert ask.spent_this_month(mw) == 0


def test_no_limit_is_stored_as_zero(mw):
    mw.pm.profile[ask.PROFILE_KEY] = {"limit_microusd": 0}
    assert ask.monthly_limit(mw) is None


# Card context


def test_html_text_keeps_lines_and_marks_media():
    value = (
        "<style>x{}</style><div>Uno<br>dos</div><img src=a.png>[sound:a.mp3]&amp; tres"
    )
    assert ask.html_text(value) == "Uno\ndos\n[image][audio]& tres"


def test_skill_context_has_the_skill_and_exercise(reviewer, monkeypatch):
    monkeypatch.setattr("aqt.learnrecur_refill.RefillRequests.check", lambda *_: None)
    start_review(reviewer, "skill")
    system, is_skill = ask.card_context(reviewer)
    exercise = reviewer._skill_review.exercise
    note = reviewer.card.note()
    assert is_skill
    assert note["Title"] in system and note["Description"] in system
    assert exercise.prompt.strip() in system
    assert f"Answer: {exercise.answer.strip()}" in system
    assert "keep it at the same difficulty" in system


def test_ordinary_context_has_both_sides_and_the_typed_answer(reviewer, monkeypatch):
    start_review(reviewer, "ordinary")
    reviewer.typeCorrect = "perro"
    reviewer.typedAnswer = "pero"
    system, is_skill = ask.card_context(reviewer)
    assert not is_skill
    assert "Deck: Ordinary sample" in system
    assert "The learner typed: pero" in system
    assert "[[type:" not in system
    assert "<style" not in system


def test_typed_answer_placeholders_become_the_expected_answer(reviewer):
    start_review(reviewer, "ordinary")
    card = reviewer.card
    card.question = lambda: "Spanish for dog<br>[[type:Back]]"
    card.answer = lambda: "Spanish for dog<hr id=answer>[[type:Back]]"
    reviewer.typeCorrect = "perro &amp; gato"
    reviewer.typedAnswer = ""
    system, _ = ask.card_context(reviewer)
    assert "Front:\nSpanish for dog\nBack:\nperro & gato" in system
    assert "The learner typed" not in system


# Panel


@pytest.fixture
def app():
    return QApplication.instance() or QApplication([])


def key_event(kind, key, modifiers=Qt.KeyboardModifier.NoModifier, text=""):
    return QKeyEvent(kind, key, modifiers, text)


def test_typing_in_the_box_blocks_review_shortcuts(app):
    panel = SimpleNamespace(hide_panel=MagicMock(), send=MagicMock())
    keep = ask._KeepKeys.__new__(ask._KeepKeys)
    keep.panel, keep.all_keys = panel, True
    for key, text in (
        (Qt.Key.Key_1, "1"),
        (Qt.Key.Key_Space, " "),
        (Qt.Key.Key_H, "h"),
    ):
        event = key_event(QEvent.Type.ShortcutOverride, key, text=text)
        assert keep.eventFilter(None, event) and event.isAccepted()
    command_delete = key_event(
        QEvent.Type.ShortcutOverride,
        Qt.Key.Key_Backspace,
        Qt.KeyboardModifier.ControlModifier,
    )
    assert keep.eventFilter(None, command_delete)
    # Return sends, Shift+Return adds a line, and Esc closes the panel.
    assert keep.eventFilter(None, key_event(QEvent.Type.KeyPress, Qt.Key.Key_Return))
    panel.send.assert_called_once()
    assert not keep.eventFilter(
        None,
        key_event(
            QEvent.Type.KeyPress, Qt.Key.Key_Return, Qt.KeyboardModifier.ShiftModifier
        ),
    )
    assert not keep.eventFilter(
        None, key_event(QEvent.Type.ShortcutOverride, Qt.Key.Key_Escape)
    )
    assert keep.eventFilter(None, key_event(QEvent.Type.KeyPress, Qt.Key.Key_Escape))
    panel.hide_panel.assert_called_once()


def test_reading_the_transcript_lets_rating_keys_through(app):
    keep = ask._KeepKeys.__new__(ask._KeepKeys)
    keep.panel, keep.all_keys = MagicMock(), False
    assert not keep.eventFilter(
        None, key_event(QEvent.Type.ShortcutOverride, Qt.Key.Key_3, text="3")
    )


def test_asking_needs_the_answer_showing(reviewer, monkeypatch):
    tips = []
    monkeypatch.setattr(ask, "tooltip", tips.append)
    reviewer.state = "question"
    ask.toggle(reviewer)
    assert tips == ["Show the answer first."]
    assert ask._panel is None


def test_a_late_reply_never_lands_on_the_next_card():
    old = ask.Chat(showing=1, card_id=1, system="", is_skill=False)
    old.messages.append({"role": "user", "content": "Why?"})
    old.pending = "partial"
    panel = SimpleNamespace(
        chat=ask.Chat(showing=2, card_id=2, system="", is_skill=False)
    )
    ask.AskPanel._finish(panel, old, True, None)
    assert panel.chat.messages == []
