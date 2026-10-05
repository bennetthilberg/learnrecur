# Export and restore

Use **File > Export > Anki Collection Package (.colpkg)** with **Include media** selected to save a complete LearnRecur collection. The existing export and import dialogs handle this; there is no separate LearnRecur file format.

The package contains ordinary notes, templates, decks, media, schedules, and review history. It also contains skill definitions, previous revisions, cached exercise batches, exercise usage, local exclusions, and the report delivery queue. Both current and legacy collection packages preserve these records in LearnRecur.

A deck package (`.apkg`) is still useful for transferring ordinary decks to Anki. It does not contain the client-local report tables. Choose the full collection format for LearnRecur recovery.

## Restore a collection

1. Open a fresh LearnRecur profile with separate storage.
2. Use **File > Import** and choose the collection package. Import replaces the destination collection; the app first makes its normal backup of that collection.
3. Review cached cards offline. A companion connection is not required to reveal answers, rate, undo, or redo.
4. To resume companion delivery, launch with the configured companion connection and use **Tools > Reconnect restored skills…** from the deck list or deck overview.

File import removes trusted companion identities. A package cannot authorize background generation or report delivery by claiming to own a card. Reconnect fetches an authenticated snapshot and compares each matching restored card's note ID, card ID, GUID, skill content, revisions, and batch history. Older caches can reconnect if their content is an exact published ancestor. Content newer than the companion's snapshot cannot establish ownership.

Reconnect creates no cards and changes no note content, schedules, reviews, usage, or reports. Duplicate links, changed content, remapped IDs, and deleted identities are refused. The native transaction checks the notes again before committing all identities together. Retrying is safe, and review undo and redo remain available. After reconnection, the normal delivery controllers can send queued reports and append completed batches. New descriptions still require the existing revision flow.

Only skills matching the configured companion are connected. A collection with skills from several companions needs a separate reconnect for each source. Connection credentials stay outside the package and must be configured separately.

## What this does not back up

The package contains the client's collection and media. It does not contain companion generation jobs, provider responses, spending records, server credentials, or desktop preferences and add-ons. The [encrypted backend backups](deploy/AUTOMATIC-BACKUPS.md) cover the companion and sync server, including job state and generation accounting. Restoring a client package does not roll back those services or release their generation pauses.

Collection packages contain readable study data and are not encrypted by this export flow. Store personal exports privately.

## Checks

The automated round trip covers a mixed synthetic collection with Basic, typed-answer, Cloze, and HTML/image cards; a revised skill with two appended batches; exercise usage; review history; active exclusions; and a withdrawn report waiting for delivery. Both package formats match the original notes, cards, reviews, templates, media, and report rows. Before reconnect, the restored identity table is empty and reports cannot be sent. Offline rating, reconnect, retry, undo, redo, and reopen preserve the expected state.

Other tests cover older published caches, mismatched content or identity, duplicate links, changed templates, future revisions, deleted identities, a profile or connection change during fetch, native rollback after a queued deletion, and process death before or after reconnect commits.

The packaged Mac app passed native export, Save, import into an empty profile, offline reveal and rating, undo, redo, and restart on October 5, 2026. Five notes, six cards, three initial reviews, two exclusions, three queued report states, and the image hash matched. Reconnect retained the later offline review and delivered all three report states to a separate synthetic companion, including the withdrawal. All delivery receipts persisted.

The app exited during an additional Browse check under automation, as it has in earlier checks. No new crash diagnosis was established. Reopening afterward preserved the exact collection and reconnected state. Browse remains an unverified part of this manual restore check; no accessibility fix is included here. Test observation add-ons and fixtures were confined to disposable LearnRecur storage. No personal Anki data, paid calls, or Azure changes were used.

Run the focused checks from the repository root:

```sh
ANKI_TEST_MODE=1 PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python -m pytest pylib/tests/test_learnrecur_restore.py -q
ANKI_TEST_MODE=1 PYTHONPATH=.:pylib:qt:out/pylib:out/qt:qt/tools out/pyenv/bin/python -m pytest qt/tests/test_learnrecur_import.py -q
```
