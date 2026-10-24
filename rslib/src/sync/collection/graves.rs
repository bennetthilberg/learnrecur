// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

use serde::Deserialize;
use serde::Serialize;

use crate::prelude::*;
use crate::storage::SkillIdentity;
use crate::sync::collection::chunks::skill_sync_refusal;
use crate::sync::collection::chunks::CHUNK_SIZE;
use crate::sync::collection::start::ServerSyncState;

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct ApplyGravesRequest {
    pub chunk: Graves,
}

#[derive(Serialize, Deserialize, Debug, Default, Clone)]
pub struct Graves {
    pub(crate) cards: Vec<CardId>,
    pub(crate) decks: Vec<DeckId>,
    pub(crate) notes: Vec<NoteId>,
    /// Skills deleted on purpose. Older peers ignore this field and refuse the
    /// skill's graves, as before.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(crate) learnrecur_skill_deletions: Vec<SkillIdentity>,
}

impl Graves {
    pub(in crate::sync) fn take_chunk(&mut self) -> Option<Graves> {
        let mut limit = CHUNK_SIZE;
        let mut out = Graves::default();
        // Markers go first, so the receiver has them before the graves they cover.
        while limit > 0 && !self.learnrecur_skill_deletions.is_empty() {
            out.learnrecur_skill_deletions
                .push(self.learnrecur_skill_deletions.pop().unwrap());
            limit -= 1;
        }
        while limit > 0 && !self.cards.is_empty() {
            out.cards.push(self.cards.pop().unwrap());
            limit -= 1;
        }
        while limit > 0 && !self.notes.is_empty() {
            out.notes.push(self.notes.pop().unwrap());
            limit -= 1;
        }
        while limit > 0 && !self.decks.is_empty() {
            out.decks.push(self.decks.pop().unwrap());
            limit -= 1;
        }
        if limit == CHUNK_SIZE {
            None
        } else {
            Some(out)
        }
    }
}

impl Collection {
    pub fn apply_graves(&self, graves: Graves, latest_usn: Usn) -> Result<()> {
        // Native graves carry only IDs, so they can't tell a deleted skill from an
        // unrelated note with the same ID. A skill's graves apply only after a
        // deletion marker with its card ID and GUID, sent first in the same sync.
        // Extra cards of a skill note, such as one from an added template, still
        // sync. Deck graves only remove the deck row, as upstream; card moves
        // arrive later in the same sync, and real deletions also send card and
        // note graves.
        for marker in &graves.learnrecur_skill_deletions {
            self.record_remote_skill_deletion(marker, latest_usn)?;
        }
        for nid in &graves.notes {
            self.require_safe_remote_deletion(*nid)?;
        }
        for cid in &graves.cards {
            if let Some(card) = self.storage.get_card(*cid)? {
                if self.is_trusted_skill_card(&card)? {
                    self.require_safe_remote_deletion(card.note_id)?;
                }
            }
        }
        for nid in graves.notes {
            self.storage.remove_note(nid)?;
            self.storage.add_note_grave(nid, latest_usn)?;
        }
        for cid in graves.cards {
            self.storage.remove_card(cid)?;
            self.storage.add_card_grave(cid, latest_usn)?;
        }
        for did in graves.decks {
            self.storage.remove_deck(did)?;
            self.storage.add_deck_grave(did, latest_usn)?;
        }
        Ok(())
    }

    /// Save a marker that matches what this side knows about the skill. A
    /// marker for a different card or GUID means two objects share an ID. It
    /// isn't saved, so the graves it came with are refused below.
    fn record_remote_skill_deletion(&self, marker: &SkillIdentity, usn: Usn) -> Result<()> {
        require!(
            (1..=9_007_199_254_740_991).contains(&marker.nid.0)
                && (1..=9_007_199_254_740_991).contains(&marker.cid.0)
                && marker.guid.len() == 32
                && marker.guid.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "invalid skill deletion marker"
        );
        if self
            .storage
            .skill_identity_for_note(marker.nid)?
            .is_some_and(|identity| identity != *marker)
        {
            return Ok(());
        }
        self.storage.add_skill_deletion(marker, usn)
    }

    /// True when a saved marker names this skill's trusted card and GUID.
    fn skill_deletion_is_explained(&self, nid: NoteId) -> Result<bool> {
        let Some(marker) = self.storage.skill_deletion_for_note(nid)? else {
            return Ok(false);
        };
        Ok(self
            .storage
            .skill_identity_for_note(nid)?
            .is_some_and(|identity| identity == marker))
    }

    fn require_safe_remote_deletion(&self, nid: NoteId) -> Result<()> {
        if !self.is_trusted_skill_note(nid)? || self.skill_deletion_is_explained(nid)? {
            return Ok(());
        }
        // The server refuses a client's deletion; a client refuses the server's.
        Err(if self.server {
            skill_sync_refusal(
                "A skill was deleted on this device, but the server can't confirm it's the \
                 same skill. This happens when an older LearnRecur deletes a skill, or when \
                 a deleted note has the same ID as a skill.",
                "To get it back, open Preferences on this device, turn on \
                 “On next sync, force changes in one direction”, then sync and choose \
                 Download. This replaces changes made on this device since its last sync.",
            )
        } else {
            skill_sync_refusal(
                "Another device deleted a note with the same ID as a skill on this device.",
                "To keep the skill, open Preferences on this device, turn on \
                 “On next sync, force changes in one direction”, then sync and choose \
                 Upload. Your other devices will download it when they next sync.",
            )
        })
    }
}

pub fn server_apply_graves(
    req: ApplyGravesRequest,
    col: &mut Collection,
    state: &mut ServerSyncState,
) -> Result<()> {
    col.apply_graves(req.chunk, state.server_usn)
}

#[cfg(test)]
mod test {
    use super::*;

    const GUID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn markers_lead_the_first_graves_chunk() {
        let marker = SkillIdentity {
            nid: NoteId(1),
            cid: CardId(1),
            guid: GUID.into(),
        };
        let mut graves = Graves {
            cards: (1..300).map(CardId).collect(),
            notes: vec![NoteId(1)],
            learnrecur_skill_deletions: vec![marker.clone()],
            ..Default::default()
        };
        let first = graves.take_chunk().unwrap();
        assert_eq!(first.learnrecur_skill_deletions, [marker]);
        assert!(graves
            .take_chunk()
            .unwrap()
            .learnrecur_skill_deletions
            .is_empty());
        // Without markers, the request matches upstream exactly, and an older
        // request without the field still parses.
        let plain = serde_json::to_value(Graves::default()).unwrap();
        assert_eq!(
            plain,
            serde_json::json!({"cards": [], "decks": [], "notes": []})
        );
        let parsed: Graves = serde_json::from_value(plain).unwrap();
        assert!(parsed.learnrecur_skill_deletions.is_empty());
        // An older peer's struct skips the markers and keeps the graves, then
        // refuses the skill's graves as it always has.
        #[derive(Deserialize)]
        struct OlderGraves {
            notes: Vec<NoteId>,
        }
        let sent = Graves {
            notes: vec![NoteId(1)],
            learnrecur_skill_deletions: first.learnrecur_skill_deletions,
            ..Default::default()
        };
        let older: OlderGraves =
            serde_json::from_value(serde_json::to_value(sent).unwrap()).unwrap();
        assert_eq!(older.notes, [NoteId(1)]);
    }
}
