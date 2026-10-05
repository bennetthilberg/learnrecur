// Copyright: LearnRecur contributors
// License: GNU AGPL, version 3 or later; http://www.gnu.org/licenses/agpl.html

use rusqlite::params;

use super::SqliteStorage;
use crate::prelude::*;

#[derive(Clone, Debug)]
pub(crate) struct SkillExerciseReport {
    pub guid: String,
    pub skill_id: String,
    pub revision: i64,
    pub exercise_id: String,
    pub payload: String,
}

impl SqliteStorage {
    pub(crate) fn ensure_skill_report_table(&self) -> Result<()> {
        self.db.execute_batch(
            "create table if not exists learnrecur_exercise_reports (
                guid text not null, skill_id text not null, revision integer not null,
                exercise_id text not null, payload text not null,
                primary key (guid, skill_id, revision, exercise_id)
            );
            create table if not exists learnrecur_report_outbox (
                report_id text primary key, guid text not null, skill_id text not null,
                revision integer not null, exercise_id text not null, payload text not null,
                active integer not null, version integer not null, acknowledged integer not null,
                unique(guid,skill_id,revision,exercise_id)
            )",
        )?;
        // Upgrade existing reports once. Cancellations remain as delivery tombstones.
        for report in self.all_skill_reports()? {
            if !self.db.query_row(
                "select exists(select 1 from learnrecur_report_outbox where guid=? and skill_id=? and revision=? and exercise_id=?)",
                params![report.guid, report.skill_id, report.revision, report.exercise_id],
                |row| row.get::<_, bool>(0),
            )? {
                self.queue_skill_report(&report, true)?;
            }
        }
        Ok(())
    }

    pub(crate) fn queue_skill_report(
        &self,
        report: &SkillExerciseReport,
        active: bool,
    ) -> Result<()> {
        self.db.execute(
            "insert into learnrecur_report_outbox values(?,?,?,?,?,?,?,1,0)
            on conflict(guid,skill_id,revision,exercise_id) do update set
            payload=excluded.payload,active=excluded.active,version=version+1",
            params![
                format!("{:032x}", rand::random::<u128>()),
                report.guid,
                report.skill_id,
                report.revision,
                report.exercise_id,
                report.payload,
                active
            ],
        )?;
        Ok(())
    }

    pub(crate) fn acknowledge_skill_report(
        &self,
        input: anki_proto::notes::AcknowledgeSkillReportRequest,
    ) -> Result<()> {
        require!(
            input.version > 0
                && input.server_version >= input.version
                && input.server_version < 9_007_199_254_740_991,
            "invalid report receipt"
        );
        // One atomic statement; receipt metadata must not clear native undo or queues.
        // A restored older client can advance past the server's version and retry.
        self.db.execute(
            "update learnrecur_report_outbox set acknowledged=case
                when version=? and active=? then version else 0 end,
                version=case when version=? and active=? then version else ?+1 end
            where report_id=? and version=?",
            params![
                input.server_version,
                input.active,
                input.server_version,
                input.active,
                input.server_version,
                input.report_id,
                input.version
            ],
        )?;
        Ok(())
    }

    pub(crate) fn report_outbox(
        &self,
    ) -> Result<Vec<(String, SkillExerciseReport, bool, i64, i64)>> {
        self.db.prepare("select report_id,guid,skill_id,revision,exercise_id,payload,active,version,acknowledged from learnrecur_report_outbox")?
            .query_and_then([], |row| Ok((row.get(0)?, SkillExerciseReport {
                guid:row.get(1)?, skill_id:row.get(2)?,revision:row.get(3)?,exercise_id:row.get(4)?,payload:row.get(5)?
            },row.get(6)?,row.get(7)?,row.get(8)?)))?.collect()
    }

    pub(crate) fn replace_report_outbox(
        &self,
        rows: &[(String, SkillExerciseReport, bool, i64, i64)],
    ) -> Result<()> {
        self.db
            .execute("delete from learnrecur_report_outbox", [])?;
        for (id, report, active, version, acknowledged) in rows {
            self.db.execute(
                "insert into learnrecur_report_outbox values(?,?,?,?,?,?,?,?,?)",
                params![
                    id,
                    report.guid,
                    report.skill_id,
                    report.revision,
                    report.exercise_id,
                    report.payload,
                    active,
                    version,
                    acknowledged
                ],
            )?;
        }
        Ok(())
    }

    pub(crate) fn add_skill_report(&self, report: &SkillExerciseReport) -> Result<()> {
        self.db.execute(
            "insert into learnrecur_exercise_reports
            (guid,skill_id,revision,exercise_id,payload) values(?,?,?,?,?)",
            params![
                report.guid,
                report.skill_id,
                report.revision,
                report.exercise_id,
                report.payload
            ],
        )?;
        Ok(())
    }

    pub(crate) fn all_skill_reports(&self) -> Result<Vec<SkillExerciseReport>> {
        self.db.prepare(
            "select guid,skill_id,revision,exercise_id,payload from learnrecur_exercise_reports",
        )?.query_and_then([], |row| {
            Ok(SkillExerciseReport {
                guid: row.get(0)?, skill_id: row.get(1)?, revision: row.get(2)?,
                exercise_id: row.get(3)?, payload: row.get(4)?,
            })
        })?.collect()
    }

    pub(crate) fn replace_skill_reports(&self, reports: &[SkillExerciseReport]) -> Result<()> {
        self.db
            .execute_batch("delete from learnrecur_exercise_reports")?;
        for report in reports {
            self.add_skill_report(report)?;
        }
        Ok(())
    }

    pub(crate) fn remove_skill_report(&self, report: &SkillExerciseReport) -> Result<()> {
        self.db.execute(
            "delete from learnrecur_exercise_reports
            where guid=? and skill_id=? and revision=? and exercise_id=?",
            params![
                report.guid,
                report.skill_id,
                report.revision,
                report.exercise_id
            ],
        )?;
        Ok(())
    }
}
