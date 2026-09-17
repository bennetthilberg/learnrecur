# Spanish import readiness status

Updated 2026-09-17. This is a work-in-progress checkpoint, not a release receipt.

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
PR, #146, is the single PR target for this work. Local checkpoint commit
`8dea53b` preserves the implementation slices before development pauses. It
has not been pushed; the remote PR currently ends at `04632b4`. The unrelated
untracked `docs/product-discovery/` directory belongs to the user and must
remain untouched.

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
- focused Needs Attention and issue-resolution feedback in the learner UI;
- import playbook and a small import ledger template.

Verification evidence available before this pause:

- `npx tsc --noEmit` passed after the MCP/domain integration and replacement
  outcome changes;
- the latest delegated full unit checkpoint reported 141 files and 1,213 tests
  passed;
- lint passed before the final material-reader boundary test was added;
- the focused refill/reservation suite passed 34 tests;
- database integration was attempted by the delegated quality slice and was
  blocked by the configured read-only Neon PostgreSQL connection (`25006`) on
  temporary INSERT/DELETE cleanup;
- no live WorkOS registration/reconsent, deployment, licensed textbook, or
  representative material pilot has been performed for this branch.

The current head is not yet merge-ready. Resume by first inspecting the
checkpoint diff and then completing these items:

1. Make duplicate skill reuse attach compatible new source references and
   report whether they were attached, merged, or preserved; expose that result
   on operation items.
2. Ensure issue-list responses never expose submitted answers without the
   separately consented `practice:history` scope; update the settings copy for
   the three new consent scopes.
3. Finish the current documentation follow-up in `project_description.md`,
   `roadmap.md`, and this release record without rewriting historical live
   claims.
4. Run the focused tests, then the full lint, unit, Prisma, build, database,
   browser, worker, and runtime-audit checks. Treat the read-only database
   limitation as an explicit environment limitation rather than a passing
   result.
5. Inspect `git diff --check`, preserve `docs/product-discovery/`, push the
   branch, update PR #146, and only then close the goal as complete.

Suggested resume commands:

```bash
cd /Users/main/repos/learnrecur
git switch a/spanish-import-readiness
git status --short --branch
sed -n '1,260p' docs/spanish-import-readiness-status.md
rg -n "source_refs|recent_attempts|AGENT_ACCESS_SCOPES|permissionSummary" src tests docs
```
