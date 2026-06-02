# LearnRecur Design Prototype Reference

This folder contains a reference prototype generated during design exploration. It is here to help future AI agents understand the intended visual feel of LearnRecur UI work.

## Authority

`/Users/main/repos/learnrecur/design-system.md` is the source of truth for frontend design decisions.

This folder is secondary evidence only. Use it to understand the look and feel behind the design system: spacing rhythm, card structure, sidebar treatment, chips, message stripes, review cards, tables, modals, and empty states.

## What This Is

- A visual reference for the approved direction.
- A collection of screenshots, static preview cards, CSS tokens, and prototype UI files.
- A useful example of the level of restraint, density, contrast, and precision the app should aim for.

## What This Is Not

- Not production code.
- Not a required layout.
- Not a source of product requirements.
- Not a source of truth for logo, mascot, copy tone, routing, business logic, or data model.
- Not permission to copy the prototype implementation into the app.

## How Agents Should Use It

1. Read `design-system.md` first.
2. Read `AGENTS.md` for process and stack constraints.
3. Skim this folder when doing frontend work that needs visual grounding.
4. Prefer screenshots for fast visual orientation.
5. Inspect `colors_and_type.css` and `ui_kits/app/app.css` for token examples and surface treatments.
6. Treat `ui_kits/app/*.jsx` as visual reference markup only. Rebuild production UI with the project's real stack, Mantine conventions, TypeScript, and approved architecture.

## Contents

- `export-readme.md`: original exported design-system README from the prototype package.
- `colors_and_type.css`: exported token CSS; useful for comparing against `design-system.md`.
- `screenshots/`: most useful visual reference material.
- `preview/`: small static component/specimen cards.
- `ui_kits/app/`: interactive prototype source files, kept only as visual examples.

Some logo-only files from the original export were intentionally omitted. If `export-readme.md` mentions logo or brand-mark proposals, treat those notes as historical context only.

If this folder conflicts with `design-system.md`, the design-system document wins.
