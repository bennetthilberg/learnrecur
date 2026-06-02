# LearnRecur — Design System

> An extraordinarily easy-to-use spaced repetition system that helps you solidify
> anything you learn.

This repository is the living source of truth for LearnRecur frontend design. It
contains the brand foundations (color, type, spacing, elevation), reusable UI kit
components, preview cards for the Design System tab, and a portable skill definition.

If a later design pass changes a token or pattern, update the relevant file **and**
this README in the same change.

---

## Sources

No external codebase, Figma file, or slide deck was provided for this system. It was
built entirely from the **LearnRecur Design System brief** (a written specification of
North Star, locked tokens, and component principles). Everything here is an
interpretation of that brief.

- **Codebase:** none provided. Target stack per brief: **Next.js + Mantine**.
- **Figma:** none provided.
- **Decks:** none provided.
- **Fonts:** **Lexend** loaded from Google Fonts (this is the brief's exact specified
  font, so no substitution was made). If you need self-hosted `.woff2` files for
  offline/production use, drop them in `fonts/` and update `colors_and_type.css`.

> ⚠️ The **logo / wordmark** (`assets/logo-mark.svg`, `assets/logo-wordmark.svg`) was
> designed from scratch because none was supplied. It is a proposal — see Caveats.

---

## Product Context

LearnRecur is a focused study tool built on **spaced repetition**: you add things you
want to remember, and the app schedules reviews at expanding intervals so knowledge
sticks with minimum effort. The product surface is a **web application** (light mode
first), structured around two core loops:

