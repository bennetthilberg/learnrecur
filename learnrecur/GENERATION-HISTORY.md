# Generation history

**Tools > Generation history…** shows the companion's saved jobs without revealing exercises. Each row has the requested skill title, action, status, attempt count, estimated spend, and unresolved reservation. Select a row to read its failure or recovery reason.

**Refresh** loads the newest jobs. **Older** and **Newer** replace the current page, with 50 rows at most. Jobs appear in submission order, newest first. The window does not poll automatically, submit jobs, run recovery, or change a collection.

## Costs and recovery

Amounts are in USD after configured credits. Estimated spend uses recorded token usage and the job's saved rates; it is not a confirmed provider invoice. Reservations remain separate because an interrupted request may still incur a charge. The summary shows the UTC month's estimated spend and limit, plus all unresolved reservations, including those from earlier months.

An expired worker claim appears as **Awaiting recovery**. Its reason distinguishes a claim that expired before provider contact, a saved response that can be retrieved, and a call whose result or charge is uncertain. Viewing history leaves the job and reservation untouched. Use the existing [job recovery](companion/GENERATION.md#states-and-recovery) and [OpenAI reconciliation](companion/OPENAI.md) procedures when intervention is needed.

**Completed** means the companion published a bank. The desktop may still need to fetch it. Status is a saved snapshot, not a worker health check. Recovery markers appear as a short pause message.

## Connection and API

The authenticated, read-only endpoint is `GET /v1/generation-history`. Its optional `limit` accepts 1–100 rows. `before` is the positive insertion cursor returned as `next_before`; it excludes that row and newer rows. New submissions do not shift an older page. Use the newest page to see them.

The response contains the companion's `source_id`, bounded `jobs`, `next_before`, `budget`, and a safe `pause` message. Job summaries contain only their internal ID, requested title, action, state, attempts, net spend and reservation amounts in millionths of a dollar, an interruption flag, and a fixed reason. They omit descriptions, examples, exercises, provider response IDs, credentials, and arbitrary stored errors.

The client ignores environment proxies, refuses redirects, and limits the response to 1 MiB. A failed refresh keeps previously loaded rows visible with a warning that they may be out of date. Closing the window discards them; they are not saved in a profile. Closing or switching profiles discards late responses. A changed connection or companion identity cannot mix two sources' history.

Upgrade the companion before using this desktop feature. An older companion returns an update message. This slice does not deploy the new endpoint to Azure or add retry, budget-editing, or exercise-preview controls.

## Checks

The full suites passed 271 companion tests and 290 Qt tests, including 22 new backend cases and 17 new Qt cases. These cover authenticated read-only access, stable paging, historical titles, credits and month rollover, failures, expired claims, privacy, disconnects, profile closure, changed sources, malformed responses, and bounded requests. Titles remain literal text in tooltips, including strings that resemble HTML. The focused Qt suite passed again after the final column-spacing, tooltip, and dialog-cleanup changes. Its cleanup check uses Anki's actual deletion methods, verifies that three open/close cycles leave no hidden child dialogs, and delivers late responses after deletion. Lint passed.

The native Mac check uses a disposable LearnRecur profile and a synthetic companion. Its displayed costs are fabricated fixture values. No provider key or paid worker is loaded, and actual spending is zero. Opening, selecting, and refreshing history left the companion's exact database dump and native notes, cards, and reviews unchanged. Disconnect produced a stale-view warning, and the cached prompt and answer remained available.

The rebuilt package and ad hoc signature passed. Native keyboard selection showed the recovery reason, and the final column headings were visible. Normal offline reveal and rating passed. A restart retained two cards and the exact two review records; reopening history with the companion stopped showed an empty view and a connection message. After the cleanup fix, the final package passed repeated opening and closing with both stores still unchanged. Test processes are stopped. Evidence remains in ignored `out/learnrecur/generation-history-20261006-a5c24c68/`. No personal Anki data or installation was accessed.

During the offline rating check, sending the rating and deck-list shortcuts back-to-back triggered an existing `reviewer.py` callback error: navigation cleared the active card before `after_answer` called `self.card.load()`. The rating committed. This race is separate from history and remains open; the history window was already closed. The first full Qt run also emitted an audio-thread teardown warning after reporting success and exiting with status 0; the final run passed without that warning.
