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
            )",
        )?;
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
