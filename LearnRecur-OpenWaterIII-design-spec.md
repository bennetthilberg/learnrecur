# LearnRecur — "Open Water III" Design System Specification

**Version:** 1.0 · **Status:** Authoritative · **Target stack:** React + Mantine v7 (existing app)

This document specifies the exact look and feel of the approved LearnRecur dashboard demo. It is written to be fed to a coding agent (Codex) to retrofit an existing Mantine UI. **Every value here is literal.** When a hex, pixel, or CSS declaration is given, reproduce it character-for-character. Do not "round," "normalize," "improve," or substitute Mantine defaults for the values below.

---

## 0. How to use this document

1. Install the two fonts (Section 2) and the global CSS (Section 9).
2. Register the design tokens as CSS custom properties (Section 1.2) and, if helpful, mirror them in the Mantine theme (Section 10).
3. Build the **button system exactly as in Section 5** — this is the highest-priority, zero-deviation part of the spec. Use the provided `PressButton` component or the raw `.bpbtn` classes verbatim.
4. Build remaining components from Section 6 using the tokens.
5. Compose the page per Section 7.
6. Verify against Section 11 (accessibility/compatibility).

**Hard rules that apply everywhere:**

- Light theme only. Put `color-scheme: light;` on the app root so OS dark mode never re-themes native controls.
- No `backdrop-filter`, no blur, no frosted glass, no soft "glow" shadows. The only shadows in the system are the **hard, zero-blur** button edge shadows in Section 5 (`box-shadow: 0 Npx 0 <color>`).
- All depth/decoration is flat fills + inline SVG. No raster images.
- All numeric figures (counts, percentages, intervals, "14 / 32", etc.) use `font-variant-numeric: tabular-nums;`.
- Every motion is gated behind `@media (prefers-reduced-motion: reduce)` (see Sections 5 and 9).

---

## 1. Design tokens

### 1.1 Color palette (literal)

#### Surfaces & structure
| Token | Hex | Usage |
|---|---|---|
| `canvas` | `#F6F7F9` | App/page background base (behind the wave layers) |
| `canvas-border` | `#E4E5EA` | 1px border around the whole app container |
| `wave-1` | `#F1F3F6` | Background wave band 1 (topmost, lightest) |
| `wave-2` | `#EDEFF3` | Background wave band 2 |
| `wave-3` | `#E9EBF0` | Background wave band 3 (lowest, still very light) |
| `wave-crest-1` | `#E4E6EB` | 1px crest line on band 1 |
| `wave-crest-2` | `#E0E3E9` | 1px crest line on band 2 |
| `wave-crest-3` | `#DCDFE6` | 1px crest line on band 3 |
| `card` | `#FFFFFF` | All card / panel fills |
| `card-border` | `#E4E8F1` | 1px border on cards/panels |
| `divider` | `#EEF1F7` | 1px internal row dividers inside cards |
| `icon-tile-border` | `#DBE1EC` | 1px border on deck icon tiles |

#### Ink / text
| Token | Hex | Usage | Contrast on `#FFFFFF` |
|---|---|---|---|
| `ink` | `#15233F` | Primary text, headings, big numbers | ~14:1 (AAA) |
| `text-secondary` | `#5A6480` | Secondary/meta text | ~5.7:1 (AA) |
| `text-muted` | `#8A92A6` | Captions, day labels, "days" | ~3.1:1 — **see §11.1** |
| `nav-inactive` | `#4C5870` | Inactive top-nav links | ~7.0:1 |
| `pref-label` | `#2B3754` | Settings/preference row labels | ~11:1 |
| `icon` | `#44557A` | Deck tile glyph color, inactive chip text | ~7.4:1 |

#### Brand blue (primary)
| Token | Hex | Usage |
|---|---|---|
| `blue` | `#1C44A8` | Primary brand color: hero fill, primary button, active states, focus ring, data |
| `blue-hover` | `#2150BC` | Primary button hover fill |
| `blue-active` | `#193E9C` | Primary button active fill |
| `blue-edge` | `#143479` | Primary button 3D bottom-edge shadow |
| `blue-tint` | `#ECF0FA` | Icon-tile fill (where tinted), progress-bar track |
| `blue-bar-2` | `#BBCAEC` | Secondary (non-today) forecast bars |
| `hero-wave-1` | `#173A93` | Hero internal wave layer 1 |
| `hero-wave-2` | `#112F78` | Hero internal wave layer 2 |
| `hero-muted` | `#B9C9EF` | Hero supporting copy + micro-stat text (on blue) |

#### Green (stable / retention / "Easy")
| Token | Hex | Usage |
|---|---|---|
| `green` | `#0C7D52` | Retention value, "Stable" badge, "Easy" button, green progress |
| `green-hover` | `#0F8E5D` | "Easy" button hover fill |
| `green-active` | `#0A6C47` | "Easy" button active fill |
| `green-edge` | `#08573A` | "Easy" button 3D bottom-edge shadow |

#### Amber (due / "Again")
| Token | Hex | Usage |
|---|---|---|
| `amber` | `#B8440F` | "N due" badges, "Again" button text, `esperar que` highlight in card |

#### Yellow (signature marker) — use sparingly
| Token | Hex | Usage |
|---|---|---|
| `yellow` | `#FFD43B` | The single signature accent. ONLY: active nav underline, "Today" underline in forecast, and the underline under the highlighted answer word in the review card. Never as a fill or for large areas. |

