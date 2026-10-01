// Copyright: Ankitects Pty Ltd and contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

use serde::Deserialize;
use serde::Serialize;

use crate::prelude::*;
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
}

impl Graves {
    pub(in crate::sync) fn take_chunk(&mut self) -> Option<Graves> {
        let mut limit = CHUNK_SIZE;
        let mut out = Graves::default();
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
        // Native graves carry only IDs, so they cannot prove skill ownership.
        // Refuse skill deletions until reconciliation supports that proof.
        for nid in &graves.notes {
            self.require_safe_remote_deletion(*nid)?;
        }
        for cid in &graves.cards {
            if let Some(card) = self.storage.get_card(*cid)? {
                self.require_safe_remote_deletion(card.note_id)?;
            }
        }
        for did in &graves.decks {
            for nid in self.storage.note_ids_for_remote_deck_deletion(*did)? {
                self.require_safe_remote_deletion(nid)?;
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

    fn require_safe_remote_deletion(&self, nid: NoteId) -> Result<()> {
        let Some(note) = self.storage.get_note(nid)? else {
            return Ok(());
        };
        let notetype = self
            .storage
            .get_notetype(note.notetype_id)?
            .or_not_found(nid)?;
        let marked = serde_json::from_slice::<serde_json::Value>(&notetype.config.other)
            .ok()
            .and_then(|other| other.get("learnrecur").cloned())
            .is_some_and(|kind| kind == "skill-v1");
        let has_skill_field = |name| {
            notetype.fields.iter().enumerate().any(|(index, field)| {
                field.name == name && note.fields().get(index).is_some_and(|v| !v.is_empty())
            })
        };
        require!(
            !(marked || (has_skill_field("LearnRecurLink") && has_skill_field("LearnRecurSkill"))),
            "remote skill deletion is not supported; sync stopped without applying changes"
        );
        Ok(())
    }
}

pub fn server_apply_graves(
    req: ApplyGravesRequest,
    col: &mut Collection,
    state: &mut ServerSyncState,
) -> Result<()> {
    col.apply_graves(req.chunk, state.server_usn)
}
