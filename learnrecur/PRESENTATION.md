# Exercise presentation

The generator writes the exercise; the app styles it. New exercises separate a short `instruction`, the main `prompt`, and optional supporting `context`. For example, a por/para exercise can show its instruction above the Spanish sentence and its intended English meaning below it. Context stays visible before reveal, so it must not contain the answer or a hint that solves the skill.

The reviewer puts each part on its own line. Instructions are slightly smaller than the exercise, and context uses a smaller font with readable gray text in both themes. Revealing the answer shows it in bold, followed by a normal-weight explanation. This uses Anki's existing reveal and rating flow, with no model call during review.

## Preferences and card styling

Each skill can save `formatting_preferences`, up to 2,048 UTF-8 bytes, through the editor, creation and edit APIs, or import helper. An omitted or empty field uses the defaults. Preferences guide organization and wording; they cannot change the tested skill, remove necessary information, disclose the answer, or request HTML, CSS, or Markdown. Creation, editing, refills, and report replacements receive the saved preferences. Changing them creates a new revision and bank while preserving the native card and review history.

Generated fields are plain text. The renderer escapes markup and native media/typed-answer instructions. `prompt`, `answer`, and `explanation` remain required; `instruction` and `context` are optional strings. Each exercise field is limited to 8,192 UTF-8 bytes. Storage reservations include all five fields before generation can spend money.

Anki's note-type styling controls still set fonts, colors, and spacing. These selectors address the rendered parts: `.lr-instruction`, `.lr-prompt`, `.lr-context`, `.lr-answer`, and `.lr-explanation`. User CSS follows the default rules, so matching selectors can override them. Note-type CSS applies to skills using that note type; formatting preferences belong to an individual skill.

## Saved data and rollout

Banks keep format version 1 and the same seven native note fields. Optional exercise parts stay in the bank, and formatting preferences stay with its cached definition, including revision 1. The first exercise's static Prompt field includes its instruction and context for native Browse and template rendering. Refills preserve the original cursor fingerprint; reporting delivers the complete exercise. Collection packages retain these fields and preferences.

Existing cached text is not split, regenerated, or rewritten. The reviewer applies answer emphasis, but an old prompt with inline supporting text stays that way until a new revision replaces it. Saved generation jobs keep their instructions and response schema: versions 1–3 use three fields, and new version 4 jobs require five strings with empty optional parts when unused.

Update clients before enabling version 4 generation on the companion. Older clients reject snapshots with these new fields rather than silently discard them. Keep the matching LearnRecur sync server; no sync protocol or scheduler change is required. This slice does not deploy the backend, regenerate the daily trial, or spend money.

## Checks on October 12, 2026

All 371 library, 314 Qt, 325 companion, and 129 deployment tests pass. New cases cover preferences through creation, edits, clearing, private import plans, and all generation paths; frozen schemas through restart and retry; complete report delivery; maximum-size storage reservations; escaped rendering; refill cursors; undo; and current and legacy collection packages. Lint, formatting, Mac packaging, and signature verification pass.

The packaged Mac app used separate synthetic storage in `out/learnrecur/skill-formatting-20261012/`. The editor passed preference entry, expanded example fields, disabled loading controls, and automatic creation. Review passed separate instruction and context, bold answer, plain explanation, rating, undo, and offline reveal after restart. Two cards, their preferences and exercise parts, and zero final reviews survived the restart. The free fixture companion and temporary preview are closed. The check used authored exercises, so it does not establish that a real model follows the new guidance. The daily trial and Azure services are unchanged.

To resume the preview after closing it, launch the built app with `-b /Users/main/repos/learnrecur/out/learnrecur/skill-formatting-20261012/desktop -p "Formatting preview"`. For checks, run `./ninja check:pytest:pylib check:pytest:aqt` and `ANKI_TEST_MODE=1 PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python -m pytest learnrecur/companion/tests -q`.