#### Button neutrals (white & ghost variants)
| Token | Hex |
|---|---|
| `btn-white-border` | `#DDE3EE` |
| `btn-white-edge` | `#CDD4E1` |
| `btn-white-hover` | `#F5F7FB` |
| `btn-white-active` | `#EDF0F6` |
| `btn-again-hover` | `#FCF6F3` |
| `btn-again-active` | `#F7EBE5` |
| `btn-hero-edge` | `#C2CFEA` |
| `btn-hero-hover` | `#EFF3FB` |
| `btn-hero-active` | `#E4ECF8` |

#### Component-specific
| Token | Hex | Usage |
|---|---|---|
| `toggle-off` | `#C9CFDC` | Off-state toggle track |
| `chip-border` | `#DCE2EC` | Inactive chip border, search field border, kbd chip border |
| `heat-0` | `#E8EEF8` | Activity heatmap level 0 (empty) |
| `heat-1` | `#C2D2F0` | Heatmap level 1 |
| `heat-2` | `#7E9CE4` | Heatmap level 2 |
| `heat-3` | `#3D63D2` | Heatmap level 3 |
| `heat-4` | `#1C44A8` | Heatmap level 4 (max) |
| `avatar-bg` | `#15233F` | Header avatar circle fill (white text) |

### 1.2 Tokens as CSS custom properties

Paste into the global stylesheet (`:root`). Component CSS below references these.

```css
:root {
  /* surfaces */
  --lr-canvas:#F6F7F9; --lr-canvas-border:#E4E5EA;
  --lr-wave-1:#F1F3F6; --lr-wave-2:#EDEFF3; --lr-wave-3:#E9EBF0;
  --lr-wave-crest-1:#E4E6EB; --lr-wave-crest-2:#E0E3E9; --lr-wave-crest-3:#DCDFE6;
  --lr-card:#FFFFFF; --lr-card-border:#E4E8F1; --lr-divider:#EEF1F7; --lr-icon-tile-border:#DBE1EC;
  /* ink */
  --lr-ink:#15233F; --lr-text-secondary:#5A6480; --lr-text-muted:#8A92A6;
  --lr-nav-inactive:#4C5870; --lr-pref-label:#2B3754; --lr-icon:#44557A;
  /* blue */
  --lr-blue:#1C44A8; --lr-blue-hover:#2150BC; --lr-blue-active:#193E9C; --lr-blue-edge:#143479;
  --lr-blue-tint:#ECF0FA; --lr-blue-bar-2:#BBCAEC;
  --lr-hero-wave-1:#173A93; --lr-hero-wave-2:#112F78; --lr-hero-muted:#B9C9EF;
  /* green */
  --lr-green:#0C7D52; --lr-green-hover:#0F8E5D; --lr-green-active:#0A6C47; --lr-green-edge:#08573A;
  /* amber + yellow */
  --lr-amber:#B8440F; --lr-yellow:#FFD43B;
  /* button neutrals */
  --lr-btn-white-border:#DDE3EE; --lr-btn-white-edge:#CDD4E1;
  --lr-btn-white-hover:#F5F7FB; --lr-btn-white-active:#EDF0F6;
  --lr-btn-again-hover:#FCF6F3; --lr-btn-again-active:#F7EBE5;
  --lr-btn-hero-edge:#C2CFEA; --lr-btn-hero-hover:#EFF3FB; --lr-btn-hero-active:#E4ECF8;
  /* misc */
  --lr-toggle-off:#C9CFDC; --lr-chip-border:#DCE2EC; --lr-avatar-bg:#15233F;
  --lr-heat-0:#E8EEF8; --lr-heat-1:#C2D2F0; --lr-heat-2:#7E9CE4; --lr-heat-3:#3D63D2; --lr-heat-4:#1C44A8;
  /* radii */
  --lr-r-container:12px; --lr-r-card:8px; --lr-r-button:8px;
  --lr-r-icon-tile:6px; --lr-r-badge:6px; --lr-r-chip:7px; --lr-r-pill:999px;
  /* fonts */
  --lr-font-body:'Instrument Sans', system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  --lr-font-display:'Plus Jakarta Sans', system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
}
```

### 1.3 Radii (literal)
| Element | Radius |
|---|---|
| App container | `12px` |
| Hero band | `8px` |
| Cards / panels | `8px` |
| Icon tiles (deck glyph) | `6px` |
| Buttons | `8px` |
| Badges | `6px` |
| Filter chips | `7px` |
| Search field / kbd | `8px` / `4px` |
| Progress bars | `3px` |
| Forecast bars | `4px 4px 0 0` |
| Heatmap squares | `3px` |
| Toggle track | `999px` (pill) |

### 1.4 Borders
- Card/panel border: `1px solid var(--lr-card-border)`.
- Internal card row divider: `1px solid var(--lr-divider)`.
- Icon tile: `1px solid var(--lr-icon-tile-border)`.
- Badges: `1.5px solid <amber|green>`.
- Chips (inactive), search, kbd: `1px solid var(--lr-chip-border)`.
- Button borders: see Section 5 (filled = `1px solid transparent`; white/again = `1px solid var(--lr-btn-white-border)`).

---

## 2. Typography

### 2.1 Fonts & import

