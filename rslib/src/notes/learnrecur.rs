// Copyright: LearnRecur contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

use anki_proto::notes::AddSkillNotesRequest;

use crate::notetype::CardGenContext;
use crate::notetype::NotetypeKind;
use crate::prelude::*;
use crate::storage::SkillIdentity;

impl Collection {
    pub(crate) fn add_skill_notes(
        &mut self,
        input: AddSkillNotesRequest,
    ) -> Result<OpOutput<Vec<NoteId>>> {
        require!(
            !input.requests.is_empty() && input.requests.len() <= 100,
            "invalid skill batch size"
        );
        self.transact(Op::AddNote, |col| {
            input
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
                .collect()
        })
    }
}
