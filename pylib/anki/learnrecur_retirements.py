# Copyright: LearnRecur contributors
# License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

"""Read bounded retirement requests for deleted skills."""


def pending_retirements(col, source, after="", *, replay=False):
    # The note is gone, so the queue row carries the whole request.
    rows = col.db.all(
        "select retirement_id,nid,guid,skill_id,active,version "
        "from learnrecur_retirement_outbox where source_id=? and "
        + ("retirement_id>?" if replay else "version>acknowledged")
        + " order by retirement_id limit 10",
        source,
        *([after] if replay else []),
    )
    return [
        {
            "retirement_id": retirement_id,
            "version": version,
            "active": bool(active),
            "source_id": source,
            "skill_id": skill_id,
            "guid": guid,
            "native_id": nid,
        }
        for retirement_id, nid, guid, skill_id, active, version in rows
    ]


def acknowledge_retirements(col, sent, receipts):
    from anki.collection_pb2 import OpChanges

    for request, receipt in zip(sent, receipts, strict=True):
        col._backend.acknowledge_skill_retirement(
            retirement_id=request["retirement_id"],
            version=request["version"],
            server_version=receipt["version"],
            active=receipt["active"],
        )
    return OpChanges()
