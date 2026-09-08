# Practice and connected-agent release record

Updated 2026-09-08 for branch `a/practice-and-agent-setup`, based on
`b49f132` (`feat(practice): add a daily new-skill limit (#131)`). This record
describes the integrated behavior, local proof, and release boundary for custom
practice sessions, Needs Attention, advanced practice settings, and the
connected-agent surface.

## Product contract

Custom sessions are bounded, owned practice plans. `PRACTICE_ONLY` may include
not-yet-due compatible exercises and records an exposure without changing FSRS.
`SCHEDULED` admits due compatible work and records the normal review outcome.
Scheduled plans include at most one exercise per due skill; replenishment can
replace a skipped, unreviewed item while a reviewed skill stays out of the
same session.
Both modes carry account, collection, tag, skill, recently-missed, and mixed-
review scope through planning, presentation, answer submission, continuation,
and history. Repeated submissions use deterministic item and attempt keys.
Mixed review can be selected during custom-session setup. In mixed mode, the
skill title stays hidden until feedback and the session records whether reduced
rule cues were actually used; title withholding does not depend on how many
skills are available. The session does not add timeboxing or a today-bonus
system.

Needs Attention is a deterministic, ownership-scoped, bounded read model. It
surfaces preparation, generation, review, and repair states with actionable
links. `/practice/attention` has loading, empty, populated, failure, and retry
states; reading it does not reserve skills or change a review schedule.

Advanced practice settings preserve review history and schedules while adding
account desired retention, local day-start minutes, and an IANA practice
timezone. The existing account practice preference and mixed-review default
remain available alongside these controls. Practice preference inheritance
resolves skill override, collection override, user preference, then Balanced.
Desired retention is account-only and nullable; a cleared value uses the 90%
product default. Already-studied remains an existing per-skill control, not an
account setting. The default practice day starts at 00:00 in UTC. Day
boundaries use calendar semantics and DST-aware timezone conversion. Reminder
local time remains a separate setting.

The connected-agent API exposes the bounded tools that exist in this release:

- settings, practice targets, and custom-session create/get/stop/resume;
- owned skill search/get/update/lifecycle and bounded batch organization;
- owned collection create/update/lifecycle;
- reminder read/update;
- progress summary and Needs Attention;
- readiness repair;
- reviewable setup preview/get/apply with bounded planned changes and durable
  partial-result recovery;
- reusable skill creation from specs, text, materials, and prepared files;
- material list, outline, excerpt search, upload, URL import, status, retry,
  and operation polling.

Every read and mutation rechecks the active connection, expiry, consented
scope, account state, ownership, and rate limit. Batch changes are bounded and
per-item; collection or text-policy changes retire incompatible future
inventory and reprepare it through the existing bounded pipeline. Attempts,
review logs, and source provenance remain immutable. Public errors do not
expose provider messages, private material, storage keys, or database details.

Deferred exercise-refill events persist their provider payload and bounded
delivery state on the `GenerationJob` row before the transaction commits. The
`agent-access.maintenance` job scans at most 25 stale deliveries every five
minutes, fences claims by account, deletion tombstone, and delivery lease, and
marks exhausted delivery attempts as an actionable repair failure. A process
crash after provider acceptance can cause a duplicate delivery; the refill
worker must remain idempotent by generation-job ID. The deployed maintenance
job and refill worker must ship with the application revision for this
recovery path to remain live.

## Defaults, scopes, and rollout

The schema migration
`20260908120000_advanced_practice_settings_and_sessions` is additive and must
be applied with `prisma migrate deploy` before starting an application or worker
revision that reads its fields. The migration adds the practice settings,
`PracticeSession`, and `AgentSetupPlan` records with ownership constraints and
cascades. This release has no destructive down migration. A code rollback is
safe only when the previous code does not read the new records; once a schema
field is required by deployed code, use a forward corrective migration for a
schema repair.

