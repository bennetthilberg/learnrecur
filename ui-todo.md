# UI To-Do — LearnRecur (OpenWater UI overhaul)

A rigorous UI audit of the current app. This is a **findings list only — no code was
changed.** Each item is something to fix or decide on, with concrete file references.

## How this was assessed

- **Authoritative spec:** `LearnRecur-OpenWaterIII-design-spec.md` (the "Open Water III"
  system). `design-system.md` is explicitly marked outdated; `ui-overhaul-audit.md`
  describes the older "steel v0" system on a different branch.
- **Principles:** Refactoring UI (hierarchy first; emphasize by de-emphasizing; limit
  choices; don't fabricate data; labels are a last resort; relate labels to their values;
  consistent spacing/type scale; restrained borders/elevation) plus general product-UI
  judgement and the repo's own `CLAUDE.md` "anti-slop" rules.
- **Verified live:** dev server on `localhost:3000`; screenshotted `/` and `/sign-in` at
  1280px and 390px; inspected computed styles. Protected pages (dashboard, practice,
  skills, skill detail, collections, settings, history) were audited from source because
  they require auth + a working DB.

Severity: **P1** = breaks the design intent / misleads users · **P2** = clear quality
problem · **P3** = polish/nit.

---

## 0. Things that are already correct (do NOT "fix" these)

- **Fonts load correctly.** I suspected the literal `'Instrument Sans'` / `'Plus Jakarta
  Sans'` family names in CSS would not match next/font's generated names, but
  `document.fonts.check()` returns `true` for both and they render. Display = Plus Jakarta,
  body = Instrument, as intended. Leave it.
- `color-scheme: light` is set; no `backdrop-filter`, blur, or soft-glow shadows; the only
  shadows are the hard zero-blur button shelves. Matches the spec.
- Yellow `#FFD43B` is used with discipline (active-nav underline, "Today" forecast
  underline, review-answer underline only).
