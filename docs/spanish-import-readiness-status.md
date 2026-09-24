# Spanish import readiness status

Updated 2026-09-23 for the worker deadline blocker follow-up. This is a
work-in-progress checkpoint, not a release receipt.

The implementation provides the bounded, auditable plumbing for a future
Spanish textbook pilot: sequential material reading, revision-bound source
references, resumable batch operations, full exercise audit/history reads, and
issue adjudication with cumulative evidence correction. The repository does
not contain a licensed Spanish textbook, so this record does not claim live
book coverage, generated-exercise quality, or a completed representative
material pilot.

The adopted capacity boundary is 250 active or paused skills. Import capacity
is separate from the learner's daily new-skill introduction setting. Import
operations do not set `firstIntroducedAt`, create attempts, advance FSRS, or
consume that learner allowance. Pausing does not free a library slot;
archiving does.

The required live follow-up is a representative real-material pilot using the
ledger in [the textbook import playbook](textbook-import-playbook.md): traverse
at least one chapter, preserve source locators, audit generated answer
contracts, exercise the issue correction flow, and record extraction gaps.

## Development checkpoint

PR #146 merged to `main` at `da807e6`. The implementation checkpoint `fe7a1da`
was followed by review-fix commits `6dd1a10`, `7fe1f63`, `49c99d9`, `e340a17`,
`3cdb901`, `968f782`, `7514e5a`, and `8ed83bf`. The unrelated untracked
`docs/product-discovery/` directory belongs to the user and must remain
untouched.

### Production schema incident

After PR #146 deployed, a newly authenticated production account reached the
dashboard and history routes but both pages failed at their route error
boundary. Vercel runtime logs identified Prisma `P2022` errors for missing
`exercise_attempts.evidenceCorrectionStatus` and
`review_logs.evidenceCorrectionStatus` columns. OAuth account creation itself
succeeded.

The production and staging migration ledgers had stopped at
`20260908120000_advanced_practice_settings_and_sessions`; CI had applied the new
migrations only to its disposable database. On 2026-09-18, production backup
`b004` completed before repair. The following migrations were then applied and
read back successfully in staging and production:

- `20260917170000_quality_incident_replay_corrections`;
- `20260918040000_agent_source_reference_outcomes`.

The repair also confirmed the two correction columns and
`agent_skill_operation_items.sourceReferenceOutcome`. A production log query
afterward found no new matching `P2022` correction-column errors. The permanent
release fix completes the fallible, tier-aware prebuild before
production-target Vercel builds run tracked migrations, invokes Next directly
afterward, uses verified TLS for remote migration connections, and keeps
preview/development builds away from hosted migrations.

Implemented in the current working tree:

- shared import limits and account-locked reservation paths for native and
  connected-agent work;
- bounded per-delivery processing with durable operation-item continuation;
- sequential section/PDF-page material reading with opaque cursors, snapshots,
  extraction-gap reporting, and no study-state mutation;
- revision-bound, ownership-checked source references and canonical PDF/web
  locators;
- answer-bearing exercise audit reads, completed practice history, and
  consented MCP tools for audit, history, issue listing, and issue resolution;
- cumulative confirmed-defect correction, historical annotations, replay-safe
  scheduling, practice-only preservation, idempotency/stale guards, and
  separate replacement-queue outcomes;
- duplicate reuse attaches compatible new source references and reports whether
  evidence was attached, merged, or preserved on the operation item;
- issue-list responses keep submitted answers behind the separate
  `practice:history` consent, with the settings surface naming all three new
  exercise-audit/history/resolution permissions;
- focused Needs Attention and issue-resolution feedback in the learner UI;
- import playbook and a small import ledger template.

Verification evidence for the current local checkpoint:

- `npx tsc --noEmit`, `npm run lint`, and the focused audit tests passed after
  `8ed83bf`;
- the full unit suite passed 142 files and 1,225 tests after `8ed83bf`;
- the latest remote verify job passed lint, unit tests, Prisma validation and
  generation, runtime audit, and the production build;
- `npm run prisma:validate`, `npm run prisma:generate`, `npm run jobs:build`,
  and `npm run check:runtime-audit` passed; the runtime audit reports only
  three already-accepted dev-only Prisma CLI exceptions;
- anonymous Playwright passed all 15 browser checks at desktop and mobile
  widths using an isolated local port; an initial run had reused an unrelated
  Spanish-grammar dev server already occupying port 3000 and is not product
  evidence;
- the focused refill/reservation suite passed 34 tests;
- database integration remains an environment limitation: the configured Neon
  branch is read-only (`25006`) for temporary test writes and the bounded full
  run cannot complete there. The remote isolated database run is authoritative;
- remote CI run `35307403131` passed both the verify job and the authenticated
  integration/coverage and browser job;
- Vercel production deployed successfully at
  `https://vercel.com/learn-recur/learnrecur/2FZvuoq3WmUnTTU3gvcYLmgHy55g`,
  and agent staging deployed successfully at
  `https://vercel.com/learn-recur/learnrecur-agent-staging/4dujVdhJEF1urvGUaWaD4TAcxSjP`;
