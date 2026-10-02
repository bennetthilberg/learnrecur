# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Fetch completed banks and apply them outside an active review."""

from __future__ import annotations

import os
import time

from anki.learnrecur_skill_import import SkillImportError, import_snapshot
from aqt.learnrecur_import import companion_connection, fetch_snapshot
from aqt.operations import CollectionOp, QueryOp

SAFE_STATES = ("deckBrowser", "overview")


class BatchDelivery:
    def __init__(self, collection, *, clock=time.monotonic):
        self.collection = collection
        self.clock = clock
        self.last_fetch = float("-inf")
        self.fetching = False
        self.applying = False
        self.snapshot = None
        self.connection = None
        self.resume_review = None
        self.navigation = 0

    def cancel_review(self) -> None:
        self.navigation += 1
        self.resume_review = None

    def defer_review(self, mw, resume) -> bool:
        if not self.applying or not self.safe(mw):
            return False
        state = mw.state
        navigation = self.navigation
        deck = self.collection.decks.selected()

        def resume_if_current():
            if (
                self.safe(mw)
                and self.navigation == navigation
                and mw.state == state
                and self.collection.decks.selected() == deck
            ):
                resume()

        self.resume_review = resume_if_current
        return True

    def finish_apply(self, mw) -> None:
        self.applying = False
        if resume := self.resume_review:
            self.resume_review = None
            mw.progress.single_shot(0, resume)

    def safe(self, mw) -> bool:
        return mw.col is self.collection and mw.state in SAFE_STATES

    def check(self, mw) -> None:
        if not self.safe(mw) or not os.environ.get("LEARNRECUR_COMPANION_TOKEN"):
            return
        try:
            connection = companion_connection()
        except SkillImportError:
            return
        if self.connection != connection:
            self.snapshot = None
            self.last_fetch = float("-inf")
            self.connection = connection
        if self.applying or self.fetching:
            return
        if self.snapshot is not None:
            self.apply(mw)
            return
        if self.clock() - self.last_fetch < 60:
            return
        # Packages alone cannot opt a profile into background delivery.
        if not self.collection.db.scalar(
            "select exists(select 1 from learnrecur_skill_identities i "
            "join notes n on n.id=i.nid join cards c on c.id=i.cid "
            "where n.guid=i.guid and c.nid=i.nid)"
        ):
            return
        self.last_fetch = self.clock()
        self.fetching = True

        def received(snapshot):
            self.fetching = False
            try:
                if (
                    mw.col is not self.collection
                    or companion_connection() != connection
                ):
                    return
            except SkillImportError:
                return
            self.snapshot = snapshot
            self.apply(mw)

        def failed(_):
            self.fetching = False
            print("LearnRecur batch download failed; cached review remains available.")

        QueryOp(
            parent=mw, op=lambda _: fetch_snapshot(connection), success=received
        ).failure(failed).without_collection().run_in_background()

    def apply(self, mw) -> None:
        if not self.safe(mw) or self.snapshot is None or self.applying:
            return
        snapshot = self.snapshot
        connection = self.connection
        self.applying = True

        def apply(col):
            # Recheck when the serialized collection operation actually starts.
            if not self.safe(mw) or col is not self.collection:
                return None
            if companion_connection() != connection:
                return None
            return import_snapshot(col, snapshot, cache_only=True)

        def finished(result):
            if result is not None:
                self.snapshot = None
            self.finish_apply(mw)

        def failed(_):
            self.snapshot = None
            self.finish_apply(mw)
            print("LearnRecur batch update deferred; cached review remains available.")

        # Native operation hooks receive an empty change set if review began
        # while the cache operation was queued.
        from anki.collection import OpChanges

        def operation(col):
            result = apply(col)
            return result if result is not None else OpChanges()

        CollectionOp(parent=mw, op=operation).success(
            lambda result: finished(None if isinstance(result, OpChanges) else result)
        ).failure(failed).run_in_background()


def check_delivery(mw) -> None:
    if not mw.col:
        return
    controller = getattr(mw, "_batch_delivery", None)
    if controller is None or controller.collection is not mw.col:
        controller = mw._batch_delivery = BatchDelivery(mw.col)
    controller.check(mw)
