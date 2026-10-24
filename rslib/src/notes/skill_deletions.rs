// Copyright: LearnRecur contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

use super::undo::UndoableNoteChange;
use crate::prelude::*;
use crate::storage::SkillIdentity;

/// A deleted skill: the marker that lets its graves sync, and the companion
/// skill to retire. The link is missing only if the note's link was damaged.
#[derive(Clone, Debug)]
pub(crate) struct SkillDeletion {
    identity: SkillIdentity,
    link: Option<(String, String)>,
}

impl Collection {
    /// Called before a trusted skill's note or scheduled card is removed.
    /// Saves a deletion marker for sync and queues the companion retirement,
    /// both in the same undoable step as the deletion.
    pub(crate) fn record_skill_deletion_undoable(&mut self, nid: NoteId) -> Result<()> {
        if !self.is_trusted_skill_note(nid)? || self.storage.skill_deletion_for_note(nid)?.is_some()
        {
            return Ok(());
        }
        let identity = self
            .storage
            .skill_identity_for_note(nid)?
            .or_invalid("missing trusted skill identity")?;
        let link = self.storage.skill_link_for_note(nid)?;
        self.add_skill_deletion_undoable(SkillDeletion { identity, link })
    }

    pub(crate) fn add_skill_deletion_undoable(&mut self, deletion: SkillDeletion) -> Result<()> {
        self.storage
            .add_skill_deletion(&deletion.identity, self.usn()?)?;
        self.queue_retirement(&deletion, true)?;
        self.save_undo(UndoableNoteChange::SkillDeleted(Box::new(deletion)));
        Ok(())
    }

    /// Undo withdraws the marker before it syncs, and withdraws the companion
    /// request with a new version, even if the earlier one was delivered.
    pub(crate) fn remove_skill_deletion_undoable(&mut self, deletion: SkillDeletion) -> Result<()> {
        self.storage.remove_skill_deletion(deletion.identity.nid)?;
        self.queue_retirement(&deletion, false)?;
        self.save_undo(UndoableNoteChange::SkillDeletionWithdrawn(Box::new(
            deletion,
        )));
        Ok(())
    }