The connected-agent scope catalog is the current `AGENT_ACCESS_SCOPES` list:
`skills:create`, `skills:read`, `skills:write`, `collections:read`,
`collections:write`, `materials:read`, `sources:upload`, `practice:read`,
`practice:write`, `reminders:read`, `reminders:write`, `progress:read`,
`setup:read`, and `setup:write`. Before an external rollout, update the WorkOS
Connect application's allowed scopes and its dynamic-client-registration
default-scope catalog to match this list, then reconsent existing grants.
Metadata alone does not grant new scopes. Verify a new grant and an existing
grant after reconsent in a non-production environment. See [Connect
applications](https://workos.com/docs/reference/workos-connect/applications),
[Connect authorization](https://workos.com/docs/reference/workos-connect/authorize),
and [MCP authentication rollout guidance](https://workos.com/blog/how-to-add-authentication-to-your-mcp-server).

The integration environment used one ignored `.env.local` backed by a
disposable database, with `JOBS_ENVIRONMENT=local`. It did not target a
production database, bucket, queue, provider, or invitation flow. Fixtures
created and removed only their own rows. The generated Prisma client is tracked
with the schema change; test and browser artifacts and worker archives remain
ignored.

## Verification record

The following checks have been run on the integrated worktree. Database suites
use one worker and one database lease.

| Check | Result |
| --- | --- |
| `npm ci --ignore-scripts` | Passed once; no second install was needed. |
| `npm run prisma:validate` | Passed. |
| `npm run prisma:generate` | Passed after schema stabilization. |
| `npm run prisma:deploy` | Passed against the disposable database; all 34 migrations applied. |
| Schema readiness and export integration | 2 files, 6 tests passed. |
| Canonical readiness SQL parity | `readiness-sql.test.ts`: 16/16 passed, including malformed numeric, fraction, math, policy, retired, and unverified inventory. |
| Advanced settings persistence integration | 1 file, 2 tests passed. |
| Focused agent library and MCP wrapper integration | `agent-library-management.test.ts`: 12/12 passed, including per-skill timestamps, readiness parity, malformed specs, tag overflow, and revoked access. |
| Focused custom-session integration | `custom-practice-session.test.ts`: 14/14 passed, including scheduled one-per-skill planning, mixed-review cue metadata, undersized-plan replenishment, and explicit owned-scope validation. |
| Focused material integration | `agent-material-ingestion.test.ts`: 10/10 passed, including concurrent completion, revocation/deletion during URL replay, operation reconciliation, and late acknowledgement. Native ingestion evidence: 24 tests passed. |
| Focused progress and Needs Attention integration | `agent-progress.test.ts`: 7/7 passed, including authorization races, guidance merging, skill ownership, SQL readiness, and lost post-commit event acknowledgement; Needs Attention: 3/3 passed. |
| Focused practice refill integration | `refill-delivery-recovery.test.ts`: 6/6 passed, including crash recovery, single-claim leases, stale publishers, delivery exhaustion, and deletion tombstones. |
| Focused durable setup integration | `agent-setup.test.ts`: 10/10 passed, including last-seen snapshot stability, stale setting edits, journal recovery, and concurrent apply fencing. |
| Setup conflict classification | Nested Prisma 7 Neon `driverAdapterError.cause.code` and `cause.kind` cases are covered by the focused unit suite. |
| Full unit suite | 109 files, 1,068 tests passed. |
| Combined coverage proof | `npm run test:coverage` runs unit and integration tests with `RUN_DATABASE_TESTS=1`; the local proof passed 110 files and 1,087 tests against the disposable database with statements 52.52%, branches 46.01%, functions 61.75%, and lines 52.35%. This proof predates the final narrow regression files; thresholds and source coverage scope are unchanged, and the exact final-head run is enforced by CI. |
| Full lint | Passed. |
| Application build | Passed; Next.js typecheck and static generation completed. |
| Worker bundle | `npm run jobs:build` passed and wrote the ignored `.aws-build/jobs.zip`. |
| Runtime audit | `npm run check:runtime-audit` passed: 0 runtime findings and 0 blockers; four accepted dev-only Prisma CLI exceptions. |
| Focused MCP protocol unit tests | 4 files, 22 tests passed. `setup_in_progress` is publicly retryable; `setup_stale` is not, and lifecycle mutations carry destructive hints. |
| Exact-head GitHub CI | Run [34274320695](https://github.com/bennetthilberg/learnrecur/actions/runs/34274320695) passed at `419615657f10b6404298794afbc681e47ff25e53`: verify passed runtime audit, lint, unit, Prisma validation/client generation, and build; the combined gate passed 146 files and 1,560 tests with 80.42% statements, 71.36% branches, 88.03% functions, and 80.88% lines; authenticated Chromium passed 26 tests. |
| Authenticated browser flows | 7 product tests passed across desktop and mobile settings, daily-limit gating, advanced retention/day-start persistence, custom setup/completion, mixed-review cues, and Needs Attention states. The externally seeded fractional-retention case passed in a focused 1/1 rerun after a test locator correction. Clerk setup and cleanup passed for both runs. Custom mobile frame measured 14px left, 361px right, with no horizontal document overflow. |
| Malformed Needs Attention cursor browser check | `needs-attention.spec.ts`: 5/5 passed with Clerk setup/cleanup, including desktop, mobile, and first-page recovery for a malformed cursor. |
| Full serialized integration suite | Broad baseline: 35 files, 446 tests with 442 passed and 4 agent-practice failures. The final affected rerun passed 3 files and 32 tests after updating tool/settings contracts, bounded Neon conflict retries, and setup snapshot fencing; it covers all four original failure paths plus the new setup regression. The broad suite was not repeated, so this is not a fresh 446-test all-green claim. |
| Anonymous E2E suite | 13 tests passed with 2 workers. |

The canonical `npm run test:coverage` command is also the enforced database-job
coverage gate. CI prepares an isolated database, applies migrations, and runs
the unit and integration suites together so the threshold measures the real
database paths. Same-repository pull requests and main receive this full gate;
fork pull requests retain fast checks because trusted database credentials are
not available there. No threshold or coverage exclusion changed. The exact
final-head run above passed; it proves CI for this revision and does not prove
deployment.

The standalone `npx tsc --noEmit` command reports an existing test typing
backlog. A disposable archive comparison against `b49f132` found the same 83
diagnostics, 30 unique path/code/severity keys, and unchanged messages, with
zero introduced diagnostics. The application build typecheck passes.

The two manual Codex review requests are exhausted. The final request reviewed
`8add41e` and identified scheduled per-skill planning, lifecycle MCP
destructive annotations, and the missing progress day-start field; follow-up
test commit `4196156` and the current review-fix changes address those
findings and were validated by focused tests and exact-head CI. No third manual
review was requested. CodeRabbit suggestions were triaged separately: the fork
coverage trust boundary and bounded DST boundary search remain intentional, while
broad renames, formatting churn, and speculative optimizations were deferred.
This record does not claim every automated review comment is resolved.

## Browser review and self-critique

Authenticated Chromium checks covered desktop and mobile settings, retention
and local-day-start controls, custom-session setup and completion, mixed-review
cue behavior, Needs Attention empty/findings states, loading-disabled controls,
save failure and saving states, and keyboard Space/Enter actions. Retained
artifacts are in the ignored `test-results/final-ui-retention/`,
`test-results/final-ui-practice-agent/`, and `test-results/final-ui-custom/`
directories.

Five generic/default pitfalls were checked and corrected where evidence
required it:

1. Repeated eyebrow labels would have added noise above an already clear
   heading, so the redundant Practice label on setup and Custom session label
   in the active card were removed.
2. Technical timezone wording would have made the setting harder to scan, so
   the helper now says it uses local time and includes daylight-saving changes.
3. A narrow mobile card would have cramped the action edge, so the custom
   frame was widened to equal 14px containment margins and verified without
   horizontal overflow.
4. Advanced controls shown in the main settings flow would have made the
   common controls noisy, so retention and day-start inputs remain inside the
   Advanced practice settings disclosure.
5. Showing a skill title before feedback in mixed practice would reveal the
   cue the mode is designed to withhold, so the active heading stays neutral as
   Review until feedback and then shows the title; the setup choice records
   actual reduced-cue use.

## Release boundary

This record proves local source, schema, build, worker-bundle, database, and
browser checks only. It does not prove a deployed revision, external WorkOS
configuration, a production migration, a production queue, provider consent,
or live material ingestion. Apply the additive migration before the dependent
application and worker, deploy the five-minute maintenance job with the refill
worker, update and reconsent WorkOS scopes, run the ordinary CI and release
gates, and verify the deployed revision separately.
