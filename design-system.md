# LearnRecur Design System

This document records design decisions for LearnRecur frontend work. Treat it as a living source of truth. If a later design-lab pass changes a token or pattern, update this file in the same change.

## Design North Star

LearnRecur should feel like a focused, modern study tool: precise, reliable, slightly scientific, and approachable without becoming playful or cute. It should not look like a generic Mantine app or an AI-generated SaaS dashboard.

The interface should prioritize:

- Clear learning and review workflows over marketing-style presentation.
- Strong text contrast and restrained hierarchy.
- Cool, considered neutrals instead of default gray ramps.
- Specific, functional UI details rather than decorative effects.
- Quiet confidence: modern, crisp, and useful.

## Technology And Library Choices

- Framework: Next.js.
- Component library: Mantine.
- Font: Lexend via Google Fonts.
- Theme: light mode first.

Mantine components are allowed, but Mantine defaults are not the design language. Components should be wrapped, themed, or styled so LearnRecur has its own visual identity.

## Locked Tokens

### Primary Color

- Primary blue: `hsl(219 97% 42%)` (`#034cd5`).
- White text contrast on primary: approximately `7.00:1`.
- Use this for primary actions, selected states, progress, active navigation, and high-signal system UI.

Rationale: this keeps the Login.gov-like professional blue direction while reaching WCAG AAA contrast for normal white text.

### Typography

- Font family: Lexend.
- Heading weight: `500`.
- Body weight: typically `400`.
- Supporting labels and controls: `500` to `560` only when needed.
- Numeric text: Lexend with tabular figures where possible.
- Letter spacing stays at `0`; do not squeeze Lexend with negative tracking.
- Heading tokens use fixed breakpoint steps, not viewport-fluid `vw` or `clamp()` sizing.
- Type scale:
  - `11px` only for cramped responsive navigation.
  - `12px` for chips, table metadata, compact labels, and counters.
  - `13px` for secondary labels and compact supporting copy.
  - `14px` for controls.
  - `15px` for body copy and row titles.
  - `16px+` only for emphasized form/report text and major wordmarks.
  - Page headings use responsive tokens rather than ad hoc viewport math.

Rationale: Lexend can look chunky, so avoid very heavy headings. The practical weight jump in the loaded Google Font is not smooth; `500` is the preferred heading appearance.

### Radius

- Base radius: `5px`.
- Small radius: `3px`.
- Large radius: `10px`.
- Pill radius is reserved for badges, very small status tags, and controls that are semantically pill-like.

Rationale: tighter corners make the app feel more like a precise tool and less like a soft consumer product.

### Spacing And Density

- Density: roomy.
- Base component padding: about `26px` for major panels.
- Internal gaps should vary by relationship:
  - Tight related items: `6-10px`.
  - Standard component groups: `14-18px`.
  - Section separation: `22-30px`.

Rationale: the app will not be extremely dense, but spacing must still feel like a working tool rather than a landing page.

### Canvas

- Canvas tint: about `15%` toward the cool blue page tint.
- Page surfaces should feel lightly cool, not warm or beige.

Rationale: a cool-tinted canvas supports the blue system and avoids default gray-on-gray slop.

### Neutrals

Current neutral family: Steel.

- Ink: `hsl(215 31% 11%)`.
- Muted text: `hsl(211 16% 35%)`.
- Faint text: `hsl(213 14% 47%)`.
- Line: `hsl(212 27% 89%)`.
- Page base: `hsl(216 38% 97%)`.
- Panel: `hsl(0 0% 100%)`.

Rationale: neutrals should carry a subtle blue/steel cast. Avoid warm gray, zinc/slate defaults, washed-out body copy, and low-contrast gray text.

### Accent

- Accent: Amber `hsl(35 100% 36%)`.
- Accent soft: `hsl(39 100% 98%)`.
- Accent line: `hsl(35 72% 82%)`.
- Accent ink: `#6f4200`.

Use amber for review warnings, source gaps, and secondary attention. Use the soft fill and line for bounded status surfaces; reserve the full accent for rare high-signal details. Do not drift this accent toward purple.

### Elevation

Current default: Soft.

- Shadow: `0 1px 2px hsl(219 48% 10% / 0.035), 0 8px 18px hsl(219 48% 10% / 0.045)`.
- Borders remain subtle unless a future surface-separation decision removes them.

Rationale: two subtle shadows feel more natural than one generic shadow. Avoid glow, heavy blur, and identical elevation on everything.

## Open Design Decisions

The design lab should only keep controls here when the system choice is still genuinely undecided. Current foundational surface, navigation, table, focus, badge, message, empty-state, and dimensional-surface choices are locked below.

