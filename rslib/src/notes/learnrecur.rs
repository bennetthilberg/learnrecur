// Copyright: LearnRecur contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

use anki_proto::notes::AddSkillNotesRequest;

use crate::notes::UpdateNoteInnerWithoutCardsArgs;
use crate::notetype::CardGenContext;
use crate::notetype::NotetypeKind;
use crate::prelude::*;
use crate::storage::SkillIdentity;

const SKILL_FIELDS: [&str; 7] = [
    "Title",
    "Description",
    "Prompt",
    "Answer",
    "Explanation",
    "LearnRecurSkill",
    "LearnRecurLink",
];

impl Collection {
    pub(crate) fn add_skill_notes(
        &mut self,
        input: AddSkillNotesRequest,
    ) -> Result<OpOutput<Vec<NoteId>>> {
        require!(
            (1..=100).contains(&(input.requests.len() + input.updates.len())),
            "invalid skill batch size"
        );
        self.transact(Op::AddNote, |col| {
            let mut ids = input
                .requests
                .into_iter()
                .map(|request| {
                    let mut note: Note = request.note.or_invalid("missing skill note")?.into();
                    let cid = CardId(request.card_id);
                    let did = DeckId(request.deck_id);
                    require!(
                        (1..=9_007_199_254_740_991).contains(&note.id.0)
                            && (1..=9_007_199_254_740_991).contains(&cid.0)
                            && note.guid.len() == 32
                            && note.guid.bytes().all(|byte| byte.is_ascii_hexdigit()),
                        "invalid companion card identity"
                    );
                    require!(
                        col.storage.get_note(note.id)?.is_none()
                            && col.storage.get_card(cid)?.is_none()
                            && !col.storage.skill_identity_was_deleted(note.id, cid)?,
                        "companion card identity is already used or deleted"
                    );
                    let nt = col
                        .get_notetype(note.notetype_id)?
                        .or_invalid("missing note type")?;
                    require!(
                        nt.config.kind() == NotetypeKind::Normal
                            && nt.templates.len() == 1
                            && nt.fields.iter().map(|field| field.name.as_str()).eq([
                                "Title",
                                "Description",
                                "Prompt",
                                "Answer",
                                "Explanation",
                                "LearnRecurSkill",
                                "LearnRecurLink"
                            ]),
                        "a skill needs its note fields and one normal template"
                    );
                    let last_deck = col.get_last_deck_added_to_for_notetype(note.notetype_id);
                    let ctx = CardGenContext::new(nt.as_ref(), last_deck, col.usn()?);
                    let normalize_text = col.get_config_bool(BoolKey::NormalizeNoteText);
                    col.canonify_note_tags(&mut note, ctx.usn)?;
                    note.prepare_for_update(ctx.notetype, normalize_text)?;
                    note.set_modified(ctx.usn);
                    col.add_note_only_with_id_undoable(&mut note)?;
                    col.generate_skill_card(&ctx, &note, did, cid)?;
                    col.storage.record_skill_identity(&SkillIdentity {
                        nid: note.id,
                        cid,
                        guid: note.guid.clone(),
                    })?;
                    col.set_last_deck_for_notetype(note.notetype_id, did)?;
                    col.set_last_notetype_for_deck(did, note.notetype_id)?;
                    col.set_current_notetype_id(note.notetype_id)?;
                    Ok(note.id)
                })
                .collect::<Result<Vec<_>>>()?;
            for request in input.updates {
                let expected: Note = request
                    .expected
                    .or_invalid("missing expected skill")?
                    .into();
                let mut note: Note = request.note.or_invalid("missing revised skill")?.into();
                let cid = CardId(request.card_id);
                let original = col.storage.get_note(note.id)?.or_not_found(note.id)?;
                require!(
                    original.id == expected.id
                        && original.guid == expected.guid
                        && original.notetype_id == expected.notetype_id
                        && original.fields() == expected.fields()
                        && original.tags == expected.tags
                        && note.id == original.id
                        && note.guid == original.guid
                        && note.notetype_id == original.notetype_id
                        && note.tags == original.tags
                        && !ids.contains(&note.id),
                    "skill changed before revision; import again"
                );
                let identity = col
                    .storage
                    .skill_identity_for_note(note.id)?
                    .or_invalid("missing trusted skill identity")?;
                let cards = col.storage.all_cards_of_note(note.id)?;
                require!(
                    identity.cid == cid
                        && identity.guid == note.guid
                        && cards.len() == 1
                        && cards[0].id == cid,
                    "skill card identity changed"
                );
                let (new_order, new_fields) = col.skill_revision_state(&note)?;
                let (old_order, old_fields) = col.skill_revision_state(&original)?;
                require!(new_order > old_order, "skill revision or bank must advance");
                if new_order.0 == old_order.0 {
                    Self::validate_skill_bank_append(&old_fields, &new_fields)?;
                }
                let nt = col
                    .get_notetype(note.notetype_id)?
                    .or_invalid("missing note type")?;
                let usn = col.usn()?;
                let normalize_text = col.get_config_bool(BoolKey::NormalizeNoteText);
                col.update_note_inner_without_cards(UpdateNoteInnerWithoutCardsArgs {
                    note: &mut note,
                    original: &original,
                    notetype: &nt,
                    usn,
                    mark_note_modified: true,
                    normalize_text,
                    update_tags: false,
                    mtime: None,
                })?;
                ids.push(note.id);
            }
            Ok(ids)
        })
    }

