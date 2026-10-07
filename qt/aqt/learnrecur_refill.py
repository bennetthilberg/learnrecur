# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Request a refill in the background without changing the local bank."""

from __future__ import annotations

import os
import time
from collections import OrderedDict

import requests

from anki.cards import Card
from anki.learnrecur_skill_import import SkillImportError, decode
from anki.learnrecur_skills import SkillReviewError, skill_refill_request
from aqt.learnrecur_import import companion_connection
from aqt.operations import QueryOp


def send_request(payload: dict, connection: tuple[str, str]) -> None:
    url, token = connection
    try:
        with requests.Session() as session:
            session.trust_env = False
            with session.post(
                url + "/v1/refill-requests",
                json=payload,
                headers={"Authorization": "Bearer " + token},
                timeout=(3, 5),
                allow_redirects=False,
                stream=True,
            ) as response:
                if response.status_code != 200:
                    raise SkillImportError("The companion could not accept a refill.")
                data = bytearray()
                for chunk in response.iter_content(4096):
                    data.extend(chunk)
                    if len(data) > 4096:
                        raise SkillImportError("The refill response is too large.")
        result = decode(bytes(data))
        if not isinstance(result, dict) or set(result) != {"status", "job_id"}:
            raise SkillImportError("The refill response is invalid.")
    except requests.RequestException:
        raise SkillImportError("Could not reach the local companion.") from None


class RefillRequests:
    def __init__(self, collection, *, clock=time.monotonic):
        self.collection = collection
        self.clock = clock
        self.attempted = OrderedDict()
        self.pending = set()

    def check(self, mw, card) -> None:
        if mw.col is not self.collection or not os.environ.get(
            "LEARNRECUR_COMPANION_TOKEN"
        ):
            return
        try:
            payload = skill_refill_request(card)
            if payload is None:
                return
            connection = companion_connection()
        except (SkillReviewError, SkillImportError):
            return  # Invalid cards still use the reviewer's existing error path.
        key = (
            connection[0],
            payload["source_id"],
            payload["skill_id"],
            payload["revision"],
            payload["bank_sequence"],
        )
        now = self.clock()
        if key in self.pending or now - self.attempted.get(key, float("-inf")) < 60:
            return
        if len(self.pending) >= 100:
            return
        self.attempted[key] = now
        self.attempted.move_to_end(key)
        while len(self.attempted) > 100:
            self.attempted.popitem(last=False)
        self.pending.add(key)

        def received(_):
            self.pending.discard(key)
            # Keep retrying infrequently: a bank update may be imported elsewhere,
            # or a previously disabled server may have enabled refills.

        def failed(_):
            self.pending.discard(key)
            print("LearnRecur refill request failed; cached review remains available.")

        QueryOp(
            parent=mw,
            op=lambda _: send_request(payload, connection),
            success=received,
        ).failure(failed).without_collection().run_in_background()


def check_refill(reviewer, *, card: Card | None = None) -> None:
    mw = reviewer.mw
    requests = getattr(reviewer, "_refill_requests", None)
    if requests is None or requests.collection is not mw.col:
        requests = reviewer._refill_requests = RefillRequests(mw.col)
    requests.check(mw, card if card is not None else reviewer.card)
