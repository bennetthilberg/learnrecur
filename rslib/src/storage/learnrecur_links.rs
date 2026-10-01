// Copyright: LearnRecur contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

use rusqlite::params;
use rusqlite::OptionalExtension;

use super::SqliteStorage;
use crate::prelude::*;

impl SqliteStorage {
    pub(crate) fn ensure_skill_link_index(&self) -> Result<()> {
        self.db.execute_batch("savepoint learnrecur_link_upgrade")?;
        match self.create_skill_link_index() {
            Ok(()) => {
                self.db.execute_batch("release learnrecur_link_upgrade")?;
                Ok(())
            }
            Err(error) => {
                self.db.execute_batch(
                    "rollback to learnrecur_link_upgrade; release learnrecur_link_upgrade",
                )?;
                Err(error)
            }
        }
    }

    fn create_skill_link_index(&self) -> Result<()> {
        let existed = self.skill_link_index_exists()?;
        self.db.execute_batch(
            "create table if not exists learnrecur_skill_links (
                nid integer primary key, source_id text not null, skill_id text not null
            );
            create index if not exists learnrecur_skill_links_key
                on learnrecur_skill_links(source_id,skill_id)",
        )?;
        if !existed {
            let nids: Vec<NoteId> = self
                .db
                .prepare(
                    "select id from notes where mid in
                    (select ntid from fields where name='LearnRecurLink')",
                )?
                .query_and_then([], |row| Ok(row.get(0)?))?
                .collect::<Result<_>>()?;
            for nid in nids {
                if let Some(note) = self.get_note(nid)? {
                    self.refresh_skill_link(&note)?;
                }
            }
        }
        Ok(())
    }

    fn skill_link_index_exists(&self) -> Result<bool> {
        Ok(self.db.query_row(
            "select exists(select 1 from sqlite_master where type='table' and name='learnrecur_skill_links')",
            [], |row| row.get(0),
        )?)
    }

    pub(crate) fn refresh_skill_links_for_notetype(&self, ntid: NotetypeId) -> Result<()> {
        // Schema upgrades can write note types before the index exists.
        if !self.skill_link_index_exists()? {
            return Ok(());
        }
        self.db.execute(
            "delete from learnrecur_skill_links where nid in (select id from notes where mid=?)",
            [ntid],
        )?;
        let has_link: bool = self.db.query_row(
            "select exists(select 1 from fields where ntid=? and name='LearnRecurLink')",
            [ntid],
            |row| row.get(0),
        )?;
        if !has_link {
            return Ok(());
        }
        let nids: Vec<NoteId> = self
            .db
            .prepare_cached("select id from notes where mid=?")?
            .query_and_then([ntid], |row| Ok(row.get(0)?))?
            .collect::<Result<_>>()?;
        for nid in nids {
            if let Some(note) = self.get_note(nid)? {
                self.refresh_skill_link(&note)?;
            }
        }
        Ok(())
    }

    pub(crate) fn refresh_skill_link(&self, note: &Note) -> Result<()> {
        self.remove_skill_link(note.id)?;
        let ord: Option<usize> = self
            .db
            .query_row(
                "select ord from fields where ntid=? and name='LearnRecurLink'",
                [note.notetype_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(link) = ord.and_then(|ord| note.fields().get(ord)) else {
            return Ok(());
        };
        // Imported links are short. Bound parsing of arbitrary shared-deck data.
        if link.len() > 1024 {
            return Ok(());
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(link) else {
            return Ok(());
        };
        if let (Some(source), Some(skill)) = (
            value.get("source_id").and_then(|v| v.as_str()),
            value.get("skill_id").and_then(|v| v.as_str()),
        ) {
            self.db.execute(
                "insert into learnrecur_skill_links(nid,source_id,skill_id) values(?,?,?)",
                params![note.id, source, skill],
            )?;
        }
        Ok(())
    }

    pub(crate) fn remove_skill_link(&self, nid: NoteId) -> Result<()> {
        self.db
            .execute("delete from learnrecur_skill_links where nid=?", [nid])?;
        Ok(())
    }
}
