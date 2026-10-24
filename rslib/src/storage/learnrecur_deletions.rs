// Copyright: LearnRecur contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

use rusqlite::params;
use rusqlite::OptionalExtension;

use super::SqliteStorage;
use crate::prelude::*;
use crate::storage::SkillIdentity;

/// A deleted skill's companion request, kept until the companion confirms it.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct SkillRetirement {
    pub retirement_id: String,
    pub identity: SkillIdentity,
    pub source_id: String,
    pub skill_id: String,
    pub active: bool,
    pub version: i64,
    pub acknowledged: i64,
}

impl SqliteStorage {
    pub(crate) fn ensure_skill_deletion_tables(&self) -> Result<()> {
        // Deletion markers sync with graves. The retirement queue belongs to
        // this client, like the report queue.
        self.db.execute_batch(
            "create table if not exists learnrecur_skill_deletions (
                nid integer primary key, cid integer not null, guid text not null,
                usn integer not null
            );
            create table if not exists learnrecur_retirement_outbox (
                retirement_id text primary key, nid integer not null unique,
                cid integer not null, guid text not null, source_id text not null,
                skill_id text not null, active integer not null, version integer not null,
                acknowledged integer not null
            )",
        )?;
        Ok(())
    }

    pub(crate) fn skill_deletion_for_note(&self, nid: NoteId) -> Result<Option<SkillIdentity>> {
        Ok(self
            .db
            .query_row(
                "select nid,cid,guid from learnrecur_skill_deletions where nid=?",
                [nid],
                |row| {
                    Ok(SkillIdentity {
                        nid: row.get(0)?,
                        cid: row.get(1)?,
                        guid: row.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    pub(crate) fn add_skill_deletion(&self, marker: &SkillIdentity, usn: Usn) -> Result<()> {
        self.db.execute(
            "insert or ignore into learnrecur_skill_deletions(nid,cid,guid,usn) values(?,?,?,?)",
            params![marker.nid, marker.cid, marker.guid, usn],
        )?;
        Ok(())
    }

    pub(crate) fn remove_skill_deletion(&self, nid: NoteId) -> Result<()> {
        self.db
            .execute("delete from learnrecur_skill_deletions where nid=?", [nid])?;
        Ok(())
    }

    pub(crate) fn pending_skill_deletions(&self, pending_usn: Usn) -> Result<Vec<SkillIdentity>> {
        self.db
            .prepare(&format!(
                "select nid,cid,guid from learnrecur_skill_deletions where {}",
                pending_usn.pending_object_clause()
            ))?
            .query_and_then([pending_usn], |row| {
                Ok(SkillIdentity {
                    nid: row.get(0)?,
                    cid: row.get(1)?,
                    guid: row.get(2)?,
                })
            })?
            .collect()
    }

    pub(crate) fn update_pending_skill_deletion_usns(&self, new_usn: Usn) -> Result<()> {
        self.db.execute(
            "update learnrecur_skill_deletions set usn=? where usn=-1",
            [new_usn],
        )?;
        Ok(())
    }

    /// Queue an active request, or a withdrawal. Each change gets a new
    /// version, so a delayed delivery can't undo a later one.
    pub(crate) fn queue_skill_retirement(
        &self,
        identity: &SkillIdentity,
        source_id: &str,
        skill_id: &str,
        active: bool,
    ) -> Result<()> {
        self.db.execute(
            "insert into learnrecur_retirement_outbox values(?,?,?,?,?,?,?,1,0)
            on conflict(nid) do update set cid=excluded.cid,guid=excluded.guid,
            source_id=excluded.source_id,skill_id=excluded.skill_id,
            active=excluded.active,version=version+1",
            params![
                format!("{:032x}", rand::random::<u128>()),
                identity.nid,
                identity.cid,
                identity.guid,
                source_id,
                skill_id,
                active
            ],
        )?;
        Ok(())
    }

    pub(crate) fn acknowledge_skill_retirement(
        &self,
        input: anki_proto::notes::AcknowledgeSkillRetirementRequest,
    ) -> Result<()> {
        require!(
            input.version > 0
                && input.server_version >= input.version
                && input.server_version < 9_007_199_254_740_991,
            "invalid retirement receipt"
        );
        // The same rules as report receipts: a receipt for an older version
        // can't acknowledge a later local change, and a restored client that
        // is behind the server moves past its version and resends.
        self.db.execute(
            "update learnrecur_retirement_outbox set acknowledged=case
                when version=? and active=? then version else 0 end,
                version=case when version=? and active=? then version else ?+1 end
            where retirement_id=? and version=?",
            params![
                input.server_version,
                input.active,
                input.server_version,
                input.active,
                input.server_version,
                input.retirement_id,
                input.version
            ],
        )?;
        Ok(())
    }

    /// After a full download, a skill this client deleted may be back with its
    /// trusted identity and no marker. Withdraw its request with a newer
    /// version, so the companion doesn't retire a skill that can still be
    /// reviewed, whether or not the earlier version was delivered.
    pub(crate) fn withdraw_restored_retirements(&self) -> Result<()> {
        self.db.execute(
            "update learnrecur_retirement_outbox set active=0,version=version+1
            where active=1
            and not exists(select 1 from learnrecur_skill_deletions d
                where d.nid=learnrecur_retirement_outbox.nid)
            and exists(select 1 from learnrecur_skill_identities i
                join notes n on n.id=i.nid and n.guid=i.guid
                where i.nid=learnrecur_retirement_outbox.nid
                and i.guid=learnrecur_retirement_outbox.guid)",
            [],
        )?;
        Ok(())
    }

    pub(crate) fn retirement_outbox(&self) -> Result<Vec<SkillRetirement>> {
        self.db
            .prepare(
                "select retirement_id,nid,cid,guid,source_id,skill_id,active,version,acknowledged
                from learnrecur_retirement_outbox",
            )?
            .query_and_then([], |row| {
                Ok(SkillRetirement {
                    retirement_id: row.get(0)?,
                    identity: SkillIdentity {
                        nid: row.get(1)?,
                        cid: row.get(2)?,
                        guid: row.get(3)?,
                    },
                    source_id: row.get(4)?,
                    skill_id: row.get(5)?,
                    active: row.get(6)?,
                    version: row.get(7)?,
                    acknowledged: row.get(8)?,
                })
            })?
            .collect()
    }

    pub(crate) fn replace_retirement_outbox(&self, rows: &[SkillRetirement]) -> Result<()> {
        self.db
            .execute("delete from learnrecur_retirement_outbox", [])?;
        for row in rows {
            self.db.execute(
                "insert into learnrecur_retirement_outbox values(?,?,?,?,?,?,?,?,?)",
                params![
                    row.retirement_id,
                    row.identity.nid,
                    row.identity.cid,
                    row.identity.guid,
                    row.source_id,
                    row.skill_id,
                    row.active,
                    row.version,
                    row.acknowledged
                ],
            )?;
        }
        Ok(())
    }

    /// The companion source and skill ID recorded for a note's link.
    pub(crate) fn skill_link_for_note(&self, nid: NoteId) -> Result<Option<(String, String)>> {
        Ok(self
            .db
            .query_row(
                "select source_id,skill_id from learnrecur_skill_links where nid=?",
                [nid],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }
}
