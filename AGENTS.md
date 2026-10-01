# Working on LearnRecur

LearnRecur is a Mac-first fork of Anki that helps learners keep skills fresh through spaced repetition. It supports ordinary Anki decks and adds skill cards with banks of AI-generated exercises.

Anki works well for vocabulary, facts, and small recall prompts. But after seeing the same math problem or Spanish fill-in-the-blank repeatedly, a learner can memorize its context and answer. They may get the card right without being able to apply the rule to a new example.

LearnRecur uses AI to generate moderately different exercises for each scheduled skill. Each exercise must test the same rule or procedure at a similar difficulty. For example, practice with regular Spanish -ar verbs in the first-person preterite might ask about *hablar* in one sentence and *trabajar* in another. Both require the learner to form the same tense, but they have to work out the answer each time. An exercise should stay within the skill's boundaries and avoid introducing unrelated material.

The goal is short, trustworthy practice of material the learner has already learned in a class, book, or elsewhere. Exercises must be correct, clear, fair, and closely matched to the skill. We'll test Spanish grammar first, but the design must also support math procedures and other well-defined skills.

The app keeps Anki's review flow and scheduling controls. The user solves an exercise, reveals the answer and a brief explanation, and rates their own recall. Their rating goes through Anki's normal review code, which sets the next review date and records the result. Exercises are generated in the background and saved locally for review. Users can also study ordinary decks, so vocabulary and skill practice fit in the same app.

Read [ROADMAP.md](ROADMAP.md) before starting work. It records the product decisions, order of work, what has been checked, and the next task. Keep implementation plans there and working rules here.

## Repository structure

- This is one Git repository based on `ankitects/anki`, with its history and directory layout preserved. `origin` is `bennetthilberg/learnrecur`; `upstream` is `ankitects/anki`.
- Keep desktop changes in the existing `qt/`, `ts/`, `pylib/`, `rslib/`, and `proto/` paths. The standalone sync-server executable is in `rslib/sync/`; its shared implementation is in `rslib/src/sync/`. There is no separate desktop or sync-server subrepository.
- Put the companion API and generation worker in `learnrecur/companion/`. Put configuration for hosting, backups, and moving between hosts in `learnrecur/deploy/`. These components can build and deploy independently from the same repository.
- For GitHub operations, explicitly target `bennetthilberg/learnrecur` with an explicit repository argument so upstream cannot be selected by mistake.
- [learnrecur/UPSTREAM.md](learnrecur/UPSTREAM.md) records the exact upstream commit and how to update it. Preserve Anki's existing submodules for translations and installer templates.
- Inherited workflow jobs are restricted to `ankitects/anki` and do not run here. Add or adapt workflows for the checks LearnRecur needs. After each upstream merge, check job conditions, publishing targets, agent instructions, and dependency-update settings.

## Protect the user's existing data

- Never update, delete, move, migrate, or replace the user's current Anki decks, collection, media, backups, profile configuration, or official Anki installation during development. This includes `~/Library/Application Support/Anki2` and any other existing Anki data location.
- Do not discover, read, copy, import, or migrate the user's local Anki data or settings into LearnRecur. This applies to development and production. Use synthetic data for development and tests. Ordinary deck transfer uses packages the user explicitly chooses, not their local Anki profiles.
- Give LearnRecur its own application identity, data directory, profiles, temporary files, sync storage, and update behavior. Every launch must use LearnRecur storage, even without a development launcher. Ignore Anki's data-path settings and reject existing Anki folders. Never update the official app.
- Leave `/Users/main/repos/learnrecur-old` and its deployed services, database, uploads, and configuration intact. Its web stack and repository policies do not govern this fork. Preserve unrelated work in any checkout.

## Product boundaries

- Users must be able to create, import, edit, review, and export ordinary decks without the official Anki app or AI services. Those decks must transfer back to Anki with their templates and media, plus scheduling information when the chosen export format includes it.
- LearnRecur stores its own collection. Support ordinary deck transfer without sharing storage or automatically syncing with the user's existing Anki collection or AnkiWeb account.
- Ordinary decks and skill decks coexist in the same app. Keep them separate within decks for V1, as described in the seed plan; do not make future mixed decks require a different scheduler.
- Each skill has one native Anki card and one schedule. Exercises vary within that skill's stated boundaries; ratings must not silently change the skill or its difficulty.
- Use Anki's native reveal, answer, undo, scheduler, deck options, and review history paths. No required answer input or automatic grading for skill reviews. Preserve ordinary note types' native behavior, including typed-answer cards.
- Cache exercises before review. Revealing and rating must work offline without a model call. Reuse older eligible exercises when needed; never reuse reported or retired items. If none are eligible, leave the card unrated and give a way to leave it.
- Report-and-skip excludes an exercise and requests another variation without submitting a rating or changing the schedule. Keep exercise usage consistent with native review undo.
- Skill edits create description revisions and retire unused exercises from the old revision while preserving the card's review history.
- V1 excludes Windows/mobile clients, public signup, billing, a website, teaching lessons, and hosted textbook ingestion. Preserve portability without implementing those features early.