Two families. **Display = Plus Jakarta Sans. Body/UI = Instrument Sans.** Buttons use the **body** font (Instrument Sans), not the display font.

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet"
  href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@700;800&family=Instrument+Sans:wght@400;500;600;700&display=swap">
```

- Plus Jakarta Sans weights loaded: **700, 800**.
- Instrument Sans weights loaded: **400, 500, 600, 700**.
- Always include `&display=swap`.
- Body default `font-family: var(--lr-font-body)`. Apply `var(--lr-font-display)` only to the display roles listed in 2.3.

### 2.2 Display vs body assignment

**Display (Plus Jakarta Sans):** wordmark; hero headline; all big stat numbers; the goal-ring center number; section titles ("Up next", "Decks", "Activity", "Weekly goal", "Next 7 days", "Session preferences"); the review-card prompt sentence.

**Body (Instrument Sans):** everything else — nav links, supporting labels, stat labels, deck names/meta, card meta, chips, badges, search, toggle labels, legends, day labels, the "days" sublabel in the ring, **and all button labels.**

### 2.3 Type scale (literal — size / weight / tracking / font)

| Role | Size | Weight | Letter-spacing | Font | Color |
|---|---|---|---|---|---|
| Wordmark | 16.5px | 700 | -0.01em | Display | `ink` |
| Nav link (active) | 13px | 600 | — | Body | `ink` (with yellow underline) |
| Nav link (inactive) | 13px | 400 | — | Body | `nav-inactive` |
| Hero supporting copy | 12px | 400 | — | Body | `hero-muted` |
| Hero headline | 26px | 800 | -0.02em | Display | `#FFFFFF` (line-height 1.18) |
| Hero micro-stats | 12px | 400 | — | Body | `hero-muted` |
| Stat label | 11px | 400 | 0.04em | Body | `text-secondary` |
| Stat number | 24px | 700 | -0.02em | Display | varies (blue/green/ink); unit suffix 14px/700/`text-muted` |
| Section title | 16px | 700 | -0.01em | Display | `ink` |
| Sub-section title | 13.5px | 700 | -0.01em | Display | `ink` |
| Card meta (deck/lang) | 12px | 400 | — | Body | `text-secondary` |
| Card counter ("14 / 32") | 12px | 400 | — | Body | `text-muted` |
| Review hint (EN) | 12.5px | 400 | — | Body | `text-secondary` |
| Review prompt | 21px | 700 | -0.01em | Display | `ink` (highlight word `blue` + yellow underline) |
| Review note | 12.5px | 400 | — | Body | `text-secondary` (bolded terms 600 `ink`; `esperar que` = `amber`) |
| Deck name | 14px | 600 | — | Body | `ink` |
| Deck meta | 12px | 400 | — | Body | `text-secondary` |
| Chip (active) | 12.5px | 600 | — | Body | `#FFFFFF` |
| Chip (inactive) | 12.5px | 500 | — | Body | `icon` |
| Badge | 11.5px | 600 | — | Body | `amber`/`green` |
| Search placeholder | 12px | 400 | — | Body | `text-muted` |
| kbd chip ("⌘K") | 10px | 400 | — | Body | `text-muted` |
| Legend / day labels | 10.5–11px | 400 | — | Body | `text-muted` |
| Forecast count | 12px | 400 | — | Body | `text-muted` |
| "Today" (forecast) | 11px | 600 | — | Body | `ink` (yellow underline) |
| Toggle label | 13.5px | 400 | — | Body | `pref-label` |
| Goal-ring number | 16px | 700 | — | Display | `ink` |
| Goal-ring "days" | 9px | 400 | — | Body | `text-muted` |
| "On track" | 11.5px | 600 | — | Body | `green` |
| Avatar initial | 12px | 600 | — | Body | `#FFFFFF` |
| Button label | 12.5–13.5px | 600 | — | Body | per variant (Section 5) |

A `.disp` helper class is the simplest way to apply the display font:
```css
.disp { font-family: var(--lr-font-display); }
```

---

## 3. Spacing & layout metrics

- App container: `max-width: 580px` (the reference width; the system is fluid below this), `width: 100%`.
- Container outer: `border: 1px solid var(--lr-canvas-border); border-radius: 12px; overflow: hidden;` on `background: var(--lr-canvas)`.
- Header (nav) padding: `14px 22px 12px`.
- Hero: `margin: 4px 14px 0;` then inner padding `20px 22px 22px`.
- Section blocks below hero: horizontal padding `14px` (some `18px`), vertical rhythm `18px` top padding per section.
- Stat-tile grid: `grid-template-columns: repeat(3, 1fr); gap: 10px;`.
- Tile inner padding: `12px 14px`.
- Card inner padding: `16px 18px` (review card), `14px 16px` (activity/goal), row padding `12px 15px` (deck rows), `11px 16px` (toggle rows).
- Deck list / preferences: a single bordered card with rows separated by `1px solid var(--lr-divider)` (no gaps between rows).
- "Activity + Weekly goal" row: `grid-template-columns: 1.4fr 1fr; gap: 10px;`.
- Forecast/heatmap bar gaps: `gap: 11px` (forecast), `gap: 5px` (heatmap squares).

---

## 4. The wave background (verbatim SVG)

Three pieces of inline SVG. Reproduce paths exactly.

### 4.1 Page background waves
An absolutely-positioned SVG behind page content. Place as the first child of the app container; wrap all visible content in a sibling with `position: relative; z-index: 1;`.

