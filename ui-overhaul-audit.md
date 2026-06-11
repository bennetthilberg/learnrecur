# UI Overhaul Audit

Working audit for branch `a/ui-overhaul-v0`.

This file tracks the current application against the design concepts from the
Refactoring UI reference and the local LearnRecur design system. It is not a
completion claim; it is a map for continuing the overhaul without relying on
memory.

## Current Direction

- Product personality: focused, precise, calm study tool.
- Primary screen priority: practice loop, source-backed skill creation, recovery
  and data controls.
- Visual language: cool steel neutrals, strong blue only for primary/current/
  ready/selected states, restrained amber/red/green semantic states.
- Surface language: top-level panels may have a light hairline and soft shadow;
  inner details should be flat rows, strips, or disclosures.

## Applied Checks

### Start With The Feature

- Public entry page presents the actual study loop and capabilities rather than
  a generic marketing hero.
- Skill creation prioritizes source upload/paste forms, with manual authoring as
  a disclosure fallback.
- Practice remains the core product surface: one prompt, one answer path, one
  feedback panel.

### Hierarchy

- Ready practice is the dominant dashboard state; supporting metrics are smaller.
- Active skill inventory leads with ready count, not equal stat cards.
- Active skill detail now weights its header practice action by real readiness:
  due skills with selectable exercises get the primary action; inactive inventory
  or future-due skills get a quieter practice link.
- Active skill detail queue headings now name the queue type; readiness lives in
  the numeric state strip instead of being repeated in every heading.
- Entry and history surfaces avoid promising "Start practice" when they do not
  know whether any exercise is actually due.
- Collection practice links now use action language: ready collections say
  "Practice now"; non-ready scoped routes say "Open practice."
- Secondary actions now use neutral treatment by default; blue is reserved for
  primary, current, ready, selected, and hover/focus states.
- Danger sections keep warning tone on headings/actions without turning all help
  copy red.
- Account/auth fact lists use weight and structure instead of blue non-links.

### Layout And Spacing

- Major content uses constrained widths instead of filling the whole viewport.
- Dashboard and skill queue layouts are asymmetric where priority differs.
- Empty states inside panels are ruled blocks, not nested cards.
- Practice empty states name the selected scope problem or missing due exercise
  without falling back to implementation terms.
- Responsive metadata strips remove dividers where wrapping would create leading
  separators.

### Text

- Lexend is used with fixed token sizes and zero letter spacing.
- Labels are generally secondary to values; fact rows use faint labels and
  stronger value text.
- Links that are utilities are muted until hover/focus.
- Recent copy cleanup replaced internal labels such as "Recovery" and "No data"
  with concrete user-facing language.
- Recent practice copy cleanup replaced internal eligibility wording such as
  "practiceable" with learner-facing availability language.
- Settings copy now distinguishes reminder configuration from data export, with
  export facts written as user-facing privacy facts instead of terse system labels.

### Color

- Neutral tokens are steel/cool, not default gray.
- `--lr-faint` now passes contrast on both white panels and the cool page tint.
- Semantic surfaces use matching semantic ink instead of weak gray text.
- Primary blue is not used for ordinary facts or default secondary actions.
- Upload processing statuses avoid ready/primary color until drafts are actually
  available for review.

### Depth

- Panels use one restrained elevation system.
- Ledger rows, source previews, job statuses, privacy notes, and report controls
  stay flat and rule-separated.
- The app avoids decorative gradients, blobs, glows, and fake illustration
  surfaces.

### Images And Uploaded Content

- V0 UI does not display arbitrary uploaded originals; source previews are capped
  text excerpts.
- File upload rows are compact controls, not decorative dashed drop zones.
- Linked source panels describe material plainly instead of calling it internal
  context.

### Finishing Touches

- Focus states use the shared halo.
- Public home and sign-in have been screenshot-checked at desktop and mobile
  widths.
- Current automated checks passing during this branch include lint, build, unit,
  e2e auth-spine, and Prisma schema validation.

## Remaining Audit Targets

- Keep sweeping against the reference categories directly: feature-first
  priority, hierarchy, spacing, text, color, depth, image/upload handling, and
  finishing details.
- Populated protected-page screenshots remain blocked locally by database
  authentication failure in the running app. Source-level checks have continued,
  but final visual completion needs a working signed-in database session.
- Continue auditing dense protected surfaces once reachable:
  - dashboard with real collection/skill rows,
  - `/skills/new` populated upload/paste/manual form states,
  - `/skills` with drafts, active, paused, archived, and processing rows,
  - active skill detail inventory, lifecycle, source, and recent-review panels,
  - `/practice` choice, text, numeric, and math states,
  - `/settings` reminder and export panels,
  - `/history` populated ledger.
- Re-run desktop and mobile screenshots after protected pages are reachable.