    pub(crate) fn validate_skill_bank_append(older: &[String], newer: &[String]) -> Result<()> {
        let old: serde_json::Value =
            serde_json::from_str(&older[5]).or_invalid("invalid old bank")?;
        let new: serde_json::Value =
            serde_json::from_str(&newer[5]).or_invalid("invalid new bank")?;
        let old_link: serde_json::Value =
            serde_json::from_str(&older[6]).or_invalid("invalid old link")?;
        let new_link: serde_json::Value =
            serde_json::from_str(&newer[6]).or_invalid("invalid new link")?;
        let empty = vec![];
        let old_batches = old
            .get("bank_updates")
            .and_then(|v| v.as_array())
            .unwrap_or(&empty);
        let new_batches = new
            .get("bank_updates")
            .and_then(|v| v.as_array())
            .or_invalid("missing bank history")?;
        let old_exercises = old
            .get("exercises")
            .and_then(|v| v.as_array())
            .or_invalid("missing old exercises")?;
        let new_exercises = new
            .get("exercises")
            .and_then(|v| v.as_array())
            .or_invalid("missing new exercises")?;
        require!(
            older[..5] == newer[..5]
                && old_link["source_id"] == new_link["source_id"]
                && old_link["skill_id"] == new_link["skill_id"]
                && old["version"] == new["version"]
                && old["skill_id"] == new["skill_id"]
                && old["revision"] == new["revision"]
                && old.get("definition") == new.get("definition")
                && old.get("retired_revisions") == new.get("retired_revisions")
                && new_batches.len() > old_batches.len()
                && new_batches.starts_with(old_batches)
                && new.get("bank_sequence").and_then(|v| v.as_u64())
                    == Some(new_batches.len() as u64)
                && new_exercises.len() > old_exercises.len()
                && new_exercises.starts_with(old_exercises),
            "conflicting exercise batch; cached content was kept"
        );
        if let Some(base) = old.get("base_skill") {
            require!(
                new.get("base_skill") == Some(base),
                "skill definition changed during refill"
            );
        } else {
            require!(
                new["base_skill"]["bank"]["exercises"] == old["exercises"],
                "base exercises changed during refill"
            );
        }
        Ok(())
    }

    pub(crate) fn set_skill_revision_fields(
        &mut self,
        note: &mut Note,
        fields: Vec<String>,
    ) -> Result<()> {
        let nt = self
            .get_notetype(note.notetype_id)?
            .or_invalid("missing skill note type")?;
        for (name, content) in SKILL_FIELDS.into_iter().zip(fields) {
            let ord = nt
                .fields
                .iter()
                .position(|field| field.name == name)
                .or_invalid("skill revision fields changed")?;
            note.set_field(ord, content)?;
        }
        Ok(())
    }

    pub(crate) fn skill_revision_state(
        &mut self,
        note: &Note,
    ) -> Result<((u64, u64), Vec<String>)> {
        let nt = self
            .get_notetype(note.notetype_id)?
            .or_invalid("missing skill note type")?;
        let mut fields = vec![];
        for name in SKILL_FIELDS {
            let ord = nt
                .fields
                .iter()
                .position(|field| field.name == name)
                .or_invalid("skill revision fields changed")?;
            fields.push(
                note.fields()
                    .get(ord)
                    .or_invalid("missing skill field")?
                    .clone(),
            );
        }
        let bank: serde_json::Value = serde_json::from_str(&fields[5])
            .ok()
            .or_invalid("invalid skill revision")?;
        let revision = bank
            .get("revision")
            .and_then(|value| value.as_u64())
            .filter(|revision| (1..=100).contains(revision))
            .or_invalid("invalid skill revision")?;
        let sequence = match bank.get("bank_sequence") {
            Some(value) => value
                .as_u64()
                .filter(|n| (1..=100).contains(n))
                .or_invalid("invalid bank sequence")?,
            None => 0,
        };
        Ok(((revision, sequence), fields))
    }
}