```html
<svg aria-hidden="true" preserveAspectRatio="none" viewBox="0 0 580 1600"
     style="position:absolute; inset:0; width:100%; height:100%;">
  <path d="M0 250 Q 145 205 290 250 T 580 250 V1600 H0 Z" fill="#F1F3F6"/>
  <path d="M0 680 Q 145 635 290 680 T 580 680 V1600 H0 Z" fill="#EDEFF3"/>
  <path d="M0 1120 Q 145 1075 290 1120 T 580 1120 V1600 H0 Z" fill="#E9EBF0"/>
  <path d="M0 250 Q 145 205 290 250 T 580 250" fill="none" stroke="#E4E6EB" stroke-width="1"/>
  <path d="M0 680 Q 145 635 290 680 T 580 680" fill="none" stroke="#E0E3E9" stroke-width="1"/>
  <path d="M0 1120 Q 145 1075 290 1120 T 580 1120" fill="none" stroke="#DCDFE6" stroke-width="1"/>
</svg>
```
Intent: barely-there, near-flat light-grey layered surface. The three fills must stay within the very-light-grey range above; do not increase their contrast.

### 4.2 Hero internal waves
Inside the blue hero, anchored to its bottom:
```html
<svg viewBox="0 0 580 60" preserveAspectRatio="none" aria-hidden="true"
     style="position:absolute; bottom:0; left:0; width:100%; height:54px;">
  <path d="M0 22 Q 72 10 145 22 T 290 22 T 435 22 T 580 22 V60 H0 Z" fill="#173A93"/>
  <path d="M0 40 Q 72 29 145 40 T 290 40 T 435 40 T 580 40 V60 H0 Z" fill="#112F78"/>
</svg>
```

### 4.3 Hero concentric rings (top-right)
```html
<svg width="108" height="82" viewBox="0 0 108 82" aria-hidden="true"
     style="position:absolute; top:8px; right:8px;">
  <circle cx="60" cy="40" r="12" fill="none" stroke="rgba(255,255,255,0.26)" stroke-width="1.3"/>
  <circle cx="60" cy="40" r="22" fill="none" stroke="rgba(255,255,255,0.17)" stroke-width="1.3"/>
  <circle cx="60" cy="40" r="32" fill="none" stroke="rgba(255,255,255,0.10)" stroke-width="1.3"/>
</svg>
```

### 4.4 Seahorse logo mark
The detailed seahorse is the approved LearnRecur logo. Use the `OpenWaterLogoMark`
component in `src/components/app/open-water.tsx` as the source of truth.

- Wordmark placement: `31×31`, `viewBox="0 0 64 64"`, `aria-hidden="true"`.
- Fill: `currentColor`, inherited from the wordmark color.
- Do not replace this mark with the simplified spiral. The spiral was an earlier
  placeholder and is no longer the product logo.

---

## 5. BUTTONS — zero-deviation spec

> This is the most important section. The buttons and their press animation are a defining feature. Reproduce **every character** of the CSS below. Do not replace with Mantine's `<Button>` default styling.

### 5.1 Mechanic (what the animation is and why)

Each button has a **hard, zero-blur bottom-edge shadow** (`box-shadow: 0 3px 0 <edge-color>`) that reads as a 3D "shelf." On interaction the button is pressed **down into that shelf**:

- The element translates **down** by `Npx`.
- The shadow's vertical offset **shrinks** by the same `Npx`.
- **Invariant:** `translateY(px) + shadow-offset(px) = 3` at all times. This keeps the button's visual *bottom edge anchored in place* while only the top face descends — so it reads as a key being pressed, never as the button shrinking or moving as a whole.
- Background color also shifts (hover = lighter highlight; active = darker, "in shadow").

| State | `transform` | `box-shadow` | meaning |
|---|---|---|---|
| rest | `translateY(0)` | `0 3px 0 <edge>` | raised, full 3px shelf |
| hover | `translateY(1px)` | `0 2px 0 <edge>` | half-pressed |
| active | `translateY(2px)` | `0 1px 0 <edge>` | seated (1px shelf retained — do NOT collapse to 0) |

Transition (exact): `transform .08s ease, box-shadow .08s ease, background-color .12s ease`.
Disable transition under reduced-motion (Section 9).

**Do not** change active to `box-shadow: 0 0 0` / `translateY(3px)` — collapsing the shelf to zero makes it read as "getting smaller." The retained 1px shelf at active is intentional.

### 5.2 The CSS (production-ready, verbatim)

Use this exact block. It is the demo CSS plus the `appearance:none` reset required for solid color fills to render on real `<button>` elements (the demo used `<div role="button">` only to dodge a sandbox quirk; in the real app use semantic `<button>` with this reset).

