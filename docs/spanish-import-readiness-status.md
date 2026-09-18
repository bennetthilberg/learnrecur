# Spanish import readiness status

Updated 2026-09-17 after the final reviewer-fix and remote verification pass.
This is a work-in-progress checkpoint, not a release receipt.

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

The current feature branch is `a/spanish-import-readiness`. An existing open
PR, #146, is the single PR target for this work. The implementation checkpoint
`fe7a1da` was followed by review-fix commits `6dd1a10`, `7fe1f63`, `49c99d9`,
`e340a17`, `3cdb901`, `968f782`, `7514e5a`, and `8ed83bf`. The unrelated untracked
`docs/product-discovery/` directory belongs to the user and must remain
untouched.

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

The implementation is ready for review and merge consideration. The database
limitation must remain recorded as an environment limitation rather than a
passing result. The next operator should confirm the migration is applied
before using the new operation-item field, and run the real-material pilot
before making coverage or exercise-quality claims.

Suggested resume commands:

```bash
cd /Users/main/repos/learnrecur
git switch a/spanish-import-readiness
git status --short --branch
sed -n '1,260p' docs/spanish-import-readiness-status.md
rg -n "source_refs|recent_attempts|AGENT_ACCESS_SCOPES|permissionSummary" src tests docs
```