## UI and writing

- Keep the app looking and behaving like Anki, with a few integrated additions. Prefer Anki's existing Qt widgets, menus, dialogs, review controls, shortcuts, and layout conventions.
- Keep UI text to the minimum needed to use a feature. Do not add decorative eyebrow text, redundant subheadings, explanatory subtitles, reassurance copy, or repeated labels. Every added line should help the user make a decision or take an action.
- Prefer functional native controls over dashboard layouts, decorative panels, or a redesign. Preserve keyboard focus, accessibility, dark mode, and normal window resizing.
- Keep answers and exercise explanations clear and brief. Put developer details in logs or documentation unless they help the user resolve a specific problem.

### Developer-facing writing

- Follow the [Google developer documentation style guide](https://developers.google.com/style) for all developer-facing prose: repository documentation, PR titles and descriptions, commit messages, issues, code comments, changelogs, and release notes.
- Also follow Paul Graham's [Write Like You Talk](https://paulgraham.com/talk.html). Explain the idea as you would to a friend who knows how to program but hasn't worked on this task. Use ordinary words and natural sentences, including when the subject is difficult.
- Read a draft aloud, or imagine saying it aloud. Rewrite anything you wouldn't say in conversation. If a whole passage sounds stiff, explain the idea without looking at it and use that explanation as the new draft.
- Be concise and straightforward. Use active voice and concrete statements. Remove filler, hype, repetition, and unnecessary headings. Keep technical terms when they make the meaning more precise, and explain them when needed. State uncertainty directly.
- Start with what changed or what you found. Explain why, how you checked it, and any limits the reader needs to know. Skip routine work logs and empty template sections.
- Use sentence case for documentation titles and headings, descriptive link text, and code formatting for identifiers and commands. Keep commit subjects short, lowercase, and specific.

### User-facing writing

- Follow Graham's [Write Like You Talk](https://paulgraham.com/talk.html) here too. Use words you'd say to someone using the app, and check that messages sound natural aloud. Keep copy concise and use familiar Anki terms. Avoid promotional language, jargon, and extra text added merely to make a screen feel finished.
- Labels, messages, answers, and explanations should contain only what the user needs to act or understand. Brevity must not hide a necessary instruction, error recovery step, or explanation of an answer.

## Engineering and verification

- Use pull requests for changes after this initial repository setup, unless the user explicitly asks for a direct push.
- Run automatic code and security reviews when a PR is opened. If an initial review doesn't start, request it once. Address feedback in one batch, or at most two passes per PR, and run the relevant checks. Do not request repeat reviews after fixing the initial feedback or configure reviews on every push. Hand the PR back to the user instead of repeating the fix-and-review cycle.
- Preserve Anki's upstream Git ancestry, directory layout, license, and notices. Pin a release and exact commit; keep fork changes small and easy to carry forward. Inspect inherited automation before enabling it.
- Start with Anki's matching standalone sync server and a separate companion service for skills, exercises, reports, and generation jobs. Test whether the client can keep their data consistent after a crash or disconnect before expanding this design.
- Use normal collection APIs to create or change native notes/cards. A worker must not write directly into a collection file managed by a client or sync server.
- Make import, reconciliation, and generation retries safe. Use stable identities, durable job state, bounded retries, and explicit recovery after interruption. Test crash, disconnect, restart, revision, and undo cases where relevant.
- Keep credentials and provider keys out of source control, card content, exports, and desktop profiles. Never commit real collections, media, or logs containing private content. Use synthetic test data in public CI.
- Hosting has a $5/month total out-of-pocket limit. AI generation has a separate configurable $5/month estimated out-of-pocket limit. Apply eligible student discounts, credits, promotions, and similar offers before checking either limit. Track available credits and expiry dates so the limits still apply when offers end. Get authorization before spending money.
- Reserve the estimated generation cost after discounts and credits before a job starts, and record the provider's actual usage. An app-side estimate cannot guarantee a provider billing cap.
- Use focused tests for the changed behavior and manual checks of the actual Mac review flow. Validate ordinary deck round trips, not just successful imports. Inspect real generated exercises for correctness, ambiguity, scope, and difficulty; schema checks do not establish answer quality.
- Verify backup restoration on a different host before claiming the backend is dependable. Ordinary Anki exports do not necessarily contain the exercise bank; a complete LearnRecur backup must cover both stores and job state.
- Work on the earliest unfinished roadmap milestone. Pick a small task with a result you can check. Avoid abstractions for features we haven't built and changes unrelated to the task. At useful checkpoints, record what works, what hasn't been checked, and the exact next action. Test the real user path before marking a feature complete.