```css
/* ===== LearnRecur PressButton system ===== */
.bpbtn {
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  background-image: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: 'Instrument Sans', sans-serif;
  font-weight: 600;
  font-size: 13.5px;
  line-height: 1.2;
  border: 1px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  margin: 0;
  user-select: none;
  -webkit-user-select: none;
  transform: translateY(0);
  transition: transform .08s ease, box-shadow .08s ease, background-color .12s ease;
}
.bpbtn:focus-visible { outline: 2px solid #1C44A8; outline-offset: 2px; }
.bpbtn:disabled { opacity: .5; cursor: not-allowed; }

/* Primary (blue) */
.bpbtn-blue { background-color:#1C44A8; color:#FFFFFF; box-shadow:0 3px 0 #143479; }
.bpbtn-blue:hover { background-color:#2150BC; box-shadow:0 2px 0 #143479; transform:translateY(1px); }
.bpbtn-blue:active { background-color:#193E9C; box-shadow:0 1px 0 #143479; transform:translateY(2px); }

/* Success (green) — "Easy" */
.bpbtn-green { background-color:#0C7D52; color:#FFFFFF; box-shadow:0 3px 0 #08573A; }
.bpbtn-green:hover { background-color:#0F8E5D; box-shadow:0 2px 0 #08573A; transform:translateY(1px); }
.bpbtn-green:active { background-color:#0A6C47; box-shadow:0 1px 0 #08573A; transform:translateY(2px); }

/* Neutral white (bordered) — "Hard", "Edit card" */
.bpbtn-white { background-color:#FFFFFF; color:#15233F; border-color:#DDE3EE; box-shadow:0 3px 0 #CDD4E1; }
.bpbtn-white:hover { background-color:#F5F7FB; box-shadow:0 2px 0 #CDD4E1; transform:translateY(1px); }
.bpbtn-white:active { background-color:#EDF0F6; box-shadow:0 1px 0 #CDD4E1; transform:translateY(2px); }

/* White with amber text — "Again" */
.bpbtn-again { background-color:#FFFFFF; color:#B8440F; border-color:#DDE3EE; box-shadow:0 3px 0 #CDD4E1; }
.bpbtn-again:hover { background-color:#FCF6F3; box-shadow:0 2px 0 #CDD4E1; transform:translateY(1px); }
.bpbtn-again:active { background-color:#F7EBE5; box-shadow:0 1px 0 #CDD4E1; transform:translateY(2px); }

/* White on blue hero — "Start session" */
.bpbtn-hero { background-color:#FFFFFF; color:#1C44A8; box-shadow:0 3px 0 #C2CFEA; }
.bpbtn-hero:hover { background-color:#EFF3FB; box-shadow:0 2px 0 #C2CFEA; transform:translateY(1px); }
.bpbtn-hero:active { background-color:#E4ECF8; box-shadow:0 1px 0 #C2CFEA; transform:translateY(2px); }

/* Ghost on blue hero — "Browse decks" */
.bpbtn-ghost { background-color:rgba(255,255,255,0); color:#FFFFFF; border-color:rgba(255,255,255,0.55); box-shadow:0 3px 0 rgba(255,255,255,0.20); }
.bpbtn-ghost:hover { background-color:rgba(255,255,255,0.12); box-shadow:0 2px 0 rgba(255,255,255,0.20); transform:translateY(1px); }
.bpbtn-ghost:active { background-color:rgba(255,255,255,0.18); box-shadow:0 1px 0 rgba(255,255,255,0.20); transform:translateY(2px); }

@media (prefers-reduced-motion: reduce) {
  .bpbtn { transition: none; }
}
```

### 5.3 Per-instance sizing (literal)

The base class is `font-size: 13.5px`. Override per instance exactly as below.

| Instance | Classes | font-size | padding | width |
|---|---|---|---|---|
| Hero primary "Start session" | `bpbtn bpbtn-hero` | 13.5px | `9px 18px` | auto |
| Hero secondary "Browse decks" | `bpbtn bpbtn-ghost` | 13.5px | `9px 16px` | auto |
| "+ New deck" | `bpbtn bpbtn-blue` | 12.5px | `7px 13px` | auto |
| Grade "Again" | `bpbtn bpbtn-again` | 13px | `8px 0` | `100%` (grid cell) |
| Grade "Hard" | `bpbtn bpbtn-white` | 13px | `8px 0` | `100%` |
| Grade "Good" | `bpbtn bpbtn-blue` | 13px | `8px 0` | `100%` |
| Grade "Easy" | `bpbtn bpbtn-green` | 13px | `8px 0` | `100%` |
| Generic secondary "Edit card" | `bpbtn bpbtn-white` | 13.5px | `10px 18px` | auto |

Grade-button row container: `display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;` (each child `width:100%`).

### 5.4 React component (use this for all primary/CTA/grade buttons)

```tsx
import { forwardRef } from 'react';

type PressVariant = 'blue' | 'green' | 'white' | 'again' | 'hero' | 'ghost';

interface PressButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: PressVariant;
}

export const PressButton = forwardRef<HTMLButtonElement, PressButtonProps>(
  ({ variant = 'blue', className = '', style, type = 'button', ...rest }, ref) => (
    <button
      ref={ref}
      type={type}
      className={`bpbtn bpbtn-${variant} ${className}`}
      style={style}
      {...rest}
    />
  )
);
PressButton.displayName = 'PressButton';
```

Usage:
```tsx
<PressButton variant="hero"  style={{ fontSize: 13.5, padding: '9px 18px' }}>Start session</PressButton>
<PressButton variant="ghost" style={{ fontSize: 13.5, padding: '9px 16px' }}>Browse decks</PressButton>
<PressButton variant="blue"  style={{ fontSize: 12.5, padding: '7px 13px' }}>+ New deck</PressButton>

{/* Grade row */}
<div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8 }}>
  <PressButton variant="again" style={{ width:'100%', fontSize:13, padding:'8px 0' }}>Again</PressButton>
  <PressButton variant="white" style={{ width:'100%', fontSize:13, padding:'8px 0' }}>Hard</PressButton>
  <PressButton variant="blue"  style={{ width:'100%', fontSize:13, padding:'8px 0' }}>Good</PressButton>
  <PressButton variant="green" style={{ width:'100%', fontSize:13, padding:'8px 0' }}>Easy</PressButton>
</div>
```

