// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

use std::convert::TryFrom;

use num_enum::TryFromPrimitive;
use rusqlite::params;
use rusqlite::OptionalExtension;
use serde::Deserialize;
use serde::Serialize;

use super::SqliteStorage;
use crate::prelude::*;
use crate::sync::collection::graves::Graves;

#[derive(TryFromPrimitive)]
#[repr(u8)]
enum GraveKind {
    Card,
    Note,
    Deck,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct SkillIdentity {
    pub nid: NoteId,
    pub cid: CardId,
    pub guid: String,
}

impl SqliteStorage {
    pub(crate) fn ensure_skill_identity_table(&self) -> Result<()> {
        self.db.execute_batch(
            "create table if not exists learnrecur_skill_identities (
                nid integer primary key, cid integer not null unique, guid text not null unique
            )",
        )?;
        Ok(())
    }

    pub(crate) fn skill_identity_for_note(&self, nid: NoteId) -> Result<Option<SkillIdentity>> {
        Ok(self
            .db
            .query_row(
                "select nid,cid,guid from learnrecur_skill_identities where nid=?",
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

    pub(crate) fn record_skill_identity(&self, identity: &SkillIdentity) -> Result<()> {
        require!(
            (1..=9_007_199_254_740_991).contains(&identity.nid.0)
                && (1..=9_007_199_254_740_991).contains(&identity.cid.0)
                && identity.guid.len() == 32
                && identity.guid.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "invalid trusted skill identity"
        );
        if let Some(existing) = self.skill_identity_for_note(identity.nid)? {
            require!(existing == *identity, "sync skill identity collision");
        } else {
            self.db.execute(
                "insert into learnrecur_skill_identities(nid,cid,guid) values(?,?,?)",
                params![identity.nid, identity.cid, identity.guid],
            )?;
        }
        Ok(())
    }

    pub(crate) fn note_ids_for_remote_deck_deletion(&self, did: DeckId) -> Result<Vec<NoteId>> {
        self.db
            .prepare_cached("select distinct nid from cards where did=? or odid=?")?
            .query_and_then([did, did], |row| Ok(row.get(0)?))?
            .collect()
    }

    pub(crate) fn skill_identity_was_deleted(&self, nid: NoteId, cid: CardId) -> Result<bool> {
        Ok(self.db.query_row(
            "select exists(select 1 from graves where (type=1 and oid=?) or (type=0 and oid=?))",
            [nid.0, cid.0],
            |row| row.get(0),
        )?)
    }

    pub(crate) fn clear_all_graves(&self) -> Result<()> {
        self.db.execute("delete from graves", [])?;
        Ok(())
    }

    pub(crate) fn add_card_grave(&self, cid: CardId, usn: Usn) -> Result<()> {
        self.add_grave(cid.0, GraveKind::Card, usn)
    }

    pub(crate) fn add_note_grave(&self, nid: NoteId, usn: Usn) -> Result<()> {
        self.add_grave(nid.0, GraveKind::Note, usn)
    }

    pub(crate) fn add_deck_grave(&self, did: DeckId, usn: Usn) -> Result<()> {
        self.add_grave(did.0, GraveKind::Deck, usn)
    }

    pub(crate) fn remove_card_grave(&self, cid: CardId) -> Result<()> {
        self.remove_grave(cid.0, GraveKind::Card)
    }

    pub(crate) fn remove_note_grave(&self, nid: NoteId) -> Result<()> {
        self.remove_grave(nid.0, GraveKind::Note)
    }

    pub(crate) fn remove_deck_grave(&self, did: DeckId) -> Result<()> {
        self.remove_grave(did.0, GraveKind::Deck)
    }

    pub(crate) fn pending_graves(&self, pending_usn: Usn) -> Result<Graves> {
        let mut stmt = self.db.prepare(&format!(
            "select oid, type from graves where {}",
            pending_usn.pending_object_clause()
        ))?;
        let mut rows = stmt.query([pending_usn])?;
        let mut graves = Graves::default();
        while let Some(row) = rows.next()? {
            let oid: i64 = row.get(0)?;
            let kind =
                GraveKind::try_from(row.get::<_, u8>(1)?).or_invalid("invalid grave kind")?;
            match kind {
                GraveKind::Card => graves.cards.push(CardId(oid)),
                GraveKind::Note => graves.notes.push(NoteId(oid)),
                GraveKind::Deck => graves.decks.push(DeckId(oid)),
            }
        }
        Ok(graves)
    }

    pub(crate) fn update_pending_grave_usns(&self, new_usn: Usn) -> Result<()> {
        self.db
            .prepare("update graves set usn=? where usn=-1")?
            .execute([new_usn])?;
        Ok(())
    }

    fn add_grave(&self, oid: i64, kind: GraveKind, usn: Usn) -> Result<()> {
        self.db
            .prepare_cached(include_str!("add.sql"))?
            .execute(params![usn, oid, kind as u8])?;
        Ok(())
    }

    /// Only useful when undoing
    fn remove_grave(&self, oid: i64, kind: GraveKind) -> Result<()> {
        self.db
            .prepare_cached(include_str!("remove.sql"))?
            .execute(params![oid, kind as u8])?;
        Ok(())
    }
}