When a choice is made, move it from this section into Locked Tokens or Component Patterns.

## Component Principles

### Entry Surface

The public entry surface should feel like a compact product orientation, not a generic SaaS hero. Use concrete capability rows and a flat study-loop ledger; avoid placing the process explanation in a decorative mock card beside the headline.
Auth pages should keep the third-party sign-in/up form as the only heavy bounded object. Account-context facts belong in a flat rule-separated list beside it.
In auth-context lists, only the most important workspace fact should receive primary color. Supporting facts should use faint labels and muted copy so the account form remains the dominant object.
Third-party auth provider buttons must preserve icon contrast. If a provider icon is white, use the provider-colored button fill instead of leaving an empty-looking white control.
Provider development or environment footers should read as quiet metadata, not warnings or promotional strips. Use the app's rule-separated footer treatment when a stable provider class is available.

### Buttons

Primary buttons use `#034cd5` with white text. Secondary buttons should use a light blue background and dark blue text. Default or ghost buttons should be white with a clear but quiet boundary.
Destructive secondary actions should use the danger-tinted surface with danger ink text; reserve brighter red for boundaries, status stripes, or compact emphasis.

Buttons should not be oversized. Use compact, tool-like button proportions.
Pending button labels should stay steady and literal, such as Saving or Queueing, without decorative ellipses.

Disclosure actions in management rows should look like intentional controls, not native browser summaries with default markers. Keep closed disclosures compact; let only the open inline form claim extra row width.

Creation-path disclosures should also hide native markers and show an
explicit compact affordance. Optional source context uses a bounded utility row
with a small plus/minus control; the manual draft fallback uses the same
affordance language inside its larger recovery panel so users can see that it
opens.

### Forms

Form controls should inherit the app's neutral system rather than browser defaults. Placeholder text uses the faint steel token with full opacity; disabled fields use a quiet panel fill and muted text so state is visible without washing out labels.
File upload controls should read as precise file-selection rows: a compact action, selected-file metadata, and a strong focus halo. Avoid dashed drop-zone styling unless the interaction actually supports drag-and-drop.
Learner-facing upload copy should describe privacy and processing behavior, not storage provider names, unless the user needs that provider detail to complete setup or troubleshoot.
Creation copy should describe user-visible outcomes such as drafted skills, verification, and queueing before naming the AI provider. Provider names belong in setup, troubleshooting, privacy exclusions, or explicit actions where transparency helps the user decide.

### Cards And Panels

Surface separation: hairline.

Panels and cards should use a crisp, cool hairline border with restrained shadow. The border should be visible enough to define structure but not so strong that every panel feels boxed in. Avoid combining heavy borders and heavy shadows on the same surface.

Do not use subtle 3D card edges as part of the core design language. The app should stay flat, precise, and modern rather than skeuomorphic. The earlier dimensional-card experiment is retired unless deliberately reopened later.

Creation entry points should show product priority through layout. Source-backed creation is the primary path and may use an asymmetric grid or lightly cool panel treatment; manual authoring should read as a fallback path instead of another identical card in a stack.
The closed manual-draft fallback should be a ruled disclosure row, not a shadowed card. The full draft form can be a panel only after the user chooses to open that path.
Process helper strips should stay flatter than interactive panels. Use rules and text hierarchy for small workflow explanations; reserve bordered, shadowed panels for controls that actually collect input or show persistent records.

Setup and infrastructure-unavailable notices should also stay flat. Use a narrow ruled text block for database/auth/provider setup states instead of a centered shadowed card, since these states support recovery rather than presenting a primary product object.

### Tables And Lists

Data table treatment: rules.

Tables should favor scanability through clear horizontal rules, strong alignment, and restrained header styling. Prefer rules over zebra bands for the default table language because rules feel cleaner, more precise, and more scientific in this system. Numeric columns should use tabular figures. Avoid low-contrast table headers and excessive row chrome.
Ledger details should stay flat. Use inline labels and thin rules for secondary values such as correct answers; avoid boxed mini-surfaces inside table rows.
Panel header counts should be labeled, not bare numeric chips. Counts such as rows shown, active collections, recent reviews, or filtered results are metadata; render them as compact labeled facts so the number has context.

Navigable row titles should look like text-first links, not full-card buttons. Add a small, low-emphasis action cue such as Open when the row is primarily for recovery, browsing, or drilling into detail, so the affordance is visible without adding another button column.
Utility links in panel headers should usually be muted until hover or focus. Reserve persistent primary-blue text for active states, true calls to action, and controls whose urgency is already proven by the data.
Inline management rows should not turn every secondary action into a button. Keep the primary row action button-like, and render edit/archive/recovery disclosures as quieter text utilities until the user opens them.