> If the existing app must keep using Mantine `Button` for these, set `unstyled` and apply the `bpbtn`/`bpbtn-*` classes via `className`, so none of Mantine's default variant styles fight the spec. Do not try to recreate the press with Mantine's `styles`/`variant` props alone.

---

## 6. Components (literal specs)

### 6.1 App container & header
- Container: §3 + §4.1 background.
- Header: flex row, `space-between`, padding `14px 22px 12px`.
  - Left: seahorse logo mark (§4.4, 31px) + wordmark (`disp`, 16.5/700/-0.01em, `ink`), gap 8px.
  - Right: nav links (gap 18px, 13px) + avatar. Active link: `ink`, 600, `border-bottom: 3px solid var(--lr-yellow); padding-bottom: 3px;`. Inactive: `nav-inactive`, 400.
  - Avatar: `28px` circle, `background: var(--lr-avatar-bg); color:#FFF;` initial 12/600.

### 6.2 Hero
- Wrapper: `margin: 4px 14px 0; border-radius: 8px; background:#1C44A8; position:relative; overflow:hidden;`
- Internal waves §4.2 + rings §4.3.
- Content (`position:relative`): padding `20px 22px 22px`.
  - Headline (`disp`): 26/800/-0.02em, line-height 1.18, `#FFFFFF`, tabular-nums, `margin 0 0 15px`.
  - Supporting copy or micro-stat text, when present: 12/400, `hero-muted`, tabular when numeric.
  - Action row: flex, gap 10px, wrap. Hero primary + ghost (Section 5.3) + optional micro-stat span (12px `hero-muted`, tabular: `Streak 23 · Retention 91%`).

### 6.3 Stat tiles
- Grid of 3, gap 10px, top padding 14px, side padding 14px.
- Each tile: `background:#FFF; border:1px solid var(--lr-card-border); border-radius:8px; padding:12px 14px;`
  - Label: 11/400/0.04em, `text-secondary`, `margin 0 0 3px`.
  - Number (`disp`): 24/700/-0.02em, tabular. Color: Due=`blue`, Retention=`green`, Avg interval=`ink`. Unit suffix span (e.g. " d"): 14/700, `text-muted`.

### 6.4 Review card ("Up next")
- Section title (`disp`, 16/700/-0.01em) above, then card `background:#FFF; border:1px solid var(--lr-card-border); border-radius:8px; padding:16px 18px`.
  - Top row: deck label (12, `text-secondary`) ↔ counter (12, `text-muted`, tabular: `Card 14 / 32`).
  - Progress: `height:4px; background:var(--lr-blue-tint); border-radius:3px;` fill `width:44%; background:var(--lr-blue);` `margin-bottom:16px`.
  - EN hint: 12.5, `text-secondary`.
  - Prompt (`disp`): 21/700/-0.01em, `ink`, line-height 1.35. Highlighted answer word: `color:var(--lr-blue); border-bottom:2.5px solid var(--lr-yellow);`.
  - Note: 12.5, `text-secondary`; key terms 600 `ink`; trigger phrase `esperar que` colored `amber`.
  - Grade row §5.3.

### 6.5 Decks section
- Header row: title (`disp`, 16/700) ↔ "+ New deck" (`bpbtn bpbtn-blue`, 12.5/`7px 13px`).
- Filter + search row (flex, space-between, wrap):
  - Chips (gap 7px): active = `background:#1C44A8; color:#FFF; border-radius:7px; padding:6px 12px; 12.5/600;` inactive = `background:#FFF; border:1px solid var(--lr-chip-border); color:var(--lr-icon); border-radius:7px; padding:5px 12px; 12.5/500;`
  - Search: `background:#FFF; border:1px solid var(--lr-chip-border); border-radius:8px; padding:6px 9px;` search icon (14px, `text-muted`) + "Search" (12, `text-muted`) + kbd chip ("⌘K", 10px, `border:1px solid var(--lr-chip-border); border-radius:4px; padding:1px 5px;`).
- Deck list card: `background:#FFF; border:1px solid var(--lr-card-border); border-radius:8px; overflow:hidden;` rows divided by `1px solid var(--lr-divider)` (last row no divider). Row padding `12px 15px`, flex gap 12px:
  - **Icon tile (de-cutesified):** `32px` square, `border-radius:6px; background:#FFF; border:1px solid var(--lr-icon-tile-border);` centered monoline glyph 17px, color `var(--lr-icon)`. Tabler icons used: Spanish=`IconLanguage`, Watchmaking=`IconGauge`, Neuroscience=`IconAffiliate`. (Do not use playful/filled icons; keep monoline neutral.)
  - Name (14/600 `ink`) + meta (12 `text-secondary` tabular: `142 cards · last reviewed today`).
  - Mini progress: `56px × 5px`, track `var(--lr-blue-tint)`, fill `var(--lr-blue)` (or `var(--lr-green)` when caught up).
  - Status badge (right): due = `color/border var(--lr-amber)`, text `"8 due"`; stable = `color/border var(--lr-green)`, text `"Stable"`. Badge: `11.5/600; border:1.5px solid; border-radius:6px; padding:2px 8px;` tabular for counts.

