# Textbook import playbook

This playbook defines the operator and agent workflow for turning a saved
textbook material into trustworthy LearnRecur skills. Importing a book builds
library content; it does not introduce skills into a learner's daily queue,
create attempts, or advance FSRS schedules.

## Before importing

1. Confirm that the material has a `READY` revision and record its exact
   `material_id` and `revision_id`.
2. Use `materials.get_outline` to choose a bounded section or page scope.
3. Use `materials.read_content` to traverse the selected scope in order. Keep
   the returned section paths, segment IDs, and locators with the working
   ledger. Do not infer that a scope is complete when the reader reports OCR,
   missing, or failed extraction.
4. Form skill candidates from the material's meaning and examples. Prefer one
   teachable decision or communicative capability per skill. Record exclusions
   when a section is too broad, repetitive, or not suitable for practice.
5. Check the import limits before submitting a batch: at most 25 created
   skills per request, 50 pending MCP items including reservations, and 250
   active or paused skills in the library. The learner's daily new-skill
   allowance is a separate practice setting and must not be consumed by
   import.

## Creating and verifying

Use `skills.add_from_specs` for reviewed skill specifications. Supply
`source_refs` for every material-derived skill. A source reference must name
the expected revision and at least one section or evidence chunk; the server
validates ownership and stores a sanitized locator before generation begins.

Use candidate exercises sparingly. The verifier must reject ambiguous,
off-objective, or answer-key-inconsistent candidates. A generated exercise is
not ready for practice until its answer contract has been verified. Ordinary
previews remain answer-key-free; use the separately permissioned audit tools
for full contracts.

For a larger chapter, submit a sequence of bounded batches. Keep each batch
idempotent and record its operation ID. A worker delivery may process only a
small slice and enqueue a durable continuation; an operation is complete only
when every item is terminal. Retry failed items by their durable item IDs and
never recreate successful siblings.

## Review and correction

After the operation settles:

- inspect the operation and the readiness state;
- audit a representative sample of active exercises;
- verify that every imported skill has its expected source reference;
- run practice-only smoke checks without changing the learner's schedule;
- record extraction gaps, rejected candidates, duplicate reuses, and failed
  replacements in the ledger.

If a learner reports a defective exercise, use `exercises.list_issues` and
`exercises.resolve_issue`. A confirmed defect retires the exercise and
removes the union of all confirmed defective evidence from future scheduling,
then replays valid reviews using their original timestamps and ratings. The
attempts and review logs remain available in history with the correction
status. Rejected or inconclusive reports remain retired but do not rewrite
valid evidence.

## Completion gate

An import is ready to hand off only when the ledger records the material
revision, traversal scope, source references, operation IDs, terminal item
counts, exercise-audit sample, extraction gaps, correction state, and the
verification commands that passed. A live textbook pilot is a separate gate;
fixtures and unit tests do not prove coverage or generated-exercise quality
for a real book.
