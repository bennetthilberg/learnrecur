// Copyright: LearnRecur contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

use anki_proto::notes::ReportSkillExerciseRequest;
use serde_json::json;
use serde_json::Value;

use super::undo::UndoableNoteChange;
use crate::notetype::NotetypeKind;
use crate::prelude::*;
use crate::storage::SkillExerciseReport;

// Match learnrecur_limits.MAX_BANK_BYTES, including native field expansion.
const MAX_BANK_BYTES: usize = 6 * 64 * 1024 * 1024;

impl Collection {
    pub(crate) fn report_skill_exercise(
        &mut self,
        input: ReportSkillExerciseRequest,
    ) -> Result<OpOutput<()>> {
        self.transact(Op::Custom("Report exercise".into()), |col| {
            require!(
                matches!(
                    input.reason.as_str(),
                    "incorrect" | "unclear" | "out_of_scope" | "other"
                ),
                "invalid report reason"
            );
            require!(
                input.expected_bank.len() <= MAX_BANK_BYTES,
                "exercise bank too large"
            );
            let card = col
                .storage
                .get_card(CardId(input.card_id))?
                .or_invalid("missing card")?;
            let note = col
                .storage
                .get_note(card.note_id)?
                .or_invalid("missing note")?;
            let nt = col
                .get_notetype(note.notetype_id)?
                .or_invalid("missing note type")?;
            let other: Value = serde_json::from_slice(&nt.config.other).unwrap_or(Value::Null);
            require!(
                other.get("learnrecur").and_then(Value::as_str) == Some("skill-v1")
                    && nt.config.kind() == NotetypeKind::Normal
                    && nt.templates.len() == 1
                    && card.template_idx == 0,
                "not a skill card"
            );
            let ordinal = nt
                .fields
                .iter()
                .position(|field| field.name == "LearnRecurSkill")
                .or_invalid("missing exercise bank")?;
            require!(
                note.fields()
                    .get(ordinal)
                    .is_some_and(|bank| *bank == input.expected_bank),
                "exercise bank changed"
            );
            let bank: Value = serde_json::from_str(&input.expected_bank)?;
            require!(
                bank.get("version").and_then(Value::as_i64) == Some(1),
                "invalid exercise bank"
            );
            let skill_id = bank
                .get("skill_id")
                .and_then(Value::as_str)
                .filter(|id| !id.trim().is_empty())
                .or_invalid("missing skill identity")?;
            let revision = bank
                .get("revision")
                .and_then(Value::as_i64)
                .filter(|revision| *revision > 0)
                .or_invalid("invalid skill revision")?;
            let exercises = bank
                .get("exercises")
                .and_then(Value::as_array)
                .filter(|exercises| exercises.len() <= 256)
                .or_invalid("invalid exercise bank")?;
            let exercise = exercises
                .iter()
                .find(|exercise| {
                    exercise.get("id").and_then(Value::as_str) == Some(input.exercise_id.as_str())
                })
                .or_invalid("exercise disappeared")?;
            require!(
                exercise
                    .get("status")
                    .is_none_or(|status| status.as_str() == Some("active")),
                "exercise is not available"
            );
            for field in ["id", "prompt", "answer", "explanation"] {
                require!(
                    exercise
                        .get(field)
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty()),
                    "invalid exercise"
                );
            }
            col.add_skill_report_undoable(SkillExerciseReport {
                guid: note.guid,
                skill_id: skill_id.into(),
                revision,
                exercise_id: input.exercise_id,
                payload: serde_json::to_string(&json!({
                    "reason": input.reason, "exercise": exercise,
                    "created_at_ms": TimestampMillis::now().0,
                }))?,
            })
        })
    }

    pub(crate) fn add_skill_report_undoable(&mut self, report: SkillExerciseReport) -> Result<()> {
        self.storage.add_skill_report(&report)?;
        self.storage.queue_skill_report(&report, true)?;
        self.retain_report_modified_time()?;
        self.save_undo(UndoableNoteChange::SkillReportAdded(Box::new(report)));
        Ok(())
    }

    pub(crate) fn remove_skill_report_undoable(
        &mut self,
        report: SkillExerciseReport,
    ) -> Result<()> {
        self.storage.remove_skill_report(&report)?;
        self.storage.queue_skill_report(&report, false)?;
        self.retain_report_modified_time()?;
        self.save_undo(UndoableNoteChange::SkillReportRemoved(Box::new(report)));
        Ok(())
    }

    fn retain_report_modified_time(&mut self) -> Result<()> {
        let stamps = self.storage.get_collection_timestamps()?;
        self.state
            .undo
            .retain_cache_modified_time(TimestampMillis::now().max(TimestampMillis(
                stamps.collection_change.max(stamps.last_sync).0 + 1,
            )));
        Ok(())
    }
}
