# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""A bounded Claude Message Batches adapter with no transport retries or redirects.

Each job attempt is one batch holding one request. The batch ID plays the same
role as an OpenAI background response ID: the worker saves it before waiting, and
reads it back after a crash instead of submitting again. Batches cost half the
normal price and usually finish within an hour, which suits background refills.
"""

from __future__ import annotations

import http.client
import json
import re
from datetime import date
from fractions import Fraction

from anki.learnrecur_skill_import import SkillImportError, decode, encode
from learnrecur.companion import openai_provider
from learnrecur.companion.jobs import RetryableFailure, TerminalFailure
from learnrecur.companion.openai_provider import ReadFailure, UncertainResponse

NAME = "anthropic-batches-v1"
MODEL = "claude-sonnet-5-5"
API_VERSION = "2026-10-21"
# Batches can return up to 300K output tokens with this beta; the plain API stops
# at 128K. Extra-high effort leaves room for the answer after thinking.
BETA = "output-300k-2026-03-24"
# Sonnet 5.5 batch prices, half the standard rates.
CONFIG = {
    "model": MODEL,
    "api_version": API_VERSION,
    "beta": BETA,
    "max_tokens": 300000,
    "effort": "xhigh",
    "input_usd_per_million": "1",
    "cache_write_usd_per_million": "1.25",
    "cache_read_usd_per_million": "0.10",
    "output_usd_per_million": "5",
    "prices_checked": "2026-11-05",
}
CONFIG_FIELDS = frozenset(CONFIG)
# The first release saved Haiku settings without a beta. A batch submitted with
# them can still be read and charged; new submissions get the current settings.
EARLIER = {"claude-haiku-5-5": CONFIG_FIELDS - {"beta"}}
PRICE_FIELDS = (
    "input_usd_per_million",
    "cache_write_usd_per_million",
    "cache_read_usd_per_million",
    "output_usd_per_million",
)
MAX_REQUEST_BYTES = 32768
# Structured output adds its own system prompt; leave room for it in the bound.
INPUT_SLACK = 4096
# Adaptive thinking lets Claude skip thinking on requests that look easy. At high
# effort, Sonnet skipped it on most exercise batches, then fixed mistakes inside
# the schema-bound JSON ("No: ...") or returned too few exercises.
THINK_FIRST = (
    "Before you write the JSON, think through every exercise: solve it yourself, "
    "confirm that exactly one answer fits, and check that the context, answer, and "
    "explanation all match the exercise. Fix any problem before you write the JSON; "
    "never correct yourself inside it."
)
# Batches take minutes, not seconds, so poll gently.
POLL_SECONDS = 30
# Both providers share one set of exercise rules. Claude's schemas can't fix an
# array's length, so the count goes in the text.
GUIDANCE_VERSION = openai_provider.GUIDANCE_VERSION
GUIDANCE = (
    openai_provider.GUIDANCE + " Return exactly count exercises in the exercises array."
)
RESULT_TYPES = {"succeeded", "errored", "canceled", "expired"}


def response_id(response):
    value = response.get("id") if isinstance(response, dict) else None
    if not isinstance(value, str) or not re.fullmatch(
        r"msgbatch_[A-Za-z0-9_-]{1,180}", value
    ):
        raise UncertainResponse()
    return value


def saved_config(context):
    config = context.get("provider_config")
    if (
        context.get("provider") != NAME
        or not isinstance(config, dict)
        or set(config) != {MODEL: CONFIG_FIELDS, **EARLIER}.get(config.get("model"))
        or config["api_version"] != API_VERSION
        or config.get("beta", BETA) != BETA
        or config["effort"] not in {"low", "medium", "high", "xhigh", "max"}
        or type(config["max_tokens"]) is not int
        or not 1 <= config["max_tokens"] <= 300000
    ):
        raise SkillImportError(
            "This worker does not support the saved provider settings."
        )
    for field in PRICE_FIELDS:
        value = config[field]
        if (
            not isinstance(value, str)
            or not re.fullmatch(r"[0-9]{1,4}(?:\.[0-9]{1,12})?", value)
            or Fraction(value) > 1000
        ):
            raise SkillImportError("Invalid saved provider prices.")
    try:
        date.fromisoformat(config["prices_checked"])
    except (TypeError, ValueError):
        raise SkillImportError("Invalid saved provider price date.") from None
    return config


def request_body(context):
    """The Messages parameters for one batch request."""
    config = saved_config(context)
    version = context.get("instructions_version", 1)
    fields = ["prompt", "answer", "explanation"]
    if version >= 4:
        fields += ["instruction", "context"]
    properties = {key: {"type": "string"} for key in fields}
    if version >= 5:
        # Blank limits are checked on import; schemas can't bound array length.
        properties["blanks"] = {"type": "array", "items": {"type": "string"}}
    exercise = {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }
    skill = context["skill"]
    body = {
        "model": config["model"],
        "max_tokens": config["max_tokens"],
        "thinking": {"type": "adaptive"},
        "output_config": {
            "effort": config["effort"],
            "format": {
                "type": "json_schema",
                "schema": {
                    "type": "object",
                    "properties": {"exercises": {"type": "array", "items": exercise}},
                    "required": ["exercises"],
                    "additionalProperties": False,
                },
            },
        },
        "system": context["instructions"] + "\n\n" + THINK_FIRST,
        "messages": [
            {
                "role": "user",
                "content": encode(
                    {
                        "skill": {
                            key: skill[key]
                            for key in (
                                "title",
                                "description",
                                "formatting_preferences",
                            )
                            if key in skill
                        },
                        "count": context["count"],
                        "examples": context["examples"],
                        "existing_prompts": context["existing_prompts"],
                    }
                ),
            }
        ],
    }
    if len(encode(body).encode()) > MAX_REQUEST_BYTES:
        raise SkillImportError(
            "This trial's model request is too large. Use shorter guidance."
        )
    return body


def _input_bound(context):
    # UTF-8 bytes are a conservative text-token bound.
    return len(encode(request_body(context)).encode()) + INPUT_SLACK


class AnthropicProvider:
    name = NAME
    poll_seconds = POLL_SECONDS
    # Unsubmitted jobs pick up the current model, effort, limit, and prices,
    # so a bad setting is fixed by a release instead of failing every retry.
    refresh_settings = True

    def __init__(self, key, *, transport=None):
        self._key = key
        self._transport = transport or self._http

    response_id = staticmethod(response_id)

    def _http(self, method, path, body=None, trace=None):
        connection = http.client.HTTPSConnection("api.anthropic.com", timeout=20)
        try:
            connection.request(
                method,
                path,
                body=encode(body).encode() if body else None,
                headers={
                    "x-api-key": self._key,
                    "anthropic-version": API_VERSION,
                    "anthropic-beta": BETA,
                    "content-type": "application/json",
                },
            )
            response = connection.getresponse()
            if response.status != 200:
                # Rejections and overload happen before a batch exists.
                if method == "POST" and response.status in (400, 401, 403, 404, 413):
                    raise TerminalFailure()
                if method == "POST" and response.status in (429, 529):
                    raise RetryableFailure()
                if method == "GET" and response.status in (
                    429,
                    500,
                    502,
                    503,
                    504,
                    529,
                ):
                    raise ReadFailure()
                raise UncertainResponse()
            raw = response.read(1024 * 1024 + 1)
            if len(raw) > 1024 * 1024:
                raise UncertainResponse()
            if path.endswith("/results"):
                return [decode(line) for line in raw.splitlines() if line.strip()]
            return decode(raw)
        except (OSError, http.client.HTTPException, ValueError):
            if method == "GET":
                raise ReadFailure() from None
            raise UncertainResponse() from None
        finally:
            connection.close()

    def estimate(self, context):
        config = saved_config(context)
        if any(
            Fraction(config[field]) != Fraction(CONFIG[field]) for field in PRICE_FIELDS
        ):
            raise SkillImportError(
                "Request a new job with the current provider prices."
            )
        input_rate = max(Fraction(config[field]) for field in PRICE_FIELDS[:3])
        cost = _input_bound(context) * input_rate + config["max_tokens"] * Fraction(
            config["output_usd_per_million"]
        )
        return (cost.numerator + cost.denominator - 1) // cost.denominator

    def submit(self, context, meta):
        self.estimate(context)  # Never submit an uncharged job with stale prices.
        body = {
            "requests": [
                {
                    "custom_id": meta["learnrecur_request_id"],
                    "params": request_body(context),
                }
            ]
        }
        return self._transport(
            "POST", "/v1/messages/batches", body, meta["learnrecur_request_id"]
        )

    def retrieve(self, value):
        """Read the batch, plus its one result once processing has ended."""
        response_id({"id": value})
        batch = self._transport("GET", "/v1/messages/batches/" + value)
        if isinstance(batch, dict) and batch.get("processing_status") == "ended":
            results = self._transport(
                "GET", "/v1/messages/batches/" + value + "/results"
            )
            return {**batch, "results": results}
        return batch

    @staticmethod
    def check(response, context, meta):
        config = saved_config(context)
        response_id(response)
        if response.get("type") != "message_batch" or response.get(
            "processing_status"
        ) not in {"in_progress", "canceling", "ended"}:
            raise UncertainResponse()
        results = response.get("results")
        if results is None:
            return
        if (
            not isinstance(results, list)
            or len(results) != 1
            or not isinstance(results[0], dict)
            or results[0].get("custom_id") != meta["learnrecur_request_id"]
            or not isinstance(results[0].get("result"), dict)
            or results[0]["result"].get("type") not in RESULT_TYPES
        ):
            raise UncertainResponse()
        outcome = results[0]["result"]
        if outcome["type"] == "succeeded" and (
            not isinstance(outcome.get("message"), dict)
            or outcome["message"].get("model") != config["model"]
        ):
            raise UncertainResponse()

    def result(self, response, context, meta):
        self.check(response, context, meta)
        config = saved_config(context)
        if response["processing_status"] != "ended":
            return None
        if "results" not in response:
            raise UncertainResponse()
        outcome = response["results"][0]["result"]
        if outcome["type"] != "succeeded":
            # Errored, canceled, and expired requests aren't billed.
            return {
                "exercises": [],
                "usage": {
                    "input_tokens": 0,
                    "output_tokens": 0,
                    "gross_cost_microusd": 0,
                },
            }
        message = outcome["message"]
        usage = message.get("usage")
        if not isinstance(usage, dict):
            raise UncertainResponse()
        inputs, outputs = usage.get("input_tokens"), usage.get("output_tokens")
        writes = usage.get("cache_creation_input_tokens") or 0
        reads = usage.get("cache_read_input_tokens") or 0
        if (
            any(type(n) is not int or n < 0 for n in (inputs, outputs, writes, reads))
            or outputs > config["max_tokens"]
            or inputs + writes + reads > _input_bound(context)
        ):
            raise UncertainResponse()
        # Thinking tokens are already included in output_tokens.
        cost = (
            inputs * Fraction(config["input_usd_per_million"])
            + writes * Fraction(config["cache_write_usd_per_million"])
            + reads * Fraction(config["cache_read_usd_per_million"])
            + outputs * Fraction(config["output_usd_per_million"])
        )
        cost = (cost.numerator + cost.denominator - 1) // cost.denominator
        exercises = []
        if message.get("stop_reason") == "end_turn":
            try:
                texts = [
                    block["text"]
                    for block in message["content"]
                    if block["type"] == "text"
                ]
                if len(texts) == 1:
                    value = json.loads(texts[0])
                    if isinstance(value, dict) and set(value) == {"exercises"}:
                        exercises = value["exercises"]
                        if isinstance(exercises, list):
                            exercises = exercises[: context["count"]]
            except (KeyError, TypeError, ValueError):
                pass  # Malformed output still has a known charge.
        return {
            "exercises": exercises,
            "usage": {
                "input_tokens": inputs + writes + reads,
                "output_tokens": outputs,
                "gross_cost_microusd": cost,
            },
        }
