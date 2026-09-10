# Practice and connected-agent release record

Updated 2026-09-09 after PR 132 merged to `main` as
`eecd414ec36b9262ce42b9204e20fdcb8c295f3c`. The merged tree is identical to
reviewed application source `84b69b7261114488c4d04df8f419343e038c2392`.
The application is live at `alpha.learnrecur.com`; the compatible worker
artifact remains from `b6ffde2`. This record captures the shipped behavior,
live evidence, rollout order, and the staging-fixture cleanup receipt.

## Product contract

Custom sessions are bounded, owned practice plans. `PRACTICE_ONLY` may include
not-yet-due compatible exercises and records an exposure without changing FSRS.
`SCHEDULED` admits due compatible work and records the normal review outcome.
Scheduled plans include at most one exercise per due skill. Replenishment can
replace a skipped, unreviewed item while a reviewed skill stays out of the same
session. Both modes carry account, collection, tag, skill, recently-missed,
and mixed-review scope through planning, presentation, answer submission,
continuation, and history. Repeated submissions use deterministic item and
attempt keys. The session does not add timeboxing or a today-bonus system.

Mixed review is selected during custom-session setup. In mixed mode, the skill
title stays hidden until feedback and the session records whether reduced rule
cues were actually used. Needs Attention is a deterministic, ownership-scoped,
bounded read model with loading, empty, populated, failure, and retry states;
reading it does not reserve skills or change a review schedule.

The practice read path treats an exercise whose included skill relation has
disappeared during loading as unavailable and continues with other owned
candidates. Present skills with incomplete FSRS fields still fail the existing
invariant check. Advanced practice settings preserve review history and
schedules while adding account desired retention, local day-start minutes, and
an IANA practice timezone. The existing account practice preference and
mixed-review default remain available. Desired retention is account-only and
nullable; a cleared value uses the 90% product default. The default practice
day starts at 00:00 in UTC, with calendar and DST-aware boundaries.

The connected-agent API exposes the bounded tools shipped in this release:

- settings, practice targets, and custom-session create/get/stop/resume;
- owned skill search/get/update/lifecycle and bounded batch organization;
- owned collection create/update/lifecycle;
- reminder read/update;
- progress summary, Needs Attention, and readiness repair;
- reviewable setup preview/get/apply with bounded planned changes and durable
  partial-result recovery;
- reusable skill creation from specs, text, materials, and prepared files;
- material list, outline, excerpt search, upload, URL import, status, retry,
  and operation polling.

Every read and mutation rechecks the active connection, expiry, consented
scope, account state, ownership, and rate limit. Batch changes are bounded and
per-item. Collection or text-policy changes retire incompatible future
inventory and reprepare it through the existing bounded pipeline. Attempts,
review logs, and source provenance remain immutable. Public errors do not
expose provider messages, private material, storage keys, or database details.

Deferred exercise-refill events persist their provider payload and bounded
delivery state on the `GenerationJob` row before the transaction commits. The
`agent-access.maintenance` job scans at most 25 stale deliveries every five
minutes, fences claims by account, deletion tombstone, and delivery lease, and
marks exhausted delivery attempts as an actionable repair failure. A process
crash after provider acceptance can cause a duplicate delivery; the refill
worker remains idempotent by generation-job ID. The deployed maintenance job
and refill worker must remain compatible with the application revision.

## Defaults, scopes, and rollout

The additive migrations are applied in order with `prisma migrate deploy`
before application or worker code that reads their fields:

1. `20260906173000_retention_preferences` on staging;
2. `20260907220000_daily_new_skill_limit` on staging and production;
3. `20260908120000_advanced_practice_settings_and_sessions` on staging and
   production.

The migration adds practice settings, `PracticeSession`, and `AgentSetupPlan`
records with ownership constraints and cascades. It has no destructive down
migration. A code rollback is safe only while the previous code does not read
the new records; after dependent code is deployed, use a forward corrective
migration for schema repair.