- the two current Codex review threads were answered and resolved in `8ed83bf`;
  the prior CodeRabbit actionable threads are all resolved or outdated, and
  the current PR has no unresolved non-outdated review thread. CodeRabbit's
  status context remains pending with “Review in progress,” so it is not being
  represented as a clean automated review pass;
- no live WorkOS registration/reconsent, licensed textbook, or representative
  material pilot has been performed for this branch.

The Spanish import implementation is merged. The database limitation must
remain recorded as an environment limitation rather than a passing result. The
next operator should run the real-material pilot before making coverage or
exercise-quality claims.

## Worker deadline blocker follow-up — 2026-09-23

The production handoff at 20:05 UTC reported 38 active skills, 50 pending
operation items, and no activation progress after 19:47 UTC. The handoff's FIFO
head-of-line explanation is an inference from the worker timing and live
symptoms. AWS queue receipts and CloudWatch logs were not available because the
local AWS session had expired, so this branch does not claim a confirmed queue
diagnosis or a production fix.

The fix is under review in PR #154 on `a/activation-worker-deadline` and is not
deployed to production:

- Agent operation deliveries now have an eight-minute soft deadline, below
  Lambda's ten-minute hard timeout, with reserved cleanup time.
- Skill generation, exercise verification, embedding, material drafting, and
  activation publication use bounded stages. Provider calls receive abort
  signals; database publication transactions have explicit wait and execution
  limits.
- Timed-out work releases its claim and persists a bounded transient retry.
  Eligible work can continue in a fresh delivery; maintenance republishes
  queued work with a stable event ID after ambiguous sends.
- Maintenance filters retry eligibility before applying its bounded scan, so
  delayed retry rows and upload-waiting operations cannot hide ready work
  behind the scan limit.
- Continuation publish timeouts and failures now reject the current job
  delivery for retry; ambiguous publication remains safe through stable event
  IDs and item claim fencing.
- Background material planning preserves an idempotent `PLANNING` batch for a
  retryable worker timeout. Synchronous plan and replan actions return a normal
  failed result instead of throwing through the action boundary.
- Scope planning and its optional review now receive the remaining delivery
  deadline and abort provider work before the worker cleanup margin. Material
  summaries have an explicit provider timeout instead of inheriting the shorter
  generic Gemini timeout.
- The FIFO worker intentionally publishes bounded follow-ups to its own queue.
  Its CloudFormation setting explicitly allows this documented pattern; each
  delivery can publish at most 100 child jobs, each envelope carries a validated
  continuation depth capped at 64, and Lambda reserved concurrency matches the
  event-source cap. A breached safety limit is terminal and visible in the
  worker log and FIFO dead-letter queue, which is alarmed in both environments.
- Publication checks preserve verified candidates and use transaction fences
  to avoid duplicate skill activation. The worker does not alter introduction
  timestamps, attempts, or FSRS history.

Local verification for this branch:

- `npm run test:unit`: 147 files and 1,281 tests passed;
- `npx tsc --noEmit`, `npm run lint`, and `npm run prisma:validate` passed;
- `npm run prisma:generate`, `npm run jobs:build`, and `npm run build` passed;
- `npm run test:db` passed all 46 files and 559 tests against a fresh temporary
  local PostgreSQL 18 database with `pgvector`; the tracked migrations applied
  successfully. The configured Neon branch remains read-only (`25006`);
- the integration suite covers a verifier that never resolves, sibling
  progress, activation-publication timeout, preservation of verified
  candidates, stable recovery event IDs, upload-expiry isolation, fairness when
  upload-waiting rows exceed the continuation scan cap, retry after continuation
  publication failure, and synchronous planning timeout results;
- AWS credentials remain expired. Production queue behavior, production
  deployment, duplicate-activation checks under a live mixed batch, and the
  requested production smoke acceptance remain unverified.

### AWS recursive Lambda notification

AWS sent a recursive-invocation termination alert for the jobs worker around
2026-09-24 00:16 UTC. The alert says Lambda stopped the detected invocation
chain. Repository code confirms that worker handlers could publish follow-up
messages directly to their own FIFO-triggered queue, so a sufficiently long
valid fan-out could reach AWS's recursion threshold. The email alone does not
identify which job started that chain, and expired AWS credentials prevented
confirmation against the corresponding CloudWatch event or SQS receipts.

PR #154 explicitly allows the intentional SQS/Lambda chain and adds the
bounded follow-up, continuation-depth, and reserved-concurrency guardrails
described above. This is a code/template fix only; it is not deployed. Live
queue cleanup and the mixed-batch acceptance check remain pending an
authenticated AWS session.

After PR CI and review, the operator should deploy through the normal release
path, run the small mixed batch from the handoff, and verify sibling progress,
terminal or bounded-retry outcomes, no duplicate activations, verified exercise
inventory, and unchanged introduction/FSRS history before resuming imports.

Suggested resume commands:

```bash
cd /Users/main/repos/learnrecur
git switch main
git pull --ff-only
git status --short --branch
sed -n '1,260p' docs/spanish-import-readiness-status.md
rg -n "source_refs|recent_attempts|AGENT_ACCESS_SCOPES|permissionSummary" src tests docs
```
