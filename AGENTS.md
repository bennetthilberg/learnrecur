# Working on LearnRecur

LearnRecur is a Mac-first fork of Anki for keeping learned skills fresh through spaced repetition. It supports ordinary Anki decks and adds skill cards with banks of AI-generated exercises.

Anki works well for vocabulary, facts, and small recall prompts. A fixed exercise is less reliable for testing a skill: after seeing the same math problem or Spanish fill-in-the-blank repeatedly, a learner can memorize the context and answer without practicing how to apply the rule to a new example.

LearnRecur schedules the skill and varies the exercise. AI generates moderately different examples that test precisely the same rule or procedure, within the same scope and at comparable difficulty. For example, a skill about regular Spanish -ar verbs in the first-person preterite might ask about *hablar* in one sentence and *trabajar* in another. The words and context change; the target skill does not. Variation should require applying the skill again, not just recognizing a previous answer or tackling unrelated material.

The goal is short, trustworthy practice of material the learner has already learned in a class, book, or elsewhere. Exercises must be correct, clear, fair, and narrowly matched to the skill. Spanish grammar is an initial test domain; the same model should support math procedures and other well-defined skills.

The app keeps Anki's review flow and scheduling controls. The user solves an exercise, reveals the answer and a brief explanation, and rates their own recall. Anki owns scheduling and review history. Generation happens in the background, and review uses cached exercises. Ordinary decks remain fully supported, so the user can study vocabulary and practice skills in one app.

Read [ROADMAP.md](ROADMAP.md) before starting work. It records product decisions, milestone order, verified progress, and the next task. This file describes how to work; keep the implementation plan in the roadmap.

## Repository structure

- This is one Git repository derived from `ankitects/anki`, with its upstream history and directory layout preserved. `origin` is `bennetthilberg/learnrecur`; `upstream` is `ankitects/anki`.
- Keep desktop changes in the existing `qt/`, `ts/`, `pylib/`, `rslib/`, and `proto/` paths. The standalone sync-server executable is in `rslib/sync/`; its shared implementation is in `rslib/src/sync/`. There is no separate desktop or sync-server subrepository.
- Put the companion API and generation worker in `learnrecur/companion/`, and deployment, backup, and host-migration configuration in `learnrecur/deploy/`. Separate components can build and deploy independently without separate Git repositories.
- [learnrecur/UPSTREAM.md](learnrecur/UPSTREAM.md) records the exact upstream pin and update procedure. Preserve Anki's existing translation and installer-template submodules; they are upstream dependencies, not additional LearnRecur forks.
- Inherited workflow jobs are restricted to `ankitects/anki` and do not run here. Adapt or add focused LearnRecur workflows deliberately. Recheck workflow guards, publishing targets, agent entry points, and dependency-update configuration after each upstream merge.
- `AGENTS.md` is the project guidance; `CLAUDE.md` directs other agents here. Upstream launch instructions must not bypass the separate-profile requirement. Build and launch isolation have not yet been verified.

## Protect the user's existing data

- Never update, delete, move, migrate, or replace the user's current Anki decks, collection, media, backups, profile configuration, or official Anki installation during development. This includes `~/Library/Application Support/Anki2` and any other existing Anki data location.
- Read-only inspection and copying for examples are allowed. Use a consistent read-only snapshot when needed; do not open the original collection through code that might write to it. Run imports, exports, reviews, migrations, and tests only against disposable copies or synthetic collections.
- Default to synthetic fixtures. The user's Puerto Rico vocabulary deck may be copied for optional HTML/media compatibility checks. Never move the original or commit personal deck data to the repository.
- Give LearnRecur its own application identity, data directory, profiles, sync storage, and update behavior. A development launch must never fall back to the user's official Anki profile or update the official app.
- Leave `/Users/main/repos/learnrecur-old` and its deployed services, database, uploads, and configuration intact. Its web stack and repository policies do not govern this fork. Preserve unrelated work in any checkout.

## Product boundaries

- Ordinary decks are a complete supported use of LearnRecur: create, import, edit, review, and export them without requiring the official Anki app or AI services. Ordinary decks must be transferable back to Anki, including templates and media, and scheduling information when the chosen export format includes it.
- LearnRecur owns a separate collection. Compatibility means ordinary deck transfer, not shared storage or automatic synchronization with the user's existing Anki collection or AnkiWeb account.
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
- Be concise and straightforward. Use active voice, familiar words, short sentences, and concrete statements. Remove filler, hype, repetition, and unnecessary headings. Preserve technical precision and state uncertainty directly.
- Lead with the change or finding. Include the reason, relevant validation, and limitations when they help the reader assess it. Do not narrate routine work or add a template section that has nothing useful to say.
- Use sentence case for documentation titles and headings, descriptive link text, and code formatting for identifiers and commands. Keep commit subjects short, lowercase, and specific.

### User-facing writing

- Keep all copy concise and straightforward, with a natural tone where helpful. Use familiar Anki terms. Avoid promotional language, jargon, and extra text added merely to make a screen feel finished.
- Labels, messages, answers, and explanations should contain only what the user needs to act or understand. Brevity must not hide a necessary instruction, error recovery step, or explanation of an answer.

## Engineering and verification

- Preserve Anki's upstream Git ancestry, directory layout, license, and notices. Pin a release and exact commit; keep fork changes small and easy to carry forward. Inspect inherited automation before enabling it.
- Start with Anki's matching standalone sync server. Prefer a separate companion service for skills, exercises, reports, and generation jobs. Treat this split as a hypothesis to prove, not an excuse to ignore reconciliation failures.
- Use normal collection APIs to create or change native notes/cards. A worker must not write directly into a collection file that a client or sync server owns.
- Make import, reconciliation, and generation retries safe. Use stable identities, durable job state, bounded retries, and explicit recovery after interruption. Test crash, disconnect, restart, revision, and undo cases where relevant.
- Keep credentials and provider keys out of source control, card content, exports, and desktop profiles. Never commit real collections, media, or logs containing private content. Use synthetic test data in public CI.
- Hosting has a $5/month total ceiling; AI generation has a separate configurable $5/month estimated-use limit. Obtain authorization before incurring costs. Reserve estimated generation cost before jobs start and record actual usage; an estimate is not a guaranteed billing cap.
- Use focused tests for the changed behavior and manual checks of the actual Mac review flow. Validate ordinary deck round trips, not just successful imports. Inspect real generated exercises for correctness, ambiguity, scope, and difficulty; schema checks do not establish answer quality.
- Verify backup restoration on a different host before claiming the backend is dependable. Ordinary Anki exports do not necessarily contain the exercise bank; a complete LearnRecur backup must cover both stores and job state.
- Work on the earliest unfinished roadmap milestone. Choose a narrow next task that produces observable evidence; avoid speculative abstractions and unrelated features. Update the roadmap at meaningful checkpoints with verified results, limitations, and an exact next action. Do not mark work complete from tests that omit its real user path.