The connected-agent scope catalog is the current 14-entry `AGENT_ACCESS_SCOPES`
list: `skills:create`, `skills:read`, `skills:write`, `collections:read`,
`collections:write`, `materials:read`, `sources:upload`, `practice:read`,
`practice:write`, `reminders:read`, `reminders:write`, `progress:read`,
`setup:read`, and `setup:write`. WorkOS Connect application permissions and
CIMD default-scope configuration match this catalog; DCR remains disabled.
Existing grants require reconsent because metadata alone does not add scopes.
The authorization setup uses the stable `alpha.learnrecur.com/mcp` resource and
matching issuer. See [Connect applications](https://workos.com/docs/reference/workos-connect/applications),
[Connect authorization](https://workos.com/docs/reference/workos-connect/authorize),
and [MCP authentication rollout guidance](https://workos.com/blog/how-to-add-authentication-to-your-mcp-server).

The reconsent path validates the provider grant before updating the locked
existing connection. A newly reconsented token can expand the stored scope
union, while an older token remains limited to its signed scopes. Concurrent
reconsents union both expansions; invalid, revoked, or expired inputs leave
the stored connection unchanged.

## Live targets and evidence

Staging is the `learnrecur-agent-staging` Vercel project at
`project-0oqzu.vercel.app`, backed by Neon project `steep-flower-25531082`,
branch `br-raspy-bread-awp3p9b`, database `neondb`. Production is the
`learnrecur` Vercel project at `alpha.learnrecur.com`, backed by Neon project
`green-thunder-73986028`, branch `br-floral-wildflower-apfy29bb`, database
`neondb`.

The production alias currently serves Vercel deployment
`dpl_72bDFYHa9K83UdMskQvyZYCNkzVd` at
`learnrecur-6eropbk4o-learn-recur.vercel.app`. It is `READY`, targets the
production environment, and reports source commit
eecd414ec36b9262ce42b9204e20fdcb8c295f3c. The post-merge deployment tree was
compared with the validated `84b` tree before recording this receipt. The
candidate deployment `dpl_CrcBHVi8kRacZUdDL19PbGGEV7ve` was equivalent but was
superseded by the automatic main deployment after merge. The served alias
returns `{"status":"ok"}` from `/api/health`; its protected-resource
metadata names the alpha resource, the configured issuer, and all 14 scopes.
Strict readiness for the served deployment passed in
[workflow run 34393427565](https://github.com/bennetthilberg/learnrecur/actions/runs/34393427565).

The final source CI proof is
[workflow run 34390936824](https://github.com/bennetthilberg/learnrecur/actions/runs/34390936824):

- verify passed 110 unit files and 1,070 unit tests;
- the isolated database coverage gate passed 148 files and 1,584 combined
  unit and integration tests;
- coverage was 80.95% statements, 71.93% branches, 88.30% functions, and
  81.44% lines;
- authenticated Playwright passed all 26 desktop/mobile browser checks;
- the isolated end-to-end database cleanup passed.

The current production and staging workers use the compatible `b6ffde2`
artifact. The production and staging worker receipts report active and
successful Lambda state, empty queues after smoke, healthy alarms, and the
expected schedule state. A local bundle comparison found the worker route
sources unchanged; the reconciliation functions are tree-shaken from the
worker bundle and only module initialization/order differs, so no worker
redeploy was required. This is distinct worker provenance, not a claim that
the web and worker archives are byte-identical.

The staging MCP r2 smoke passed 27 checks with 2 explicit read-only skips and
0 failures. The final staging reconsent proof recorded 18 checks: 13 passed,
5 explicit read-only skips, and 0 failures. It verified the same connection
expanding from 3 to 14 scopes while permission version 1, connection binding,
active status, and remote revocation state remained unchanged. Its redacted
receipt is `staging-mcp-auth-r3-cas-receipt.json`.

The native production MCP proof used the normal bundled CLI CIMD flow. The
official app server connected through OAuth, advertised 46 tools, and returned
settings containing all six required fields: practice preference, mixed-review
default, daily new-skill limit, practice timezone, desired retention, and
practice day-start minutes. The domain tool was read-only: it did not change
practice preferences or history and exported no tokens. The authorized
reconsent persisted the connection scope expansion from 3 to 14 and updated
`lastUsedAt`; the redacted stored-connection readback verified the same active
connection, identity, permission version 1, and exact 14-scope set. Reports are
`test-results/mcp-rollout/native-production-readonly-report.json` and
`release-private/production-native-reconsent-connection-readback-20260909T191355Z.json`.

The staging allowlist replacement was intentional because the previous
sensitive value was unrecoverable from the provider interface. The explicit
replacement baseline is `*@bennetthilberg.com`,
`bennett.hilberg@gmail.com`, and `test+clerk_test@example.com`; the fresh
disposable fixture entry was added temporarily for the smoke run and removed
from both staging Production and Preview after cleanup. Production's invite
allowlist was unchanged. The post-cleanup parser check reported an allowlist
of three entries with the fixture absent. The final staging deployment is
`dpl_AhKkLGVsQxQhFHk7VM6x7sEtH26B`, a production-target `READY` deployment
from merged source `eecd414ec36b9262ce42b9204e20fdcb8c295f3c`, assigned to
`project-0oqzu.vercel.app`; its health endpoint returned `{"status":"ok"}`.
The account-deletion receipt records the fresh fixture's owner rows, object,
connection, zero remaining authorized applications, and Clerk identity cleanup.
The deployed account-deletion job revoked the connection but left the WorkOS
User Management mirror. A separate test-only cleanup removed only the fresh
disposable WorkOS user after its external ID matched the fresh Clerk subject;
the protected old provider and local identity were preserved. That manual
cleanup is recorded in `staging-mcp-fresh-workos-deletion-receipt.json`.

## Browser review and self-critique

Authenticated Chromium checks covered desktop and mobile settings, retention
and local-day-start controls, custom-session setup and completion, mixed-review
cue behavior, Needs Attention states, loading-disabled controls, save failure
and saving states, and keyboard Space/Enter actions. Five generic/default
pitfalls were checked and corrected:

1. Redundant Practice and Custom session eyebrows were removed above headings
   that already identified their scope.
2. The timezone helper uses plain local-time and daylight-saving wording.
3. Mobile session and header frames use equal 14px containment with no
   horizontal overflow at 375px and 390px.
4. Advanced controls remain inside a disclosure so common settings stay
   scannable.
5. Mixed practice keeps a neutral Review heading until feedback and records
   actual reduced-cue use.

## Review and release boundary

PR 132 was merged as `eecd414ec36b9262ce42b9204e20fdcb8c295f3c`. The final
review disposition receipt records 66 threads: 33 fixed and 33 nonblocking or
deferred with evidence. The two manual review requests were exhausted; this
record does not claim a clean review of a later exact head.

Application migration, production deployment, worker preservation, WorkOS
catalog configuration, native production reconsent, staging scope expansion,
strict readiness, full CI, deployed MCP settings proof, and staging fixture
cleanup are complete. No synthetic production fixture was created. The native
read-only settings proof did not change production practice preferences or
history; mutation fixtures ran only in staging. The application alias,
production worker, migration state, WorkOS catalog, and explicit staging
allowlist baseline are now recorded with their live evidence.

GitHub still reports [GHSA-3f6p-5ww8-9rcr](https://github.com/advisories/GHSA-3f6p-5ww8-9rcr)
for `mysql2` 3.15.3 through Prisma's development tooling. The release runtime
audit passed, and the deployed database paths use Postgres. Updating that
dependency remains a maintenance follow-up; this receipt does not claim that
every development dependency is free of advisories.
