# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Stream AI help replies from Claude, OpenAI, or OpenRouter with the user's own key.

Nothing here touches the collection. Keys live in the macOS Keychain, and the
caller decides what context to send.
"""

from __future__ import annotations

import re
import subprocess
import sys
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import ROUND_CEILING, Decimal
from typing import Any

# Bounds for one reply. Reasoning tokens count toward these too.
MAX_OUTPUT_TOKENS = 16000
# Current Claude models can write up to 128K tokens in one reply.
CLAUDE_MAX_OUTPUT_TOKENS = 128000
TIMEOUT_SECONDS = 180.0
CONNECT_TIMEOUT_SECONDS = 10.0
OPENROUTER_URL = "https://openrouter.ai/api/v1"

EFFORTS = ("low", "medium", "high", "xhigh", "max")


@dataclass(frozen=True)
class Provider:
    id: str
    label: str
    default_model: str
    default_effort: str
    key_hint: str


PROVIDERS = {
    p.id: p
    for p in (
        Provider("claude", "Claude API", "claude-sonnet-5-5", "high", "sk-ant-"),
        Provider("openai", "OpenAI", "gpt-6-luna", "xhigh", "sk-"),
        Provider("openrouter", "OpenRouter", "openai/gpt-6-luna", "xhigh", "sk-or-"),
    )
}
DEFAULT_PROVIDER = "claude"

# Claude models that accept `speed: "fast"` without a beta header. Asking for
# fast mode on any other Claude model is an error, so it's skipped there.
CLAUDE_FAST_MODELS = frozenset({"claude-opus-5-5"})


@dataclass(frozen=True)
class Prices:
    """US dollars per million tokens."""

    input: Decimal
    output: Decimal
    cache_read: Decimal
    cache_write: Decimal


def _prices(inp: str, out: str, read: str, write: str) -> Prices:
    return Prices(Decimal(inp), Decimal(out), Decimal(read), Decimal(write))


# Checked against the providers' pricing pages on November 3, 2026. The
# rates assume short prompts (under 100,000 tokens for Claude Haiku 5.5 and
# 272,000 for gpt-6-luna); help requests are far smaller. OpenAI's fast mode
# doubles every rate. OpenRouter reports each reply's cost itself.
PRICES: dict[tuple[str, str, bool], Prices] = {
    ("claude", "claude-haiku-5-5", False): _prices("0.10", "0.50", "0.01", "0.125"),
    ("claude", "claude-sonnet-5-5", False): _prices("2", "10", "0.20", "2.50"),
    ("claude", "claude-opus-5-5", False): _prices("4", "20", "0.20", "5"),
    ("claude", "claude-opus-5-5", True): _prices("8", "40", "0.40", "10"),
    ("openai", "gpt-6-luna", False): _prices("0.10", "0.50", "0.01", "0.125"),
    ("openai", "gpt-6-luna", True): _prices("0.20", "1.00", "0.02", "0.25"),
    # Used only if OpenRouter leaves out a reply's cost.
    ("openrouter", "openai/gpt-6-luna", False): _prices(
        "0.10", "0.50", "0.01", "0.125"
    ),
    ("openrouter", "openai/gpt-6-luna", True): _prices("0.20", "1.00", "0.02", "0.25"),
}


class AskError(Exception):
    """A failure the user can act on. The message is shown in the panel.

    `usage` is set when the provider still billed the request, so it can be
    counted toward the monthly limit.
    """

    def __init__(self, message: str, usage: Usage | None = None) -> None:
        super().__init__(message)
        self.usage = usage


@dataclass
class Settings:
    provider: str
    model: str
    effort: str
    fast: bool


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    fast: bool = False
    # OpenRouter reports the charge directly, in US dollars.
    reported_cost: Decimal | None = None


def price_for(settings: Settings, fast: bool) -> Prices | None:
    return PRICES.get((settings.provider, settings.model, fast))


def cost_microusd(settings: Settings, usage: Usage) -> int | None:
    """What a reply cost, rounded up to a millionth of a dollar, or None if unknown."""
    if usage.reported_cost is not None:
        cost = usage.reported_cost
    else:
        prices = price_for(settings, usage.fast)
        if prices is None:
            return None
        cost = (
            usage.input_tokens * prices.input
            + usage.output_tokens * prices.output
            + usage.cache_read_tokens * prices.cache_read
            + usage.cache_write_tokens * prices.cache_write
        ) / Decimal(1_000_000)
    return int((cost * 1_000_000).to_integral_value(rounding=ROUND_CEILING))


def can_track_cost(settings: Settings) -> bool:
    if settings.provider == "openrouter":
        return True
    return price_for(settings, False) is not None and (
        not uses_fast_mode(settings) or price_for(settings, True) is not None
    )


def current_month() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m")


def uses_fast_mode(settings: Settings) -> bool:
    if not settings.fast:
        return False
    if settings.provider == "claude":
        return settings.model in CLAUDE_FAST_MODELS
    return True


# Keychain
##########################################################################

KEYCHAIN_SERVICE = "LearnRecur AI help"
SECURITY = "/usr/bin/security"
# Provider keys use these characters. Anything else is refused rather than
# quoted, since the key is passed to `security -i` on stdin.
KEY_PATTERN = re.compile(r"^[A-Za-z0-9._\-]{20,400}$")


def valid_key(key: str) -> bool:
    return bool(KEY_PATTERN.match(key))


def _keychain_available() -> bool:
    return sys.platform == "darwin"


def load_key(provider: str) -> str | None:
    if not _keychain_available():
        return None
    result = subprocess.run(
        [
            SECURITY,
            "find-generic-password",
            "-s",
            KEYCHAIN_SERVICE,
            "-a",
            provider,
            "-w",
        ],
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if result.returncode != 0:
        return None
    key = result.stdout.strip()
    return key if valid_key(key) else None


def save_key(provider: str, key: str) -> None:
    if provider not in PROVIDERS:
        raise AskError("Unknown provider.")
    if not valid_key(key):
        raise AskError("That doesn't look like an API key.")
    if not _keychain_available():
        raise AskError("Saving keys needs the macOS Keychain.")
    # The key goes through stdin so it never appears in a process list.
    command = (
        f'add-generic-password -U -s "{KEYCHAIN_SERVICE}" -a "{provider}" -w "{key}"\n'
    )
    result = subprocess.run(
        [SECURITY, "-i"],
        input=command,
        capture_output=True,
        text=True,
        timeout=20,
        check=False,
    )
    if result.returncode != 0 or load_key(provider) != key:
        raise AskError("Couldn't save the key in the Keychain.")


def delete_key(provider: str) -> None:
    if not _keychain_available():
        return
    subprocess.run(
        [SECURITY, "delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", provider],
        capture_output=True,
        timeout=20,
        check=False,
    )


# Streaming
##########################################################################

Message = dict[str, str]
OnText = Callable[[str], None]
Cancelled = Callable[[], bool]


def stream_reply(
    settings: Settings,
    key: str,
    system: str,
    messages: list[Message],
    on_text: OnText,
    cancelled: Cancelled,
    http_client: Any = None,
) -> Usage | None:
    """Stream one reply. Returns None if cancelled; raises AskError on failure.

    `http_client` lets tests replay recorded responses through the real SDKs.
    """
    if settings.provider == "claude":
        return _stream_claude(
            settings, key, system, messages, on_text, cancelled, http_client
        )
    if settings.provider in ("openai", "openrouter"):
        base_url = OPENROUTER_URL if settings.provider == "openrouter" else None
        return _stream_responses(
            settings, key, system, messages, on_text, cancelled, base_url, http_client
        )
    raise AskError("Unknown provider.")


def _stream_claude(
    settings: Settings,
    key: str,
    system: str,
    messages: list[Message],
    on_text: OnText,
    cancelled: Cancelled,
    http_client: Any,
) -> Usage | None:
    import anthropic

    client = anthropic.Anthropic(
        api_key=key,
        http_client=http_client,
        max_retries=2,
        timeout=anthropic.Timeout(TIMEOUT_SECONDS, connect=CONNECT_TIMEOUT_SECONDS),
    )
    fast = uses_fast_mode(settings)
    try:
        try:
            return _claude_once(
                client, settings, system, messages, fast, on_text, cancelled
            )
        except anthropic.RateLimitError:
            if not fast:
                raise
            # Fast mode has its own rate limit; fall back to standard speed.
            return _claude_once(
                client, settings, system, messages, False, on_text, cancelled
            )
    except anthropic.AuthenticationError as error:
        raise AskError(
            "Claude rejected your API key. Check it in AI help settings."
        ) from error
    except anthropic.PermissionDeniedError as error:
        raise AskError(f"Claude refused the request: {_api_message(error)}") from error
    except anthropic.NotFoundError as error:
        raise AskError(
            f"Claude doesn't have a model called {settings.model}."
        ) from error
    except anthropic.RateLimitError as error:
        raise AskError(
            "Claude is rate limiting your key. Try again in a minute."
        ) from error
    except anthropic.BadRequestError as error:
        raise AskError(f"Claude couldn't answer: {_api_message(error)}") from error
    except anthropic.APIStatusError as error:
        raise AskError(
            f"Claude had a problem ({error.status_code}). Try again."
        ) from error
    except anthropic.APIConnectionError as error:
        raise AskError("Couldn't reach Claude. Check your connection.") from error


def _claude_once(
    client,
    settings: Settings,
    system: str,
    messages: list[Message],
    fast: bool,
    on_text: OnText,
    cancelled: Cancelled,
) -> Usage | None:
    kwargs: dict = dict(
        model=settings.model,
        max_tokens=CLAUDE_MAX_OUTPUT_TOKENS,
        system=system,
        messages=messages,
        output_config={"effort": settings.effort},
    )
    if fast:
        kwargs["speed"] = "fast"
    with client.messages.stream(**kwargs) as stream:
        for text in stream.text_stream:
            if cancelled():
                return None
            on_text(text)
        final = stream.get_final_message()
    usage = final.usage
    result = Usage(
        input_tokens=usage.input_tokens or 0,
        output_tokens=usage.output_tokens or 0,
        cache_read_tokens=usage.cache_read_input_tokens or 0,
        cache_write_tokens=usage.cache_creation_input_tokens or 0,
        fast=getattr(usage, "speed", None) == "fast",
    )
    if final.stop_reason == "refusal":
        raise AskError("Claude declined to answer this one.", usage=result)
    return result


def _api_message(error) -> str:
    body = getattr(error, "body", None)
    if isinstance(body, dict):
        inner = body.get("error")
        if isinstance(inner, dict) and isinstance(inner.get("message"), str):
            return inner["message"]
    return str(getattr(error, "message", "") or error)


def _stream_responses(
    settings: Settings,
    key: str,
    system: str,
    messages: list[Message],
    on_text: OnText,
    cancelled: Cancelled,
    base_url: str | None,
    http_client: Any,
) -> Usage | None:
    """OpenAI's Responses API, which OpenRouter also serves."""
    import openai

    name = PROVIDERS[settings.provider].label
    client = openai.OpenAI(
        api_key=key,
        base_url=base_url,
        http_client=http_client,
        max_retries=2,
        timeout=openai.Timeout(TIMEOUT_SECONDS, connect=CONNECT_TIMEOUT_SECONDS),
        default_headers=(
            {"X-OpenRouter-Title": "LearnRecur"} if base_url == OPENROUTER_URL else None
        ),
    )
    kwargs: dict = dict(
        model=settings.model,
        instructions=system,
        input=messages,
        reasoning={"effort": settings.effort},
        max_output_tokens=MAX_OUTPUT_TOKENS,
        store=False,
        stream=True,
    )
    if uses_fast_mode(settings):
        kwargs["service_tier"] = "fast"
    try:
        stream = client.responses.create(**kwargs)
        try:
            return _read_responses(stream, settings, name, on_text, cancelled)
        finally:
            stream.close()
    except openai.AuthenticationError as error:
        raise AskError(
            f"{name} rejected your API key. Check it in AI help settings."
        ) from error
    except openai.PermissionDeniedError as error:
        raise AskError(f"{name} refused the request: {_api_message(error)}") from error
    except openai.NotFoundError as error:
        raise AskError(
            f"{name} doesn't have a model called {settings.model}."
        ) from error
    except openai.RateLimitError as error:
        raise AskError(
            f"{name} is rate limiting your key. Try again in a minute."
        ) from error
    except openai.BadRequestError as error:
        raise AskError(f"{name} couldn't answer: {_api_message(error)}") from error
    except openai.APIStatusError as error:
        if error.status_code == 402:
            raise AskError(f"{name} says your account is out of credits.") from error
        raise AskError(
            f"{name} had a problem ({error.status_code}). Try again."
        ) from error
    except openai.APIConnectionError as error:
        raise AskError(f"Couldn't reach {name}. Check your connection.") from error


