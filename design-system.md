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
- Accent ink: `#6f4200`.

Use amber for review warnings, source gaps, and secondary attention. Do not drift this accent toward purple.

### Elevation

Current default: Soft.

- Shadow: `0 1px 2px hsl(219 48% 10% / 0.035), 0 8px 18px hsl(219 48% 10% / 0.045)`.
- Borders remain subtle unless a future surface-separation decision removes them.

Rationale: two subtle shadows feel more natural than one generic shadow. Avoid glow, heavy blur, and identical elevation on everything.

## Open Design Decisions

The design lab should only keep controls here when the system choice is still genuinely undecided. Current foundational surface, navigation, table, focus, badge, message, empty-state, and dimensional-surface choices are locked below.

When a choice is made, move it from this section into Locked Tokens or Component Patterns.

## Component Principles

### Buttons

Primary buttons use `#034cd5` with white text. Secondary buttons should use a light blue background and dark blue text. Default or ghost buttons should be white with a clear but quiet boundary.
Destructive secondary actions should use the danger-tinted surface with danger ink text; reserve brighter red for boundaries, status stripes, or compact emphasis.

Buttons should not be oversized. Use compact, tool-like button proportions.

Disclosure actions in management rows should look like intentional controls, not native browser summaries with default markers. Keep closed disclosures compact; let only the open inline form claim extra row width.

### Forms

Form controls should inherit the app's neutral system rather than browser defaults. Placeholder text uses the faint steel token with full opacity; disabled fields use a quiet panel fill and muted text so state is visible without washing out labels.

### Cards And Panels

Surface separation: hairline.

Panels and cards should use a crisp, cool hairline border with restrained shadow. The border should be visible enough to define structure but not so strong that every panel feels boxed in. Avoid combining heavy borders and heavy shadows on the same surface.

Do not use subtle 3D card edges as part of the core design language. The app should stay flat, precise, and modern rather than skeuomorphic. The earlier dimensional-card experiment is retired unless deliberately reopened later.

Creation entry points should show product priority through layout. Source-backed creation is the primary path and may use an asymmetric grid or lightly cool panel treatment; manual authoring should read as a fallback path instead of another identical card in a stack.

### Tables And Lists

Data table treatment: rules.

Tables should favor scanability through clear horizontal rules, strong alignment, and restrained header styling. Prefer rules over zebra bands for the default table language because rules feel cleaner, more precise, and more scientific in this system. Numeric columns should use tabular figures. Avoid low-contrast table headers and excessive row chrome.

Metric summaries should not default to equal four-card grids. Give the primary product state a wider or otherwise stronger position, then let supporting metrics read smaller and quieter.
Status surfaces should separate primary state from supporting inventory. Prefer a short summary strip for schedule/status facts and grouped rule-separated inventory rows over a large grid where every metric has identical weight.

### Status And Feedback

Use semantic colors that harmonize with the system:

- Success: restrained green, not neon.
- Warning/accent: amber.
- Error: muted red, not default saturated red.
- Info: primary blue or primary-soft.

Feedback should be exact and encouraging, not overly warm or chatty.

Message treatment: stripe.

Inline feedback, warnings, and system notes should use a slim colored stripe paired with concise copy. The stripe should identify the message type without turning the whole message into a loud colored panel.
When a message sits on a tinted semantic surface, its copy should use the matching semantic ink color. Avoid muted neutral text on colored message backgrounds; the result looks less intentional and weakens the state.

### Practice Prompt

The practice prompt is the core reading surface. Avoid redundant labels such as "Exercise" when the layout already makes the role clear; use small chips only for useful metadata such as difficulty.

### Empty States

Empty state posture: technical-minimal.

Empty states should be specific, functional, and quiet. They should tell the user what is missing, show one useful next action, and avoid decorative illustrations for ordinary tool states. Use exact language and small structural details such as a checklist row, source requirement, or status line when it helps the user understand what comes next.
Prefer naming the missing object and the next control to use over generic "get started" copy.

### Navigation

Navigation posture: responsive sidebar-to-tabs.

Use a sidebar on wide screen sizes where persistent navigation helps the app feel stable and tool-like. Collapse to tabs on narrower layouts, including mobile, where a sidebar would consume too much horizontal space. Avoid a rail as the default navigation pattern.
Desktop navigation should group related routes with spacing and quiet labels. Mobile navigation should suppress those labels and keep the links as compact tabs.

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
- Text should not overflow controls or cards at mobile widths.

## Anti-Slop Rules

- Do not use generic gray ramps without a cool LearnRecur tint.
- Do not rely on Mantine default styling as the final appearance.
- Do not use decorative gradient blobs, glow, or bokeh backgrounds.
- Do not use emoji as icons.
- Do not make every card, gap, radius, and shadow identical without intent.
- Do not create marketing-page whitespace inside app workflows.
- Do not use large display headings inside compact tool panels.
