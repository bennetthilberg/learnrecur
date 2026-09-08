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
| Advanced settings persistence integration | 1 file, 2 tests passed. |
| Focused agent library and MCP wrapper integration | 1 file, 6 tests passed. |
| Focused custom-session integration | 1 file, 6 tests passed initially; final mixed-review cue case passed after the legacy introduced-skill admission fix. |
| Focused material integration | Native ingestion 1 file, 24 tests passed; agent late-ack case 1 selected test passed. |
| Focused progress and Needs Attention integration | 2 files, 5 tests passed (2 progress and 3 Needs Attention). |
| Setup concurrency integration | 1 selected test passed after recognizing the Prisma 7 Neon nested `driverAdapterError.cause.kind` shape. |
| Full unit suite | 106 files, 1,043 tests passed. |
| Combined coverage proof | `npm run test:coverage` runs unit and integration tests with `RUN_DATABASE_TESTS=1`; local unit plus directly affected database files passed 110 files and 1,087 tests against the disposable database with statements 52.52%, branches 46.01%, functions 61.75%, and lines 52.35%. Thresholds are unchanged; the command requires an isolated configured database. |
| Full lint | Passed. |
| Application build | Passed; Next.js typecheck and static generation completed. |
| Worker bundle | `npm run jobs:build` passed and wrote the ignored `.aws-build/jobs.zip`. |
| Runtime audit | `npm run check:runtime-audit` passed: 0 runtime findings and 0 blockers; four accepted dev-only Prisma CLI exceptions. |
| Focused MCP protocol unit tests | 2 files, 23 tests passed. `setup_in_progress` is publicly retryable; `setup_stale` is not. |
| Final custom browser flow | 3 tests passed with Clerk setup/cleanup at 1280px and 390px. Mobile frame measured 14px left, 361px right, with no horizontal document overflow. |
| Full serialized integration suite | Broad baseline: 35 files, 446 tests with 442 passed and 4 agent-practice failures. The final affected rerun passed 3 files and 32 tests after updating tool/settings contracts, bounded Neon conflict retries, and setup snapshot fencing; it covers all four original failure paths plus the new setup regression. The broad suite was not repeated, so this is not a fresh 446-test all-green claim. |
| Anonymous E2E suite | 13 tests passed with 2 workers. |

The standalone `npx tsc --noEmit` command reports an existing test typing
backlog. A disposable archive comparison against `b49f132` found the same 83
diagnostics, 30 unique path/code/severity keys, and unchanged messages, with
zero introduced diagnostics. The application build typecheck passes.

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

1. The focused practice/session surface remains the primary hierarchy; no
   marketing hero or oversized feature section was introduced.
2. Controls use purposeful surfaces and spacing; no nested-card or uniform
   border/shadow treatment was added.
3. Labels and helper text carry meaning; no decorative gradients, section
   numbers, or generic typography were added.
4. Existing Mantine and Phosphor control language remains in use; no emoji or
   replacement icon set was introduced.
5. The mobile custom frame now uses the available width with equal containment
   margins, and the mixed-review setup control changes the title/cue metadata
   path. The rendered custom frame had no horizontal overflow and keyboard
   focus reached the session controls.

## Release boundary

This record proves local source, schema, build, worker-bundle, database, and
browser checks only. It does not prove a deployed revision, external WorkOS
configuration, a production migration, a production queue, provider consent,
or live material ingestion. Apply the additive migration before the dependent
application and worker, update and reconsent WorkOS scopes, run the ordinary CI
and release gates, and verify the deployed revision separately.