def _read_responses(
    stream, settings: Settings, name: str, on_text: OnText, cancelled: Cancelled
) -> Usage | None:  # type: ignore[no-untyped-def]
    wrote = False
    for event in stream:
        if cancelled():
            return None
        kind = getattr(event, "type", "")
        if kind == "response.output_text.delta":
            on_text(event.delta)
            wrote = wrote or bool(event.delta)
        elif kind == "response.completed":
            return _responses_usage(event.response, settings)
        elif kind == "response.incomplete":
            if not wrote:
                raise AskError(
                    "The model ran out of room before answering. "
                    "Try a lower reasoning level.",
                    usage=_responses_usage(event.response, settings),
                )
            return _responses_usage(event.response, settings)
        elif kind == "response.failed":
            error = getattr(event.response, "error", None)
            message = getattr(error, "message", "") or "the request failed"
            raise AskError(f"{name} couldn't answer: {message}")
        elif kind == "error":
            raise AskError(f"{name} couldn't answer: {getattr(event, 'message', '')}")
    raise AskError(f"{name} stopped before finishing. Try again.")


def _responses_usage(response, settings: Settings) -> Usage:  # type: ignore[no-untyped-def]
    usage = getattr(response, "usage", None)
    tier = getattr(response, "service_tier", None)
    result = Usage(fast=uses_fast_mode(settings) and tier in ("fast", "priority"))
    if usage is None:
        return result
    details = getattr(usage, "input_tokens_details", None)
    cached = getattr(details, "cached_tokens", 0) or 0
    written = getattr(details, "cache_write_tokens", 0) or 0
    result.input_tokens = max(0, (usage.input_tokens or 0) - cached - written)
    result.cache_read_tokens = cached
    result.cache_write_tokens = written
    result.output_tokens = usage.output_tokens or 0
    if settings.provider == "openrouter":
        cost = getattr(usage, "cost", None)
        if isinstance(cost, (int, float)) and cost >= 0:
            result.reported_cost = Decimal(str(cost))
    return result