1. **Capture** — add notes, facts, cards, or material you want to retain (often pulled
   from a source you're reading or studying).
2. **Review** — work a daily queue of due items; each review reschedules the item
   further out as recall succeeds.

The design must read as **precise, reliable, slightly scientific, and approachable** —
a working tool, not a marketing site and not a generic AI SaaS dashboard.

### North Star (from the brief)

- Clear learning/review workflows over marketing-style presentation.
- Strong text contrast, restrained hierarchy.
- Cool, considered neutrals — never default gray ramps.
- Specific, functional UI details over decorative effects.
- Quiet confidence: modern, crisp, useful.

---

## Design Decisions (locked)

| Area | Decision |
|---|---|
| Framework | Next.js |
| Components | Mantine (wrapped/themed — defaults are **not** the design language) |
| Font | Lexend, headings `500`, body `400`, labels `500–560` |
| Primary | Blue `#034cd5` (white text ≈ 7.0:1, WCAG AAA) |
| Accent | Amber `#b76a00` (warnings, source gaps; never purple) |
| Neutrals | "Steel" — subtle blue/steel cast |
| Radius | base `5px`, sm `3px`, lg `10px`, chip `7px` |
| Density | Roomy; panel padding ~`26px` |
| Canvas | Lightly cool page tint (`#f6f8fb`) |
| Elevation | "Soft" — two subtle shadows, no glow |
| Surfaces | Hairline border + restrained shadow (never both heavy) |
| Tables | Rules (not zebra), tabular figures |
| Messages | Slim colored stripe + concise copy |
| Empty states | Technical-minimal: what's missing + one next action |
| Navigation | Responsive sidebar → tabs (no rail) |
| Focus | Halo (visible, restrained, not glowy) |
| Badges | Chips (`7px` radius; pills only when tiny/semantic) |

Full token values live in [`colors_and_type.css`](./colors_and_type.css).

---

## CONTENT FUNDAMENTALS

How LearnRecur writes. Copy is part of the precision — it should feel like a calm,
competent study partner, never a chatty mascot.

**Voice:** exact, encouraging, quietly confident. The product knows the science and
respects the user's time. It states facts and offers the next useful action.

**Person:** address the user as **"you."** The system refers to itself in plain terms
("LearnRecur scheduled…") or simply describes what happened ("Scheduled for review in
4 days"). Avoid "we" in product UI.

**Tense & mood:** present tense, active voice, imperative for actions
("Add your first item", "Start review", "Mark as known").

**Casing:** **Sentence case everywhere** — buttons, headings, menu items, labels.
Reserve ALL-CAPS only for the small tracked eyebrow labels (`.lr-label`), never for
headings or buttons.

**Tone examples**

| Context | Write | Don't write |
|---|---|---|
| Empty queue | "You're all caught up. Next review in 6 hours." | "🎉 Woohoo! Nothing to do!!" |
| Add item CTA | "Add your first item" | "Let's get started!!" |
| Review reschedule | "Nice. Next review in 9 days." | "Amazing job, superstar!" |
| Source warning | "This item has no source. Add one to verify it later." | "Uh oh, something's missing 😬" |
| Error | "Couldn't save. Check your connection and try again." | "Oops! That didn't work." |

**Numbers:** always specific and tabular — "12 due", "Retention 92%", "Interval 9d".
Use real units (`d`, `h`, `%`). Numerals, not words, for counts. Never invent stats
just to fill space.

**Emoji:** **none** in product UI. Not as icons, not as decoration. Iconography is
handled by a proper icon set (see ICONOGRAPHY).

**Punctuation:** periods on full sentences in body/help text; no terminal period on
buttons, labels, or single-phrase microcopy. Avoid exclamation marks except very
sparingly for genuine milestones (and even then, prefer restraint).

---

## VISUAL FOUNDATIONS

The motifs and rules that make a surface read as LearnRecur.

### Color vibe
Cool and steel throughout. The canvas (`#f6f8fb`) carries a ~15% blue tint so white
panels feel like crisp objects floating on a cool page rather than white-on-white.
Primary blue `#034cd5` is the single high-signal color — used decisively and sparingly
for the one most important action or state on a view. Amber is the only secondary
attention color (warnings, missing sources). Everything else is steel neutral. **No
warm grays, no zinc/slate defaults, no light-gray body copy.**

### Type
Lexend at restrained weights — headings `500` (Lexend gets chunky fast, so heavy
weights are avoided), body `400`, control labels `500–560`. Headings carry slightly
negative tracking (`-0.011em`); small eyebrow labels are uppercase with `+0.04em`
tracking. **No large display headings inside compact tool panels** — display sizes are
for page-level heroes only. Numbers use tabular lining figures (`font-variant-numeric:
tabular-nums`) so schedules, intervals, and counts align in columns.

### Spacing & density
Roomy but tool-like. Major panels pad ~`26px`. Gaps are intentional, not uniform:
`6–10px` for tightly related items, `14–18px` for component groups, `22–30px` for
section separation. **No marketing-page whitespace inside app workflows** — generous,
not empty.

### Backgrounds
Flat cool surfaces only. **No gradient blobs, glow, bokeh, grain, or hand-drawn
textures.** The page is a single cool tint; panels are pure white. Depth comes from the
hairline + soft-shadow system, not from imagery. There is no full-bleed photography in
the app surface.

### Borders, cards & elevation
Surface separation is **hairline**: a crisp cool border (`#dce3eb`) defines structure,
paired with the restrained two-layer "Soft" shadow. **Never combine a heavy border with
a heavy shadow** on the same surface. Cards are flat and modern — **no skeuomorphic 3D
edges, no inner-shadow bevels.** Corner radii are tight (`5px` base, `3px` small,
`10px` large) to read as a precise instrument. Chips round slightly more (`7px`) to feel
intentional; full pills are reserved for tiny status tags.

### Shadows
Two-layer soft shadow is the default elevation:
`0 1px 2px rgba(18,29,51,.035), 0 8px 18px rgba(18,29,51,.045)`. A `raised` variant
exists for menus/popovers. **No glow, no colored shadows, no identical elevation on
everything** — most surfaces sit flat on hairlines; elevation is reserved for things
that genuinely float (menus, dialogs, the active review card).

### Focus & interaction states
- **Focus:** a restrained **halo** — `0 0 0 3px rgba(3,76,213,.32)` — visible against
  both the cool canvas and white panels, never glowy.
- **Hover:** darken fills (primary → `#0341b6`), or shift neutral fills one step
  (`#eef2f7` → `#e3e9f1`). Links/ghost controls pick up a quiet neutral fill.
- **Press:** darken further (primary → `#032f86`); a subtle `translateY(0.5px)` is
  acceptable but **no large shrink/scale bounce.**
- **Selected/active:** primary-soft fill (`#e7eefc`) with primary-ink text, or a
  primary left/under indicator in nav.

### Motion
Quiet and functional. Short durations (`120–200ms`), standard ease
(`cubic-bezier(.2,.6,.2,1)`). Fades and small position shifts only. **No bounce, no
spring, no decorative looping animation.** Respect `prefers-reduced-motion`.

### Transparency & blur
Used sparingly: dialog/scrim overlays use a low-opacity steel scrim; sticky headers may
use a subtle backdrop blur. Not used decoratively on cards or backgrounds.

### Layout rules
Responsive sidebar on wide screens (persistent, stable, tool-like), collapsing to a top
tab bar on narrow/mobile widths. Content sits on the cool canvas in white panels with
comfortable max-widths — workflows are never stretched to full marketing width. Headers
and primary nav are fixed/sticky where it aids orientation.

---

## ICONOGRAPHY

No icon assets were provided with the brief, and there is no codebase to extract a
built-in icon font or sprite from.

**Chosen set:** **[Lucide](https://lucide.dev)** — linked from CDN.

Rationale: Lucide is the icon family that ships with / pairs naturally with the modern
Mantine ecosystem (`@tabler/icons` is the Mantine default, and Lucide is its closest
open, evenly-weighted sibling). Its **2px stroke, rounded line geometry** matches
LearnRecur's precise-but-approachable tone far better than filled or heavier sets. This
is a **substitution flagged for review** — if the real app standardizes on Tabler
Icons, swap the CDN and keep the same usage rules.

**Usage rules**
- **Line icons only**, default stroke width `2`, rounded caps/joins — matching Lucide
  defaults. Don't mix filled and line icons.
- Default icon color is `currentColor` so icons inherit text color (ink, muted, or
  primary in active states). Don't recolor icons decoratively.
- Standard sizes: `16px` inline with body / in buttons, `18–20px` in nav and headers,
  `24px` for empty-state / feature anchors. Align icon optical weight to adjacent text.
- **No emoji** as icons anywhere. **No unicode glyphs** standing in for icons.
- The brand **logomark** (`assets/logo-mark.svg`) is not an icon — don't use it inline
  in lists or buttons.

**CDN (vanilla):**
```html
<script src="https://unpkg.com/lucide@latest"></script>
<i data-lucide="layers"></i>
<script>lucide.createIcons();</script>
```
The UI kit uses this approach. See `ui_kits/app/` for live usage.

---

## Index / Manifest

Root files:
- **`README.md`** — this file. Product context, content + visual foundations, iconography.
- **`colors_and_type.css`** — all color & type tokens (base + semantic). Import first.
- **`SKILL.md`** — portable Agent-Skill definition for reuse in Claude Code.

Folders:
- **`assets/`** — brand marks: `logo-mark.svg`, `logo-wordmark.svg`.
- **`fonts/`** — (empty) drop self-hosted Lexend `.woff2` here for production/offline.
- **`preview/`** — small HTML cards that populate the Design System tab (Type, Colors,
  Spacing, Components, Brand). Not meant for production use.
- **`ui_kits/app/`** — high-fidelity recreation of the LearnRecur web app:
  `index.html` (interactive click-through) plus modular `.jsx` components and a kit
  `README.md`.

---

## Caveats

- **Logo is original.** No mark was supplied. The logomark is a **seahorse** — a nod to
  the *hippocampus* (Greek for seahorse; also the brain's memory center), drawn in the
  line-based brand language. The wordmark sets "LearnRecur" in Lexend Medium (500).
  Please review and replace with an official asset if one exists.
- **Icon set is a substitution.** Lucide was chosen as the closest open match to the
  Mantine/Tabler default; confirm or swap.
- **Fonts load from Google Fonts CDN.** For offline/production, self-host Lexend in
  `fonts/`.
- **No source product to verify against.** Every screen and component is an
  interpretation of the written brief, not a recreation of existing UI. Treat the UI kit
  as a strong starting point, not a pixel match to a shipped product.
