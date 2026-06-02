# LearnRecur — App UI Kit

A high-fidelity, interactive recreation of the LearnRecur web app, built on the design
system tokens in [`../../colors_and_type.css`](../../colors_and_type.css). It is a
**visual + interaction reference**, not production code — logic is mocked (in-memory
state, a fake scheduler), but the look, states, and flows are faithful to the brief.

> No source codebase or Figma was provided. This kit is an interpretation of the written
> design brief. Treat it as a strong starting point, not a pixel match to a shipped app.

## Run it

Open `index.html`. React + Babel are loaded from CDN; icons from
[Lucide](https://lucide.dev). Lexend loads via Google Fonts.

## Try the flow

- **Review** (default) — the core practice loop, Khan-style. Each due item is an
  **exercise**: multiple choice or short free response. Answer it, get **instant
  correct/incorrect feedback** with the explanation (and source if present). On a
  correct answer a **difficulty override** appears — a segmented *Hard / Good / Easy*
  control defaulting to **Good** — then *Continue*. A miss reveals the answer and is
  rescheduled sooner. Keys: **1–4** pick a choice, **Enter** checks then continues.
- **Add item** — opens a dialog with a live "no source" warning stripe. Saved items
  appear at the top of *All items* and flash a confirmation.
- **All items** — the rules-style data table: status chips, tabular numeric columns,
  amber source-gap markers. Search + filter by *Due* / *No source*.
- **Stats** — retention, streak, and a 7-day due-forecast bar chart.
- **Sources / Settings** — intentionally stubbed with an honest "not in this kit" panel.

Resize narrow (< 720px) to see the sidebar collapse to a top tab bar.

## Files

| File | Role |
|---|---|
| `index.html` | Entry point — loads React, Babel, Lucide, and the component scripts. |
| `app.css` | Imports design tokens; defines shell layout + shared primitive classes (`.btn`, `.chip`, `.field`, `.panel`). |
| `ui.jsx` | Shared primitives (`Icon`, `Chip`, `Message`, `Modal`) + mock data (`SEED_ITEMS`). |
| `Sidebar.jsx` | Responsive sidebar + tab bar navigation. |
| `ReviewScreen.jsx` | The flashcard review loop + grade controls + caught-up state. |
| `ItemsScreen.jsx` | All-items data table with search/filter. |
| `StatsScreen.jsx` | Stat cards + due-forecast chart + stubbed-route `Placeholder`. |
| `AddItemDialog.jsx` | Add-item modal with live source warning. |
| `App.jsx` | Shell: state, routing, header, toast, dialog wiring. |

## Component coverage

App shell · responsive sidebar/tab nav · sticky header · primary/secondary/ghost
buttons · text/textarea/select fields with halo focus · multiple-choice options &
free-response input with correct/incorrect states · segmented difficulty override ·
status & tag chips · message stripes (4 tones) · modal dialog with scrim · rules data
table with tabular figures · progress bar · stat cards · bar chart · exercise card ·
empty/caught-up state · toast.

## Conventions when extending

- Pull every color, radius, shadow, and font size from the CSS variables — don't
  hard-code new values.
- Sentence case for all UI text. Address the user as "you". No emoji.
- Icons: Lucide, line style, `currentColor`. Add new ones by `data-lucide` name.
- New global components must `Object.assign(window, { ... })` at the end of their file
  (Babel scripts don't share scope) and use a uniquely-named styles object if any.
