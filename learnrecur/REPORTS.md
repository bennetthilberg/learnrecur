# Report and skip

During a skill review, choose **More > Report and skip…**. Choose a reason, then select **Report and skip**. Cancel leaves the exercise unchanged.

All reasons have the same effect on review and replacement selection. The reason records what was wrong; it does not change generation in this slice.

The app excludes that exercise and shows another cached question on the same card. Its answer stays hidden. Selection prefers unused exercises, then reuses older eligible exercises if needed. Reported and retired exercises cannot be selected. If none remain, the card stays unrated and offers **Back to deck**.

Reporting changes no note fields, card fields, review counters, schedule, or review log. Rating the replacement still uses Anki's normal answer operation. Auto advance pauses while the report dialog is open.

## Storage and undo

The native collection stores reports in `learnrecur_exercise_reports`, separately from cached exercise content. Each record uses the note GUID, skill ID, revision, and exercise ID. It saves the reason, exercise text, and timestamp. A refill cannot overwrite a report. A later description revision has its own exercises and report keys.

The report is one native undo operation. Undoing it restores the original question with its answer hidden; redo restores the exclusion. Undoing a later rating restores the replacement's usage and schedule while keeping the report. Nothing advances the review cursor until the user rates an exercise.

The pinned question is checked again before reporting, revealing, or rating. A changed bank or exclusion blocks stale actions. The native report transaction also checks the exact bank before saving. A process exit before commit leaves no report; an exit after commit preserves the complete record.

## Current limits

Reports are local in this slice. They survive restart, cached bank updates, and a full sync download. A full download keeps this client's reports and discards reports in the downloaded file. Incremental sync does not send them to another client. Companion delivery and replacement requests that include reports are the next slice; the existing low-bank refill check still counts only eligible exercises.

A complete collection backup includes reports. An ordinary deck package does not. Hosted backups do not receive each new local report through incremental sync. Do not treat this as complete report recovery across devices until companion delivery is implemented.

## Check

```sh
./ninja pylib qt
ANKI_TEST_MODE=1 PYTHONPATH=pylib:out/pylib out/pyenv/bin/python \
  -m pytest pylib/tests/test_learnrecur_reports.py -q
PYTHONPATH=pylib:qt:out/pylib:out/qt out/pyenv/bin/python \
  -m pytest qt/tests/test_learnrecur_skills.py -q
cargo test -p anki --lib sync::collection::tests -- --test-threads=1
```

Tests cover paired replacements, all ratings with both schedulers, native undo/redo, exhausted banks, stale actions, ordinary cards, legacy cursors, revision changes, cache appends, process exit, collection backup restoration, and full sync downloads.

The local Mac demo uses a disposable synthetic profile. Its first exercise deliberately gives `hablo` instead of `hablé`; the cached replacements use `trabajé` and `compré`. No model call is needed. The user approved the native preview before the PR was opened.
