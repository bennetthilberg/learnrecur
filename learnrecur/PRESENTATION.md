# Exercise presentation

The generator writes the exercise; the app styles it. New exercises separate a short `instruction`, the main `prompt`, and optional supporting `context`. For example, a por/para exercise can show its instruction above the Spanish sentence and its intended English meaning below it. Context stays visible before reveal, so it must not contain the answer or a hint that solves the skill.

The reviewer puts each part on its own line. Instructions are slightly smaller than the exercise, and context uses a smaller font with readable gray text in both themes. Revealing the answer shows it in bold, followed by a normal-weight explanation. This uses Anki's existing reveal and rating flow, with no model call during review.

Fill-in-the-blank exercises can also list `blanks`, the text that fills each blank in the prompt, in order. Revealing one shows the prompt again with each fill in its blank, in bold over a light rule where the blank was, so the sentence reads as answered. The explanation follows below the line, and the answer isn't repeated. Exercises without `blanks`, including everything generated before instruction version 5, still show the bold answer below.

## Preferences and card styling

Each skill can save `formatting_preferences`, up to 2,048 UTF-8 bytes, through the editor, creation and edit APIs, or import helper. An omitted or empty field uses the defaults. Preferences guide organization and wording; they cannot change the tested skill, remove necessary information, disclose the answer, or request HTML, CSS, or Markdown. Creation, editing, refills, and report replacements receive the saved preferences. Changing them creates a new revision and bank while preserving the native card and review history.

Generated fields are plain text. The renderer escapes markup and native media/typed-answer instructions, fills included. `prompt`, `answer`, and `explanation` remain required; `instruction` and `context` are optional strings. Each of these fields is limited to 8,192 UTF-8 bytes. Storage reservations include all of them, plus the largest possible `blanks`, before generation can spend money.

`blanks` is optional. When present, it holds 1–16 strings, one for each blank in the prompt. A blank is any unbroken run of three or more underscores, so the six- and eight-underscore blanks the guidance asks for both count, and so do older three-underscore prompts. Each fill is a single line of at most 512 UTF-8 bytes. `answer` still holds the complete answer, so Browse, exports to Anki, and older apps don't depend on `blanks`.

A model can return fills that don't match the prompt, such as one fill for two blanks. The companion drops mismatched `blanks` when it publishes the batch, and that exercise shows its answer below as before. Rejecting the batch instead would throw away a paid result over presentation. The app treats a snapshot with mismatched `blanks` like any other malformed field and refuses it. If a mismatch still reaches a card, for example through a synced bank, review ignores the fills rather than filling some blanks and leaving others empty.

Anki's note-type styling controls still set fonts, colors, and spacing. These selectors address the rendered parts: `.lr-instruction`, `.lr-prompt`, `.lr-context`, `.lr-answer`, `.lr-fill` for each fill in a blank, and `.lr-explanation`. User CSS follows the default rules, so matching selectors can override them. Note-type CSS applies to skills using that note type; formatting preferences belong to an individual skill.

## Saved data and rollout

Banks keep format version 1 and the same seven native note fields. Optional exercise parts stay in the bank, and formatting preferences stay with its cached definition, including revision 1. The first exercise's static Prompt field includes its instruction and context for native Browse and template rendering. Refills preserve the original cursor fingerprint; reporting delivers the complete exercise. Collection packages retain these fields and preferences.

Existing cached text is not split, regenerated, or rewritten. The reviewer applies answer emphasis, but an old prompt with inline supporting text stays that way until a new revision replaces it. Saved generation jobs keep their instructions and response schema: versions 1–3 use three fields, version 4 requires five strings with empty optional parts when unused, and new version 5 jobs add `blanks`, an empty list when the prompt has no blanks. The companion stores `blanks` only when it's a nonempty match, so exercises without blanks look exactly as they did under version 4.

Update clients before enabling version 4 generation on the companion. Older clients reject snapshots with these new fields rather than silently discard them. Keep the matching LearnRecur sync server; no sync protocol or scheduler change is required. This slice does not deploy the backend, regenerate the daily trial, or spend money.

Version 5 needs the same order: update the Mac app, then the companion. An app from before version 5 refuses a snapshot that contains `blanks`. Most Spanish exercises have blanks, so after a companion-first upgrade, refills would stop reaching that app until it's updated. A version 5 app works with an older companion, which sends no `blanks`. The bank travels inside its note field, and sync compares it as opaque JSON, so `blanks` passes between clients without a sync server or protocol change. Reports send the whole exercise, fills included, so the companion can match it to what it published.

## Checks on October 12, 2026

All 371 library, 314 Qt, 325 companion, and 129 deployment tests pass. New cases cover preferences through creation, edits, clearing, private import plans, and all generation paths; frozen schemas through restart and retry; complete report delivery; maximum-size storage reservations; escaped rendering; refill cursors; undo; and current and legacy collection packages. Lint, formatting, Mac packaging, and signature verification pass.

The packaged Mac app used separate synthetic storage in `out/learnrecur/skill-formatting-20261012/`. The editor passed preference entry, expanded example fields, disabled loading controls, and automatic creation. Review passed separate instruction and context, bold answer, plain explanation, rating, undo, and offline reveal after restart. Two cards, their preferences and exercise parts, and zero final reviews survived the restart. The free fixture companion and temporary preview are closed. The check used authored exercises, so it does not establish that a real model follows the new guidance. The daily trial and Azure services are unchanged.

To resume the preview after closing it, launch the built app with `-b /Users/main/repos/learnrecur/out/learnrecur/skill-formatting-20261012/desktop -p "Formatting preview"`. For checks, run `./ninja check:pytest:pylib check:pytest:aqt` and `ANKI_TEST_MODE=1 PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python -m pytest learnrecur/companion/tests -q`.

## Checks on October 23, 2026

All 396 library, 380 Qt, 654 Rust, and 524 companion and deployment tests pass, including new cases for answers in blanks. They cover the version 5 schema beside versions 1–4, publication that keeps matching fills and drops the rest, rendering with one, two, and no blanks, a fill that completes part of a word, escaping, mismatches at import and in a stored bank, rating and report undo, refills, restart, reports with fills, and two-client sync. Synthetic one-blank, two-blank, and phrase cards were rendered with the real card HTML and Anki's reviewer CSS in light and dark mode. The packaged app and a real model weren't used for this check.
