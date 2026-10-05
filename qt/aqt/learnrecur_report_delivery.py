# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Deliver report states outside the collection queue, preserving native Undo."""

import os
import time

import requests

from anki.learnrecur_reports import acknowledge_reports, pending_reports
from anki.learnrecur_skill_import import SkillImportError, decode
from aqt.learnrecur_import import companion_connection, fetch_snapshot
from aqt.operations import CollectionOp, QueryOp


def send_reports(values, connection):
    url, token = connection
    receipts = []
    try:
        with requests.Session() as session:
            session.trust_env = False
            for value in values:
                with session.post(
                    url + "/v1/exercise-reports",
                    json=value,
                    headers={"Authorization": "Bearer " + token},
                    timeout=(3, 5),
                    allow_redirects=False,
                    stream=True,
                ) as response:
                    if response.status_code != 200:
                        raise SkillImportError(
                            "The companion could not accept a report."
                        )
                    data = bytearray()
                    for chunk in response.iter_content(4096):
                        data.extend(chunk)
                        if len(data) > 4096:
                            raise SkillImportError("The report receipt is too large.")
                result = decode(bytes(data))
                if (
                    not isinstance(result, dict)
                    or set(result)
                    != {"report_id", "version", "active", "status", "job_id"}
                    or result["report_id"] != value["report_id"]
                    or type(result["version"]) is not int
                    or not value["version"] <= result["version"] < 9_007_199_254_740_991
                    or type(result["active"]) is not bool
                ):
                    raise SkillImportError("The report receipt is invalid.")
                receipts.append(result)
    except requests.RequestException:
        raise SkillImportError("Could not reach the local companion.") from None
    return receipts


class ReportDelivery:
    def __init__(self, collection, *, clock=time.monotonic):
        self.collection = collection
        self.clock = clock
        self.last_attempt = float("-inf")
        self.busy = False
        self.again = False
        self.connection = None
        self.after = ""
        self.replayed = False

    def check(self, mw, *, force=False):
        if mw.col is not self.collection or not os.environ.get(
            "LEARNRECUR_COMPANION_TOKEN"
        ):
            return
        try:
            connection = companion_connection()
        except SkillImportError:
            return
        if self.busy:
            self.again |= force
            return
        if self.connection != connection:
            self.connection = connection
            self.after = ""
            self.replayed = False
            self.last_attempt = float("-inf")
        if not force and self.clock() - self.last_attempt < 60:
            return
        if not self.collection.db.scalar(
            "select exists(select 1 from learnrecur_report_outbox)"
        ):
            return
        if (
            force
            and self.replayed
            and not self.collection.db.scalar(
                "select exists(select 1 from learnrecur_report_outbox where version>acknowledged)"
            )
        ):
            return
        if self.replayed and not force:
            self.after = ""
            self.replayed = False
        self.last_attempt = self.clock()
        self.busy = True

        def current():
            try:
                return (
                    mw.col is self.collection and companion_connection() == connection
                )
            except SkillImportError:
                return False

        def finish():
            self.busy = False
            if self.again and mw.col is self.collection:
                self.again = False
                self.check(mw, force=True)

        def failed(_):
            # A dropped response leaves the persisted state available for retry.
            self.again = False
            finish()
            print("LearnRecur report delivery failed; cached review remains available.")

        def prepared(preparation):
            values, replay = preparation
            if not current():
                finish()
                return
            if not values:
                self.replayed = True
                finish()
                return

            def received(receipts):
                if not current():
                    finish()
                    return

                def acknowledge(col):
                    if col is self.collection and current():
                        return acknowledge_reports(col, values, receipts)
                    from anki.collection_pb2 import OpChanges

                    return OpChanges()

                def acknowledged(_):
                    if replay:
                        self.after = values[-1]["report_id"]
                    # Drain bounded chunks, including a state changed during the POST.
                    self.again = True
                    finish()

                CollectionOp(parent=mw, op=acknowledge).success(acknowledged).failure(
                    failed
                ).run_in_background()

            QueryOp(
                parent=mw,
                op=lambda _: send_reports(values, connection),
                success=received,
            ).failure(failed).without_collection().run_in_background()

        def identified(snapshot):
            if not current():
                finish()
                return

            def prepare(col):
                if col is not self.collection or not current():
                    return [], False
                values = pending_reports(col, snapshot["source_id"])
                replay = False
                if not values and not self.replayed:
                    replay = True
                    values = pending_reports(
                        col, snapshot["source_id"], self.after, replay=True
                    )
                return values, replay

            QueryOp(parent=mw, op=prepare, success=prepared).failure(
                failed
            ).run_in_background()

        # Verify the destination source before sending any exercise text.
        QueryOp(
            parent=mw, op=lambda _: fetch_snapshot(connection), success=identified
        ).failure(failed).without_collection().run_in_background()


def check_reports(mw, *, force=False):
    if not mw.col:
        return
    controller = getattr(mw, "_report_delivery", None)
    if controller is None or controller.collection is not mw.col:
        controller = mw._report_delivery = ReportDelivery(mw.col)
    controller.check(mw, force=force)
