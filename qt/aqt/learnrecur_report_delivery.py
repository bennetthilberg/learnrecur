# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Deliver report and retirement states outside the collection queue, preserving native Undo."""

import os
import time

import requests

from anki.learnrecur_reports import acknowledge_reports, pending_reports
from anki.learnrecur_retirements import acknowledge_retirements, pending_retirements
from anki.learnrecur_skill_import import SkillImportError, decode
from aqt.learnrecur_import import companion_connection, fetch_snapshot
from aqt.operations import CollectionOp, QueryOp


def send_reports(values, connection):
    return _send(
        values,
        connection,
        "/v1/exercise-reports",
        "report_id",
        {"report_id", "version", "active", "status", "job_id"},
        # A deleted skill can't take reports. Other refusals still retry.
        final_refusal=lambda status, error: status == 409 and error == SKILL_DELETED,
    )


def send_retirements(values, connection):
    return _send(
        values,
        connection,
        "/v1/skill-retirements",
        "retirement_id",
        {"retirement_id", "version", "active", "status"},
        final_refusal=lambda status, _error: status in (400, 409),
    )


# Match the companion's RETIRED_ERROR.
SKILL_DELETED = "The skill was deleted."


def _read(response):
    data = bytearray()
    for chunk in response.iter_content(4096):
        data.extend(chunk)
        if len(data) > 4096:
            raise SkillImportError("The companion receipt is too large.")
    return bytes(data)


def _error(response):
    try:
        value = decode(_read(response))
    except (SkillImportError, ValueError):
        return ""
    return value.get("error", "") if isinstance(value, dict) else ""


def _send(values, connection, path, key, fields, *, final_refusal):
    url, token = connection
    receipts = []
    try:
        with requests.Session() as session:
            session.trust_env = False
            for value in values:
                with session.post(
                    url + path,
                    json=value,
                    headers={"Authorization": "Bearer " + token},
                    timeout=(3, 5),
                    allow_redirects=False,
                    stream=True,
                ) as response:
                    if response.status_code != 200:
                        if not final_refusal(response.status_code, _error(response)):
                            raise SkillImportError(
                                "The companion could not accept a request."
                            )
                        # Retrying can't change the answer. Count the request as
                        # handled, so it doesn't hold up later ones.
                        print("LearnRecur: the companion refused a request.")
                        receipts.append(
                            {
                                key: value[key],
                                "version": value["version"],
                                "active": value["active"],
                                "status": "refused",
                                **({"job_id": None} if "job_id" in fields else {}),
                            }
                        )
                        continue
                    data = _read(response)
                result = decode(data)
                if (
                    not isinstance(result, dict)
                    or set(result) != fields
                    or result[key] != value[key]
                    or type(result["version"]) is not int
                    or not value["version"] <= result["version"] < 9_007_199_254_740_991
                    or type(result["active"]) is not bool
                ):
                    raise SkillImportError("The companion receipt is invalid.")
                receipts.append(result)
    except requests.RequestException:
        raise SkillImportError("Could not reach the local companion.") from None
    return receipts


class ReportDelivery:
    outbox = "learnrecur_report_outbox"
    key = "report_id"

    def pending(self, col, source, after="", *, replay=False):
        return pending_reports(col, source, after, replay=replay)

    def send(self, values, connection):
        return send_reports(values, connection)

    def acknowledge(self, col, values, receipts):
        return acknowledge_reports(col, values, receipts)

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
        if not self.collection.db.scalar(f"select exists(select 1 from {self.outbox})"):
            return
        if (
            force
            and self.replayed
            and not self.collection.db.scalar(
                f"select exists(select 1 from {self.outbox} where version>acknowledged)"
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
            print("LearnRecur delivery failed; cached review remains available.")

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
                        return self.acknowledge(col, values, receipts)
                    from anki.collection_pb2 import OpChanges

                    return OpChanges()

                def acknowledged(_):
                    if replay:
                        self.after = values[-1][self.key]
                    # Drain bounded chunks, including a state changed during the POST.
                    self.again = True
                    finish()

                CollectionOp(parent=mw, op=acknowledge).success(acknowledged).failure(
                    failed
                ).run_in_background()

            QueryOp(
                parent=mw,
                op=lambda _: self.send(values, connection),
                success=received,
            ).failure(failed).without_collection().run_in_background()

        def identified(snapshot):
            if not current():
                finish()
                return

            def prepare(col):
                if col is not self.collection or not current():
                    return [], False
                values = self.pending(col, snapshot["source_id"])
                replay = False
                if not values and not self.replayed:
                    replay = True
                    values = self.pending(
                        col, snapshot["source_id"], self.after, replay=True
                    )
                return values, replay

            QueryOp(parent=mw, op=prepare, success=prepared).failure(
                failed
            ).run_in_background()

        # Verify the destination source before sending anything.
        QueryOp(
            parent=mw, op=lambda _: fetch_snapshot(connection), success=identified
        ).failure(failed).without_collection().run_in_background()


class RetirementDelivery(ReportDelivery):
    """Retire deleted skills on the companion, with the same retry rules."""

    outbox = "learnrecur_retirement_outbox"
    key = "retirement_id"

    def pending(self, col, source, after="", *, replay=False):
        return pending_retirements(col, source, after, replay=replay)

    def send(self, values, connection):
        return send_retirements(values, connection)

    def acknowledge(self, col, values, receipts):
        return acknowledge_retirements(col, values, receipts)


def check_reports(mw, *, force=False):
    """Deliver reports, then retirements for deleted skills."""
    if not mw.col:
        return
    for name, kind in (
        ("_report_delivery", ReportDelivery),
        ("_retirement_delivery", RetirementDelivery),
    ):
        controller = getattr(mw, name, None)
        if controller is None or controller.collection is not mw.col:
            controller = kind(mw.col)
            setattr(mw, name, controller)
        controller.check(mw, force=force)
