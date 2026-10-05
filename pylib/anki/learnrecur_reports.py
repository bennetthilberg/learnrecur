# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Read bounded, trusted report states for companion delivery."""

import json

from anki.learnrecur_skill_links import link_key
from anki.learnrecur_skills import BANK_FIELD


def pending_reports(col, source, after="", *, replay=False):
    rows = col.db.all(
        "select q.report_id,q.guid,q.skill_id,q.revision,q.exercise_id,q.payload,q.active,q.version,c.id "
        "from learnrecur_report_outbox q join notes n on n.guid=q.guid "
        "join learnrecur_skill_identities i on i.nid=n.id and i.guid=n.guid "
        "join cards c on c.id=i.cid and c.nid=n.id "
        "join learnrecur_skill_links l on l.nid=n.id and l.skill_id=q.skill_id "
        "where l.source_id=? and "
        + ("q.report_id>?" if replay else "q.version>q.acknowledged")
        + " order by q.report_id limit 10",
        source,
        *([after] if replay else []),
    )
    result = []
    for (
        report_id,
        guid,
        skill,
        revision,
        exercise_id,
        encoded,
        active,
        version,
        cid,
    ) in rows:
        card = col.get_card(cid)
        if link_key(card.note()) != (source, skill):
            continue
        saved = json.loads(encoded)
        bank = json.loads(card.note()[BANK_FIELD])
        exercise = {
            k: saved["exercise"][k] for k in ("id", "prompt", "answer", "explanation")
        }
        result.append(
            {
                "report_id": report_id,
                "guid": guid,
                "source_id": source,
                "skill_id": skill,
                "revision": revision,
                "exercise_id": exercise_id,
                "version": version,
                "active": bool(active),
                "exercise": exercise,
                "reason": saved["reason"],
                "created_at_ms": saved["created_at_ms"],
                "bank_sequence": bank.get("bank_sequence", 0),
            }
        )
    return result


def acknowledge_reports(col, sent, receipts):
    from anki.collection_pb2 import OpChanges

    for request, receipt in zip(sent, receipts, strict=True):
        col._backend.acknowledge_skill_report(
            report_id=request["report_id"],
            version=request["version"],
            server_version=receipt["version"],
            active=receipt["active"],
        )
    return OpChanges()