    fn queue_retirement(&mut self, deletion: &SkillDeletion, active: bool) -> Result<()> {
        if let Some((source, skill)) = &deletion.link {
            self.storage
                .queue_skill_retirement(&deletion.identity, source, skill, active)?;
            // The queue's version only moves forward, so undo must not make the
            // collection look older to sync or timestamp-based backups.
            self.retain_report_modified_time()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod test {
    use super::*;
    use crate::sync::collection::graves::Graves;

    const GUID: &str = "0123456789abcdef0123456789abcdef";

    /// A synthetic trusted skill: a note whose first card has a companion
    /// identity and link, like one from Import skills.
    fn trusted_skill(col: &mut Collection, reversed: bool) -> (NoteId, CardId) {
        let notetype = if reversed {
            col.basic_rev_notetype()
        } else {
            col.basic_notetype()
        };
        let mut note = notetype.new_note();
        note.set_field(0, "Synthetic skill").unwrap();
        note.set_field(1, "Synthetic answer").unwrap();
        note.guid = GUID.into();
        col.add_note(&mut note, DeckId(1)).unwrap();
        let cid = col
            .storage
            .all_cards_of_note(note.id)
            .unwrap()
            .into_iter()
            .find(|card| card.template_idx == 0)
            .unwrap()
            .id;
        col.storage
            .record_skill_identity(&SkillIdentity {
                nid: note.id,
                cid,
                guid: GUID.into(),
            })
            .unwrap();
        col.storage
            .db
            .execute(
                "insert into learnrecur_skill_links values(?,'source','skill')",
                [note.id],
            )
            .unwrap();
        (note.id, cid)
    }

    fn outbox(col: &Collection) -> Vec<(bool, i64)> {
        col.storage
            .retirement_outbox()
            .unwrap()
            .into_iter()
            .map(|row| (row.active, row.version))
            .collect()
    }

    #[test]
    fn deleting_a_skill_saves_a_marker_and_undo_withdraws_it() {
        let mut col = Collection::new();
        let (nid, cid) = trusted_skill(&mut col, false);
        col.remove_notes(&[nid]).unwrap();
        let marker = col.storage.skill_deletion_for_note(nid).unwrap().unwrap();
        assert_eq!((marker.cid, marker.guid.as_str()), (cid, GUID));
        let row = &col.storage.retirement_outbox().unwrap()[0];
        assert_eq!(
            (row.source_id.as_str(), row.skill_id.as_str()),
            ("source", "skill")
        );
        assert_eq!(outbox(&col), [(true, 1)]);
        let pending = col.storage.pending_graves(Usn(-1)).unwrap();
        assert_eq!(pending.learnrecur_skill_deletions, [marker.clone()]);
        assert_eq!((pending.notes, pending.cards), (vec![nid], vec![cid]));

        col.undo().unwrap();
        assert!(col.storage.get_note(nid).unwrap().is_some());
        assert!(col.storage.skill_deletion_for_note(nid).unwrap().is_none());
        // The withdrawal gets a new version, so it replaces a delivered request.
        assert_eq!(outbox(&col), [(false, 2)]);
        assert!(col
            .storage
            .pending_graves(Usn(-1))
            .unwrap()
            .learnrecur_skill_deletions
            .is_empty());

        col.redo().unwrap();
        assert!(col.storage.get_note(nid).unwrap().is_none());
        assert_eq!(
            col.storage.skill_deletion_for_note(nid).unwrap(),
            Some(marker)
        );
        assert_eq!(outbox(&col), [(true, 3)]);
    }

    #[test]
    fn only_the_scheduled_card_deletes_the_skill() {
        let mut col = Collection::new();
        let (nid, cid) = trusted_skill(&mut col, true);
        let extra = col
            .storage
            .all_cards_of_note(nid)
            .unwrap()
            .into_iter()
            .find(|card| card.id != cid)
            .unwrap()
            .id;
        col.transact(Op::RemoveNote, |col| {
            col.remove_cards_and_orphaned_notes(&[extra])
        })
        .unwrap();
        assert!(col.storage.skill_deletion_for_note(nid).unwrap().is_none());
        assert!(outbox(&col).is_empty());
        col.undo().unwrap();
        // Empty Cards removes the skill's card and keeps the note's other card.
        col.transact(Op::RemoveNote, |col| {
            col.remove_cards_and_orphaned_notes(&[cid])
        })
        .unwrap();
        assert!(col.storage.get_note(nid).unwrap().is_some());
        assert!(col.storage.skill_deletion_for_note(nid).unwrap().is_some());
        assert_eq!(outbox(&col), [(true, 1)]);
        // Deleting the rest of the note later doesn't queue a second request.
        col.remove_notes(&[nid]).unwrap();
        assert_eq!(outbox(&col), [(true, 1)]);
    }

    #[test]
    fn ordinary_deletions_save_no_marker() {
        let mut col = Collection::new();
        let mut note = col.basic_notetype().new_note();
        note.set_field(0, "Ordinary").unwrap();
        col.add_note(&mut note, DeckId(1)).unwrap();
        col.remove_notes(&[note.id]).unwrap();
        assert!(col
            .storage
            .skill_deletion_for_note(note.id)
            .unwrap()
            .is_none());
        assert!(outbox(&col).is_empty());
    }

    fn graves(nid: NoteId, cid: CardId, markers: Vec<SkillIdentity>) -> Graves {
        Graves {
            notes: vec![nid],
            cards: vec![cid],
            learnrecur_skill_deletions: markers,
            ..Default::default()
        }
    }

    #[test]
    fn skill_graves_need_a_matching_marker() {
        let mut col = Collection::new();
        let (nid, cid) = trusted_skill(&mut col, false);
        let marker = SkillIdentity {
            nid,
            cid,
            guid: GUID.into(),
        };
        // An unexplained grave, or one whose marker names another GUID or card,
        // is an ID collision. Nothing changes.
        for markers in [
            vec![],
            vec![SkillIdentity {
                guid: "f".repeat(32),
                ..marker.clone()
            }],
            vec![SkillIdentity {
                cid: CardId(cid.0 + 1),
                ..marker.clone()
            }],
        ] {
            let err = col
                .apply_graves(graves(nid, cid, markers), Usn(5))
                .unwrap_err();
            assert!(format!("{err:?}").contains("same ID as a skill"), "{err:?}");
            assert!(col.storage.get_note(nid).unwrap().is_some());
            assert!(col.storage.skill_deletion_for_note(nid).unwrap().is_none());
        }
        col.apply_graves(graves(nid, cid, vec![marker.clone()]), Usn(5))
            .unwrap();
        assert!(col.storage.get_note(nid).unwrap().is_none());
        assert!(col.storage.get_card(cid).unwrap().is_none());
        // A received marker is already synced, so it isn't sent back.
        assert!(col
            .storage
            .pending_graves(Usn(-1))
            .unwrap()
            .learnrecur_skill_deletions
            .is_empty());
        assert_eq!(
            col.storage
                .pending_graves(Usn(5))
                .unwrap()
                .learnrecur_skill_deletions,
            [marker]
        );
        // The receiving client didn't delete the skill, so it sends no request.
        assert!(outbox(&col).is_empty());
        // Import can't add the deleted skill again.
        assert!(col.storage.skill_identity_was_deleted(nid, cid).unwrap());
    }
}