Metric summaries should not default to equal four-card grids. Give the primary product state a wider or otherwise stronger position, then let supporting metrics read smaller and quieter.
The dashboard summary uses this rule explicitly: ready practice is the dominant panel, while active skills, recent accuracy, and recent reviews sit in a rule-divided support strip.
Dashboard queue availability messages are support notices, not feature cards. Render them as narrow ruled text blocks so a no-work state does not compete visually with the primary ready-practice summary.
Status surfaces should separate primary state from supporting inventory. Prefer a short summary strip for schedule/status facts and grouped rule-separated inventory rows over a large grid where every metric has identical weight.
Settings summaries follow the same pattern: the saved state appears first and supporting schedule constraints are grouped beside or beneath it. Do not repeat that state as a header badge when the summary immediately follows the panel title.
Settings secondary details should default to collapsed when the panel already exposes the action, state, and privacy-critical summary. Use the disclosure summary to name the hidden detail clearly.
Dashboard collection summaries should lead with ready-now count because it determines whether the scoped practice action is urgent; active skill count is supporting context.
Dashboard collection facts should stay flat inside collection rows. Use compact inline labels, tabular numbers, and a thin divider between related facts rather than boxed mini-stat cards inside the panel.
Collection management rows follow the same rule: ready-now count is the row-level action signal, while skill mix, sources, and update date stay as flat inline metadata.
When collection metadata wraps on narrow screens, drop inline dividers and rely on spacing; separators should never appear at the beginning of a wrapped fact.
Skills-library inventory strips should lead with ready practice inventory, then show verified, retired, and source counts as quieter supporting facts. If the strip wraps on narrow screens, remove vertical dividers rather than letting separators appear at the start of a new line.
Ordinary skill metadata such as collection, FSRS state, repetitions, lapses, and update dates should render as flat inline facts with light dividers. Reserve chip styling for actual statuses, tags, and selectable/meaningful categories.
Active skill detail inventory uses the same ready-first emphasis: the current choice queue gets the strongest position, while later recall modes remain supporting until the learner unlocks or fills them.
Exercise queue sections should also be ready-first. On wide skill-detail layouts, give the current choice refill path more width and stronger heading scale than exact-input and math refill paths. The ready count is the actionable inventory signal; running/full/locked labels are supporting state and should not receive equal layout weight. Keep these strips flat and inline rather than boxed into equal stat cells, and drop dividers in wrapped responsive layouts.
Source material metadata should lead with readiness/status before file mechanics. Type, size, and added date are supporting facts; they should not compete with whether the source can be trusted for generation or preview. Render stored-source facts as flat inline metadata beneath the source title, not boxed equal cells.
Source text previews are excerpts, not cards. Use light horizontal rules and a modest inset so the learner reads them as capped context instead of a separate stored document.
Uploaded-source processing rows use the same treatment: status copy and status chip carry the state; file mechanics and retry counts stay flat and inline.
Inline source, upload, and export facts may use dividers on one row, but wrapped mobile layouts should drop those dividers so no line begins with a separator.
Generation job and failed-source status inside library rows should be ruled strips, not tinted mini-cards. Keep counts inline and let error text use danger ink without wrapping the whole row in another surface.
Practice session metadata should be compact and explicitly labeled. Avoid floating unlabeled chips for mixed facts such as FSRS state and elapsed time; a small rule-separated status strip is clearer and quieter.
Practice report controls sit inside the review frame, so their wrapper should be a rule-separated disclosure block rather than a nested mini-card. The reason checkboxes remain visible controls; the panel itself should not compete with answer feedback.
Practice history is a ledger, not a stack of cards. On narrow screens, keep review rows rule-separated with explicit labels instead of wrapping each review in a mini-card.
Ledger transition marks such as due-date or FSRS-state arrows should stay typographic. Avoid turning every arrow into a bordered badge inside dense history rows.
Lifecycle controls should be rule-separated inside the skill panel, not nested in another rounded card. Danger copy and destructive buttons can carry the warning tone without tinting an entire inner container. Destructive checkbox confirmations should also be ruled rows; reserve full input boxes for exact-title confirmation fields.

Collection-scoped practice actions should reflect readiness. When a collection has due work, the row action may use the primary blue treatment and a specific label such as Practice due; collections without due work should keep a quieter secondary action so users do not read every row as equally urgent.

### Status And Feedback

Use semantic colors that harmonize with the system:

- Success: restrained green, not neon.
- Warning/accent: amber.
- Error: muted red, not default saturated red.
- Info: primary blue or primary-soft.