- Practice, Skills, Collections, Settings, and History are clean, flat, scannable, and
  largely accessible (see §7 for what's strong).
- Tabular numerals are applied broadly.

---

## 1. Architecture / cross-cutting (highest leverage)

- **[P1] Two full design systems are layered and fight each other.**
  `globals.css` (~5,700 lines) still encodes the older flat "steel v0" system (flat
  panels, `--lr-shadow: none`, a fixed vertical sidebar `.practiceTopbar`, responsive
  26–42px headings at weight 500, flat outline `.primaryButton`/`.secondaryButton`).
  `open-water.css` (~2,000 lines, imported *after* in `layout.tsx`) retrofits the Open
  Water III spec on top — frequently via `!important` and **duplicate selectors** for the
  same classes (`.primaryButton`, `.secondaryButton`, `.practiceTopbar`, `.entryShell`,
  panel borders, headings). The result only renders correctly because of import order +
  `!important`. This is the single biggest maintainability/consistency risk: any edit to
  globals can be silently overridden, and vice versa. → Collapse to **one** source of
  truth (fold Open Water values into globals, or replace globals), remove `!important`,
  delete the duplicated rules.

- **[P2] Stale, contradictory design docs in the repo.** `design-system.md` (Lexend, blue
  `#034cd5`, steel neutrals — marked "outdated" but still tracked and *modified in the
  working tree*) and `ui-overhaul-audit.md` (references branch `a/ui-overhaul-v0` and the
  old Lexend/steel system) describe two visual languages different from the authoritative
  `LearnRecur-OpenWaterIII-design-spec.md`. Three conflicting docs will mislead future
  work. → Retire/relocate the old ones; point everything at the Open Water spec.

- **[P1] The dashboard speaks a different visual language from the rest of the app.**
  The dashboard is a near-literal copy of the Open Water *demo* (blue hero, 3 stat tiles,
  "Up next" review card, "Decks" list, activity heatmap, weekly-goal ring, 7-day forecast,
  session-preference toggles). Every other authenticated page uses the austere flat
  "steel" language (ruled fact rows, disclosures, no decorative widgets). They share tokens
  but feel like two products. Landing on a colorful Anki-style deck dashboard and then
  hitting minimal ruled lists is jarring and contradicts the product priorities ("compact,
  scannable app surfaces", "the practice screen is the core experience", "avoid dense
  Anki-like management screens"). → Pick one language. Given the product priorities, the
  right move is almost certainly to **strip the dashboard's demo dressing** down to real,
  useful surfaces.

- **[P3] Legacy sidebar plumbing left in tokens.** `--lr-sidebar-width: 0px` and
  `--lr-page-gutter: 0px` (`globals.css:101–102`) plus `.dashboardShell/.practiceShell/
  .skillShell { padding-left: calc(var(--lr-sidebar-width) + …) }` (`globals.css:690–703`)
  are dead remnants of the old fixed-sidebar layout. Confusing dead code.

- **[P3] Hardcoded hexes scattered in TSX while `design-tokens.ts` is a 1-field stub.**
  `src/lib/design-tokens.ts` only exports `colorPrimary`, yet raw hexes appear in
  `dashboard/page.tsx` SVGs (`#1C44A8`, `#ECF0FA`, `#15233F`, `#6E7689`) and
  `clerk-appearance.ts` (`#143479`, `#CDD4E1`, …). Centralize for consistency.

---

## 2. Dashboard (`src/app/dashboard/page.tsx`) — the most problems

The dashboard imports demo widgets wholesale and dresses them with partly-real, partly-fake
data. Several elements **look interactive or data-driven but are neither**, which is both an
AI-slop tell and a trust problem for a product whose stated #1 risk is "exercise trust."

- **[P1] "Decks"/"cards" language contradicts the product.** Hero button "Browse decks"
  (line 67), section title "Decks" (line 222), "+ New deck" button → `/skills/new`
  (lines 225–227), and "Card 1 / N" counter (line 156). The product schedules *skills* in
  *collections*, not flashcard decks; `CLAUDE.md` says "schedules skills, not static
  flashcards" and "avoid … Anki-like management screens." → Use skills/collections wording.

- **[P1] Fake progress bar.** "Up next" fill is hardcoded `width: ready ? "44%" : "12%"`
  (line 159). A progress bar that displays an invented value. → Remove or bind to real
  progress.

- **[P1] Fake "Card 1 / N" counter** (line 156) — always "Card 1," N = active-skill count.
  Presents skills as a deck position that doesn't exist.

- **[P1] Grade buttons are fake controls.** Again/Hard/Good/Easy are `<Link href="/practice">`
  (lines 171–184), styled identically to the real practice grade buttons. Users will expect
  "Easy" to grade the item; all four just navigate. Misleading affordance, and it duplicates
  the practice UI out of context (feedback must be instant *in practice*, not implied here).
  → Remove; the hero "Start session" CTA already covers the intent.

- **[P1] Weekly-goal ring is fabricated.** `days = ceil(recentReviewCount / 2)` clamped 1–7
  (line 305) is an invented metric, and the SVG arc is **hardcoded** `stroke-dasharray="130 182"`
  (line 322) so the ring fill never matches the `days/7` number it displays; "On track" is
  always shown (line 347). A data-shaped decoration that doesn't track data. → Compute the
  arc from a real goal, or remove the widget.

- **[P1] Non-functional filter chips + search box.** "All / Due / Stable" chips and the
  search field are `aria-hidden` static decorations (lines 230–238) that look operable but
  do nothing. Decoration masquerading as controls. → Remove, or make them real filters.

- **[P1] Session-preference toggles are fake.** `PreferenceSwitch` renders static `<i>`
  switches with hardcoded `checked` and no interactivity (lines 432–456). They imply saved
  settings that don't exist and duplicate the real Settings page. → Remove (settings live in
  `/settings`) or wire to real preferences as proper `role="switch"` controls.

- **[P2] Faked deck metadata.** `meta: readyNowCount > 0 ? "last reviewed today" : "caught up"`
  (line 497) asserts "last reviewed today" regardless of truth.

- **[P2] Redundant repetition of the same metrics.** "Due" appears in the hero headline, the
  hero micro-stat line ("Reviews … · Retention …", lines 70–73), and again as the first stat
  tile (line 79); Retention appears in the micro-stat and a stat tile. Refactoring UI:
  emphasize by de-emphasizing — don't show the same number three ways.

- **[P2] The dashboard is long and largely duplicates dedicated pages.** Decks ≈ Skills/
  Collections; the toggles ≈ Settings; the grade row ≈ Practice. It is neither compact nor
  focused. → Reduce to a genuine "what's due + one CTA + light supporting metrics" surface.

- **[P3] Heatmap/forecast are real-ish but entirely `aria-hidden`** (lines 284, 372). If
  they're meant to inform, expose a short text summary; if purely decorative, that's fine but
  reconsider whether they earn their space.

---

## 3. Entry & Auth shells (`src/app/page.tsx`, `components/app/auth-shell.tsx`)

- **[P2] Entry page is a phone-width column centered on desktop.** `.entryShell` caps at
  ~860px (`open-water.css:1532`) with the "How it works" panel stacked beneath; at 1280px+
  this leaves large empty side gutters and reads like a centered mobile mockup. The auth page
  is genuinely 2-column and the app shells expand to a real grid at ≥1120px, so the entry page
  looks under-designed by comparison. → Give it a real desktop composition (e.g. 2-col hero +
  process, or wider content with intentional negative space).

- **[P2] Full-bleed fixed waves vs. narrow bordered container.** `.openWaterBackground` is
  `position: fixed; inset:0; width:100%; height:100vh` (`open-water.css:38`) while the shells
  are centered, narrow, and carry a 1px border + 12px radius. The faint wave bands therefore
  cross the **entire window behind and beside** the bordered "card," visually disconnected
  from it (clearly visible in the desktop screenshots). The spec intended the waves *inside*
  the app container. Also: the 580-unit wave viewBox with `preserveAspectRatio="none"`
  stretches horizontally on wide screens (flattening the curve), and `height:100vh` fixed
  means the waves never move on long scrolling pages. → Scope the background to the container,
  or drop the container border and own the full-bleed look deliberately.

- **[P3] Dev-instance "Development mode" strip** shows under the Clerk card (Clerk dev badge).
  Harmless and production-absent, but note it for screenshots/marketing.

---

## 4. Buttons & shared components

- **[P2] Keyboard focus turns the 3D shelf the wrong color.**
  `.primaryButton/.secondaryButton/.ratingButton:focus-visible { box-shadow: 0 3px 0 currentcolor }`
  (`open-water.css:899–905`). On a focused **blue** primary, `currentcolor` is the white
  label, so the bottom "shelf" flashes **white** instead of `#143479`; on a white secondary
  it flashes ink `#15233F`. The spec's focus is `outline: 2px solid #1C44A8; outline-offset: 2px`
  and the shelf should keep its edge color. → Use the variant's edge color for the shadow, or
  rely on outline only.

- **[P2] Three overlapping button implementations.** `.primaryButton`/`.secondaryButton` are
  defined flat in `globals.css` *and* as 3D press buttons in `open-water.css`, and there's also
  the `.bpbtn` / `PressButton` component. Only cascade order keeps them consistent. → Unify on
  one button system.

- **[P2] Clerk `<UserButton>` popover is unthemed.** `skills-topbar.tsx:84–93` themes only the
  avatar box/trigger + `colorPrimary`; `layout.tsx` passes only `localization` to
  `<ClerkProvider>` (no global `appearance`). The account dropdown (manage account / sign out)
  will render in default Clerk styling that doesn't match app fonts/radius/tokens. → Pass
  `appearance` at the provider (or to `UserButton`).

- **[P3] Dead/contradictory Clerk CSS.** `globals.css` `.cl-socialButtonsIconButton__facebook
  { background:#1C44A8 }` is overridden by `open-water.css` `.cl-socialButtonsIconButton
  { background:#FFFFFF !important }`, so the intended blue Facebook fill never appears (it
  renders white with a blue glyph — acceptable, but the rule is dead). `.cl-footerItem` rules
  in globals target a footer variant the current flow doesn't use (`.cl-footerAction`). Clerk
  is styled from three places (JS appearance + globals + open-water) that partly conflict;
  consolidate.

---

## 5. Typography & color

- **[P2] Inconsistent heading weights.** Page H1s are forced to 800 and most section H2s to
  700 by open-water, but its 700 override only lists `skillPanelHeader`, `dashboardPanelHeader`,
  `flagExerciseHeader`, `practiceFeedback` (`open-water.css:1009–1019`). Display-font headings
  outside that list keep the legacy `font-weight: 500` — e.g. `.skillQueueBlock h2` renders Plus
  Jakarta at 500 even though only 700/800 are loaded, so the browser faux-weights it. → Audit
  every display heading to a deliberate 700/800.

- **[P2] Mobile heading down-scaling is silently defeated.** globals' `@media (max-width:520px)
  { .practiceFrame h1 { font-size: 20px } }` (and similar) lose to open-water's non-media
  `.practiceFrame h1 { font-size: 26px; font-weight: 800 }` (later source, equal specificity).
  Some headings stay 26px/800 at ~360px → risk of cramped/overflowing titles on long skill
  names. → Re-assert the mobile sizes in the layer that wins.

- **[P2] Amber `#B8440F` is overloaded.** It is simultaneously "due/again," "attention/warning,"
  and "error/danger/destructive" (`globals.css`: `--lr-error`, `--lr-warning`, `--lr-danger-ink`
  all alias amber). The Open Water spec defines no separate red, so **destructive actions
  (delete/archive) look identical to a routine "due" badge** — users can't distinguish severity
  by color. → Introduce a distinct danger red (or otherwise differentiate destructive UI), even
  though the demo spec omitted one.

- **[P3] "Incorrect" feedback is less distinct than "correct."** Correct feedback sits on a
  green-tinted surface; incorrect uses `--lr-danger-subtle: #FFFFFF` (white) with amber text
  (`globals.css:1701–1705`). The spec wants semantic surfaces to carry matching tint. Give
  incorrect a light amber surface so the two states read with equal weight.

- **[P3] Wide label→value rows on desktop.** Flat 2-col fact rows (entry capability list,
  process list, skill panels) stretch labels far from values across ~820–1040px with short
  values, weakening the label/value relationship (Refactoring UI: keep related things close,
  cap line length). Consider tighter max-widths or column gaps.

- **[P3] Hero uppercase tracked eyebrows** ("SPACED PRACTICE", the date) are an Open-Water
  spec choice but sit against `CLAUDE.md`'s anti-slop ban on "tracked-uppercase eyebrow
  labels." Spec-sanctioned, but flag the tension if the brand language is revisited.

---

## 6. Accessibility & responsive

- **[P1] Fake dashboard toggles/chips are an a11y problem too** (see §2): they appear operable
  but are non-focusable, non-operable, and carry no role/state. If kept, they must be real
  controls (`button role="switch" aria-checked`, focusable chips).

- **[P2] Focus rings use `box-shadow` instead of `outline`.** Many controls use
  `box-shadow: var(--lr-focus-ring)` with **no offset** (`globals.css:100`), rather than the
  spec's `outline: 2px solid #1C44A8; outline-offset: 2px`. A tight inset ring can be clipped by
  `overflow: hidden` ancestors (cards, nav, deck list) and is harder to see. → Prefer the spec's
  outline+offset and verify visible focus on chips, choice cards, and nav inside clipped panels.

- **[P3] Heatmap encodes real activity but is `aria-hidden`** — no text equivalent for AT.

- **[P3] Many duplicated responsive breakpoints across both stylesheets** (`entryShell`,
  `practiceTopbar`, headings redefined at 520/620/720/1120 in both files) → high drift risk;
  consolidate when the two systems are merged.

- **[P3] Practice: when a multiple-choice answer is wrong, the correct option is not highlighted
  in the list** (only the chosen wrong option turns amber; the correct answer appears only in the
  feedback panel — `practice-client.tsx:451–456`). Defensible, but many users expect the correct
  choice marked green inline. Consider it.

---

## 7. Strong areas to preserve (for reference)

- **Practice screen** (`practice-client.tsx`): radiogroup semantics, `aria-live` status,
  managed focus, labeled choices, keyboard shortcuts, instant deterministic feedback. Keep.
- **Skills library, skill detail, collections, settings, history**: flat ruled facts, readiness-
  first hierarchy, disclosures instead of nested cards, labeled panel counts, responsive table →
  card transform on history. Well aligned to the flat language and the audit's stated principles.

---

## Suggested order of attack

1. **Decide the dashboard's fate** (§1 language unification + §2). Removing the fake
   controls/data is the biggest single quality + trust win and shrinks the surface to maintain.
2. **Merge the two stylesheets into one source of truth** (§1) — unblocks everything else and
   removes the `!important` cascade traps.
3. **Fix the focus-shelf color bug and unify buttons** (§4) — small, high-visibility correctness.
4. **Normalize heading weights + mobile sizes; add a distinct danger color** (§5).
5. **Rework the entry page's desktop layout and the wave/container relationship** (§3).
6. **Sweep accessibility: real controls, outline-based focus, breakpoint consolidation** (§6).
