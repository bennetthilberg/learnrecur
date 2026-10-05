# Report and skip

During a skill review, choose **More > Report and skip…**. Choose a reason, then select **Report and skip**. Cancel leaves the exercise unchanged.

All reasons have the same effect on review and replacement selection. The reason records what was wrong; it does not yet add reason-specific instructions to generation.

The app excludes that exercise and shows another cached question on the same card, with its answer hidden. Selection prefers unused exercises, then reuses older eligible exercises if needed. Reported and retired exercises cannot be selected. If none remain, the card stays unrated and offers **Back to deck**.

Reporting changes no note fields, card fields, review counters, schedule, or review log. Rating the replacement still uses Anki's normal answer operation. Auto advance pauses while the report dialog is open.

## Storage and undo

The native collection stores active exclusions in `learnrecur_exercise_reports`, separately from cached exercise content. Each record uses the note GUID, skill ID, revision, and exercise ID. It saves the reason, exercise text, and timestamp. A refill cannot overwrite a report. A later description revision has its own exercises and report keys.

The same transaction saves a delivery record in `learnrecur_report_outbox`, with a stable report ID and increasing version. Undo withdraws the report and advances its version; redo reactivates it with another version. Withdrawn records stay in the queue so a delayed request cannot reactivate a canceled report.

The report is one native undo operation. Undo restores the original question with its answer hidden; redo restores the exclusion. Undoing a later rating restores the replacement's usage and schedule while keeping the report. Nothing advances the review cursor until the user rates an exercise. Receiving a server receipt preserves native undo and redo. A receipt for an earlier version cannot acknowledge a later local change.

The pinned question is checked again before reporting, revealing, or rating. A changed bank or exclusion blocks stale actions. The native report transaction also checks the exact bank before saving. A process exit before commit leaves no report; an exit after commit preserves both the exclusion and delivery record.

## Companion delivery

The desktop sends pending reports in the background after a report or its undo/redo, and checks again at the deck list or deck overview. Offline reports survive restart. Failed checks retry at those boundaries no more than once a minute; there is no error dialog during review. Each pass handles at most ten states. A successful pass drains the rest in bounded chunks.

Before sending exercise text, the client verifies the companion's source identity. Only cards with trusted native import identities can send reports. A deck package alone does not authorize delivery. Profile or connection changes discard stale callbacks. Requests use the existing bearer token, ignore environment proxies, and refuse redirects.

Authenticated `POST /v1/exercise-reports` accepts these fields:

- `report_id`, `version`, and `active`: the stable client report ID and its current state.
- `source_id`, `skill_id`, `revision`, `guid`, and `exercise_id`: the published exercise and native note identity.
- `reason`, `exercise`, and `created_at_ms`: the saved reason, exact published exercise text, and report timestamp.
- `bank_sequence`: the client's imported batch sequence. This is delivery guidance, separate from the versioned report content.

The server checks the identity and exercise against its published revision. It saves the newest version, accepts identical retries, and ignores older versions. Equal versions with different content fail. The response contains `report_id`, `version`, `active`, `status`, and `job_id`, without exercise text. If an older client backup meets a newer server version, the client advances its local version and resends its current intent.

With generation enabled, an active report on the current revision requests a three-exercise refill through [the existing refill jobs](companion/REFILLS.md). Report retries, other reports at that checkpoint, and low-bank requests share that job. A new job avoids actively reported exercises when choosing its example guidance. Existing jobs retain their frozen guidance. Historical reports are saved without generating for an old revision.

A withdrawal does not cancel work already queued or submitted. Replaying or redoing that report keeps its assigned job rather than creating another. Disabled generation, budget waits, uncertain charges, oversized provider guidance, and capacity limits leave the report saved. A report waiting for a newer published batch can retry after the client imports it. Existing worker budgets and recovery guards apply unchanged.

Completed batches use [automatic delivery](companion/DELIVERY.md) outside review. The question on screen and its paired answer stay fixed while generation and report delivery run.

## Recovery and limits

The client periodically resends acknowledged states at eligible screen boundaries. This lets a surviving client restore reports missing from an older backend backup without creating another checkpoint job. A complete collection backup includes exclusions and the delivery queue. [Backend backups](deploy/AUTOMATIC-BACKUPS.md) include received report states and their job links in the companion database.

Exclusions still belong to each client. Incremental collection sync does not propagate them to another client, and a companion report is not a shared blacklist. Independent clients can report the same exercise without one client's Undo withdrawing the other's report. A full collection download preserves this client's exclusions and delivery queue, discarding those in the downloaded file. An ordinary deck package contains neither. Restoring the backend alone does not restore a lost client's exclusions.

The server retains at most 10,000 report records, including withdrawals. It does not prune them yet. A full report history rejects new reports, while local reporting and cached review remain available. Generation still has the existing job, bank, and snapshot limits. Reports do not guarantee that a model's replacement is correct; exercise quality still needs inspection in a separately authorized trial.

## Checks

```sh
./ninja pylib qt
ANKI_TEST_MODE=1 PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python \
  -m pytest pylib/tests/test_learnrecur_reports.py \
  pylib/tests/test_learnrecur_report_delivery.py learnrecur/companion/tests/test_reports.py -q
ANKI_TEST_MODE=1 PYTHONPATH=.:pylib:qt:out/pylib:out/qt out/pyenv/bin/python \
  -m pytest qt/tests/test_learnrecur_skills.py qt/tests/test_learnrecur_report_delivery.py -q
cargo test -p anki --lib sync::collection::tests -- --test-threads=1
```

Tests cover cached replacements, both schedulers, native undo/redo before and after receipts, exhausted banks, stale actions, revisions, ordinary cards, process exits, retries, authentication, collection backups, full downloads, and encrypted backend restoration. All fixtures are synthetic; no paid calls are needed.