Feedback should be exact and encouraging, not overly warm or chatty.
Background-processing status should name the user-visible state and next action, not internal worker mechanics.

Message treatment: bounded signal.

Inline feedback, warnings, and system notes should use a full, quiet border paired with concise copy and a restrained semantic background. Avoid one-sided colored accent bars; they make rows and panels feel like generic template cards rather than considered product states.
When a message sits on a tinted semantic surface, its copy should use the matching semantic ink color. Avoid muted neutral text on colored message backgrounds; the result looks less intentional and weakens the state.
Inside a feedback panel, answer details should be flat and rule-separated rather than boxed again. The feedback panel is already the bounded signal.

Privacy and data-control explanations should be structured into explicit groups such as Included and Left out. Avoid asking users to parse a long paragraph to understand what data leaves or stays in the system.
Reminder privacy notes should sit as quiet rule-separated metadata under the form, not as tinted nested panels.
Data export summaries should lead with scope before mechanics. Format, access, and file exclusions are supporting facts.
Data export mechanics should render as flat inline facts, not boxed equal cells. The Included and Left out sections are the real explanatory content and should receive the heavier structure.
Data export disclosures should not use tinted nested summary boxes. Keep the disclosure control flat and let the included/excluded sections provide the visual grouping.

### Practice Prompt

The practice prompt is the core reading surface. Avoid redundant labels such as "Exercise" when the layout already makes the role clear; use small chips only for useful metadata such as difficulty.
Difficulty metadata should not become a full card header. Keep it as a quiet inline chip so the prompt remains the dominant object.
Do not put the prompt in a nested card inside the practice frame. Use type scale, spacing, and light horizontal rules to set it apart from the answer controls.

### Empty States

Empty state posture: technical-minimal.

Empty states should be specific, functional, and quiet. They should tell the user what is missing, show one useful next action, and avoid decorative illustrations for ordinary tool states. Use exact language and small structural details such as a checklist row, source requirement, or status line when it helps the user understand what comes next.
When an empty state appears inside an existing panel, use a rule-separated block rather than a bordered mini-card.
Practice empty-state queue checks follow this rule too: render the checklist as flat rows inside the practice frame, and keep secondary paths as muted utility links.
Prefer naming the missing object and the next control to use over generic "get started" copy.
When an empty state needs multiple destinations, separate them by action hierarchy: one primary recovery action, at most one secondary button, and additional paths as text-first utility links.

### Navigation

Navigation posture: responsive sidebar-to-tabs.

Use a sidebar on wide screen sizes where persistent navigation helps the app feel stable and tool-like. Collapse to tabs on narrower layouts, including mobile, where a sidebar would consume too much horizontal space. Avoid a rail as the default navigation pattern.
Desktop navigation should group related routes with spacing and quiet labels. Mobile navigation should suppress those labels and keep the links as compact tabs.
Mobile tabs should size to their labels and scroll horizontally instead of squeezing every route into equal widths.
Persistent navigation links should not masquerade as page-level primary actions. The Add skill destination uses a quiet blue utility treatment by default; it only takes the strongest create treatment when that route is current.

### Focus States

Focus state: halo.

Interactive controls should use a visible but restrained halo focus state. The halo should be easy to see against the cool canvas and white panels without looking glowy or decorative.

### Badges And Tags

Badge shape: chips.

Use chip-like badges for status, source labels, and small categorical metadata. Chips may use a radius slightly larger than the `5px` base radius when that improves legibility and makes the badge feel intentional, but they should stop short of full pills unless the chip is very small or semantically pill-like.

## Accessibility Rules

- Body text on white or panel surfaces must remain high contrast.
- White text on primary blue is acceptable.
- Do not use light-gray body copy.
- Interactive controls need visible focus states.
- Dynamic form feedback that appears after an action should use a status role so visual confirmation is also announced.
- Field-level validation copy should be programmatically associated with the affected control.
- Segmented controls and toggle-like button groups should expose selected state semantically, not only through color or background.
- Repeated row utilities with short visible labels, such as Edit or Archive, need accessible names that include the row object.
- Text should not overflow controls or cards at mobile widths.

## Anti-Slop Rules

- Do not use generic gray ramps without a cool LearnRecur tint.
- Do not rely on Mantine default styling as the final appearance.
- Do not use decorative gradient blobs, glow, or bokeh backgrounds.
- Do not use emoji as icons.
- Do not make every card, gap, radius, and shadow identical without intent.
- Do not create marketing-page whitespace inside app workflows.
- Do not use large display headings inside compact tool panels.