### 6.6 Activity heatmap + Weekly goal (2-col row)
- Grid `1.4fr 1fr`, gap 10px. Both are standard cards (`#FFF`, 1px border, radius 8, padding `14px 16px`).
- **Heatmap:** sub-title (`disp`, 13.5/700). Grid 5 rows × 7 cols of `15px` squares, `gap:5px`, `border-radius:3px`. Intensity scale by value 0–4 → `heat-0..heat-4`. Legend row: "Less" + five 11px swatches (`heat-0..4`) + "More" (10.5, `text-muted`).
- **Weekly goal ring:** sub-title (`disp`, 13.5/700, left-aligned). SVG donut `74×74`, `r=29`, track stroke `var(--lr-blue-tint)` width 7, value stroke `var(--lr-blue)` width 7 `stroke-linecap:round`, `stroke-dasharray:"130 182"` `transform:"rotate(-90 37 37)"`. Center number (`disp`, 16/700, `ink`) over "days" (9, `text-muted`). Below: "On track" (11.5/600, `green`).

```html
<svg width="74" height="74" viewBox="0 0 74 74" aria-hidden="true">
  <circle cx="37" cy="37" r="29" fill="none" stroke="#ECF0FA" stroke-width="7"/>
  <circle cx="37" cy="37" r="29" fill="none" stroke="#1C44A8" stroke-width="7"
          stroke-linecap="round" stroke-dasharray="130 182" transform="rotate(-90 37 37)"/>
  <text x="37" y="35" text-anchor="middle" font-family="'Plus Jakarta Sans',sans-serif" font-size="16" font-weight="700" fill="#15233F">5/7</text>
  <text x="37" y="49" text-anchor="middle" font-family="'Instrument Sans',sans-serif" font-size="9" fill="#8A92A6">days</text>
</svg>
```

### 6.7 Forecast ("Next 7 days")
- Header: title (`disp`, 13.5/700) ↔ count (12, `text-muted`, tabular: `68 cards forecast`).
- Bar row: 7 equal flex columns, `gap:11px`, container `height:46px`, bars bottom-aligned, `border-radius:4px 4px 0 0`. Today bar (first) = `var(--lr-blue)` full height; others = `var(--lr-blue-bar-2)` at literal heights `64% 44% 82% 30% 54% 38%`.
- Labels row (gap 11px): first = "Today" 11/600 `ink` with `border-bottom:2.5px solid var(--lr-yellow); padding-bottom:2px;`; rest = day abbreviations 11/400 `text-muted`, centered.

### 6.8 Toggles ("Session preferences")
- Card with title (`disp`, 13.5/700, padding `13px 16px 11px`, bottom divider). Rows: `11px 16px`, divided.
  - Label: 13.5/400, `pref-label`. Toggle on the right.
  - **Toggle track:** `36×20`, `border-radius:999px`. On = `var(--lr-blue)`; off = `var(--lr-toggle-off)`. Knob: `16×16` circle `#FFF`, `top:2px`; on → `right:2px`, off → `left:2px`.

### 6.9 Progress bars (generic)
Track `var(--lr-blue-tint)`, fill `var(--lr-blue)` (or `var(--lr-green)` for completed/stable), `height:4–5px`, `border-radius:3px`, `overflow:hidden`.

---

## 7. Page composition (order & spacing)

Top-to-bottom inside the container:
1. Header / nav (§6.1)
2. Hero (§6.2)
3. Stat tiles ×3 (§6.3)
4. "Up next" review card (§6.4)
5. Decks: header + chips/search + list (§6.5)
6. Activity + Weekly goal row (§6.6)
7. Next 7 days forecast (§6.7)
8. Session preferences toggles (§6.8)

Vertical rhythm between sections ≈ `18px` top padding per block; final block bottom padding `20px`. Side padding `14px` for most blocks (`18px` for forecast/header).

---

## 8. Mantine v7 theme object

Use this to align the rest of the app (colors, fonts, radius, focus). It does **not** restyle the `.bpbtn` system — keep that as CSS (Section 5). Mantine arrays are ordered light→dark; index 6 is the "main" shade and is set to the brand values.

```ts
import { createTheme, rem } from '@mantine/core';

export const learnRecurTheme = createTheme({
  fontFamily: "'Instrument Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  fontFamilyMonospace: "ui-monospace, SFMono-Regular, Menlo, monospace",
  headings: {
    fontFamily: "'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
    fontWeight: '700',
  },
  primaryColor: 'brand',
  primaryShade: 6,
  defaultRadius: rem(8),
  white: '#FFFFFF',
  black: '#15233F',
  colors: {
    // Brand blue — index 6 = #1C44A8
    brand: ['#EEF3FC','#D7E2F6','#AEC2EC','#8099DE','#4F6ECB','#2C53BB','#1C44A8','#193E9C','#143479','#0F2A63'],
    // Green — index 6 = #0C7D52
    leaf:  ['#E7F5EE','#CBEAD9','#9AD6B8','#63BE92','#2E9E6E','#13885A','#0C7D52','#0A6C47','#08573A','#063F2A'],
    // Amber — index 6 = #B8440F
    amber: ['#FBEDE6','#F6D2C2','#EDA888','#E27C52','#D2592A','#C44C18','#B8440F','#9C3A0D','#7E2F0B','#5C2208'],
    // Neutral ink-grays tuned to the spec
    slate: ['#F6F7F9','#EDEFF3','#E4E8F1','#D7DAE2','#C9CFDC','#8A92A6','#5A6480','#44557A','#2B3754','#15233F'],
  },
  components: {
    Card:  { defaultProps: { radius: rem(8), withBorder: true }, styles: { root: { borderColor: '#E4E8F1' } } },
    Paper: { defaultProps: { radius: rem(8) } },
    Badge: { defaultProps: { radius: rem(6) } },
    // Use the PressButton component / .bpbtn classes for primary CTAs instead of Mantine Button.
  },
});
```

> `--lr-yellow (#FFD43B)` is intentionally NOT a Mantine `primaryColor` palette — it's a marker accent only (underlines). Keep it out of fills.

---

## 9. Global CSS (drop-in)

```css
/* fonts: load via the <link> in §2.1 */

:root { /* paste the token block from §1.2 here */ }

html, body, #root { background: var(--lr-canvas); }

/* Lock light rendering so OS dark mode can't re-theme native form controls */
:root, body { color-scheme: light; }

/* App scope helpers */
.lr-app { font-family: var(--lr-font-body); color: var(--lr-ink); }
.lr-app *, .lr-app *::before, .lr-app *::after { box-sizing: border-box; }
.disp { font-family: var(--lr-font-display); }

/* tabular numerals on any element that shows figures */
.tnum { font-variant-numeric: tabular-nums; }

/* ===== paste the entire §5.2 .bpbtn block here ===== */

/* Respect reduced motion globally for any other transitions you add */
@media (prefers-reduced-motion: reduce) {
  .lr-app * { animation-duration: .001ms !important; transition-duration: .001ms !important; }
}
```

---

## 10. Icons

- Library: `@tabler/icons-react` (monoline, matches the system). Default stroke; size 17px in deck tiles, 14px in search.
- Used names: `IconLanguage` (Spanish deck), `IconGauge` (Watchmaking deck), `IconAffiliate` (Neuroscience deck), `IconSearch` (search field).
- Deck-tile glyph color is always `var(--lr-icon)` (`#44557A`) — uniform, not per-deck-colored. Status color lives in the badge, not the icon.
- Never use filled/rounded "playful" icons (no cartoon brains, mascots, emoji).

---

## 11. Accessibility & compatibility (must pass)

### 11.1 Contrast — one required hardening
Most pairs clear WCAG AA comfortably (ink ~14:1; secondary `#5A6480` ~5.7:1; blue/white ~9.3:1; green/white ~4.8:1; amber/white ~6.5:1; hero muted text on blue ~5.6:1). **Exception:** `text-muted #8A92A6` is ~3.1:1 on white — below AA for normal-size text. For any muted text that conveys information (counters, day labels, forecast count, "days"), darken it to **`#6E7689`** (≈4.6:1) in production. Keep `#8A92A6` only for purely decorative glyphs. (Provide this as `--lr-text-muted` if you want it global.)

### 11.2 Focus
- Keyboard focus ring on buttons: `outline: 2px solid #1C44A8; outline-offset: 2px;` (already in §5.2). Ensure all interactive elements (chips, toggles, nav, deck rows if clickable) have an equivalent visible focus state.
- If you keep the demo's non-semantic patterns anywhere, replace them: buttons must be `<button>`, toggles `<button role="switch" aria-checked>`, nav `<a>`/`<button>`, chips `<button aria-pressed>`.

### 11.3 Motion
- All transitions disabled under `prefers-reduced-motion: reduce` (§5.2, §9). The on-screen "Reduced motion" preference toggle, when on, should additionally suppress app animations at the app level.

### 11.4 Compatibility
- No `backdrop-filter`, no blur radius in any shadow, no CSS features newer than evergreen-2019. The button press uses only `transform` + `box-shadow` (compositor-friendly, no layout reflow) and degrades to an instant state change if transitions are unsupported.
- All decoration is inline SVG (a few hundred bytes each) — crisp at any DPI, identical on a 10-year-old Edge/Chromebook and a current machine.
- Decorative SVG must carry `aria-hidden="true"`.

---

## 12. Acceptance checklist

- [ ] Fonts: Jakarta (display) + Instrument (body) loaded; display roles per §2.2 only.
- [ ] Tokens registered as CSS variables (§1.2); no stray hexes outside the palette.
- [ ] Background waves present and **near-flat light grey** (§4.1); bottom is not visibly darker than top.
- [ ] Hero: blue `#1C44A8`, internal waves + rings, 8px radius, 800-weight headline.
- [ ] Buttons: `.bpbtn` block pasted verbatim incl. `appearance:none`; press obeys the `translateY+shadow=3` invariant; active retains a 1px shelf; reduced-motion disables transition.
- [ ] All six button variants render solid fills (blue, green, white, again, hero, ghost) in both light and OS-dark via `color-scheme: light`.
- [ ] Cards 8px radius, 1px `#E4E8F1` border; rows divided by `#EEF1F7`.
- [ ] Deck tiles: bordered neutral squares, monoline icons, `#44557A`.
- [ ] Yellow `#FFD43B` appears ONLY as: active nav underline, "Today" forecast underline, review answer underline.
- [ ] Numbers use tabular-nums.
- [ ] `text-muted` hardened to `#6E7689` for informational text (§11.1).
- [ ] No blur / backdrop-filter / soft glow anywhere.
```
