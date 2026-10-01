# LearnRecur roadmap

This roadmap sets the order of work and what needs to pass before moving on. It leaves room to choose files, tools, and smaller tasks as we go. Pick a small task within the earliest unfinished milestone and update the progress notes after useful work.

[PRODUCT-SEED.md](learnrecur/PRODUCT-SEED.md) preserves the plan supplied on September 29, 2026. The decisions below include the user's later comments. Direct user instructions take precedence over that plan. Its embedded build prompt is background, not permission to start work.

## Product decisions

LearnRecur lets users study ordinary decks and practice skills in the same Mac app. It has its own collection and storage. Ordinary decks must transfer back to Anki, but users don't have to use official Anki alongside LearnRecur. LearnRecur must not discover, load, copy, or migrate local Anki profiles, settings, decks, add-ons, or media. This is a production rule as well as a development rule. Ordinary deck transfer uses packages the user explicitly chooses.

Each skill is one scheduled Anki card with a bank of exercise variations. The user solves mentally, aloud, or on paper, reveals an answer and short explanation, and chooses Again, Hard, Good, or Easy. Anki's normal review code records the rating and sets the next review date. Ordinary cards keep their existing behavior.

Keep skill decks and ordinary decks separate within the app for V1. We can consider mixed decks later. Start with Mac and decide about Windows and mobile after the first version works. Keep Anki's minimal, functional UI and add only the controls and text the new features need.

Use synthetic ordinary cards and narrow Spanish grammar skills for development. Include examples with HTML, media, and different scheduling states. Never change the user's actual Anki data or installation.

Start with a matching Anki sync server and a companion service. Anki handles collection and media sync. The companion stores skill text and revisions, exercise banks, reports, generation jobs, and spend records. The client creates linked cards through native collection APIs and keeps skill data consistent between both services. Test recovery after interruption before building more features on this design.

Skill import starts with an authenticated batch API that can be retried without creating duplicates. Later, add a project agent skill that drafts narrow skills from text in the user's Codex session. It previews them before import unless the user explicitly skips the preview. Store skill descriptions, not the source textbook passage. Generation uses a separately authorized API key kept on the server.

Hosting must cost no more than $5/month out of pocket. AI generation has a separate configurable $5/month estimated out-of-pocket limit. Apply eligible student discounts, credits, promotions, and similar offers before checking either limit, and track when those offers expire. Measure resource needs before choosing a host. The Windows utility PC is the fallback. Leave the old LearnRecur product and its data intact.

## Repository structure

Keep one repository with Anki's source layout and Git history. Desktop and sync-server code stay in their upstream paths. Put the companion API and worker in `learnrecur/companion/`, and deployment and backup configuration in `learnrecur/deploy/`. They can deploy independently from the same repository. Preserve upstream's submodules for translations and installer templates.

The base is Anki 26.09.3. [UPSTREAM.md](learnrecur/UPSTREAM.md) records the exact commit and update steps. Upstream workflow jobs do not run in LearnRecur, and scheduled Dependabot version-update PRs are paused. Add the CI checks we need after establishing the build, and review inherited automation after each upstream update.

## Milestone order

### 1. Build and isolate the app

Inspect the pinned Anki source, build and release process, sync protocol, and license. Its stable release and exact commit are already recorded. Keep its history and directory layout. Set up LearnRecur's application identity and separate data paths. Check inherited workflows and update behavior before enabling them. Record the Mac build and run commands that actually work, then add focused CI.

**Done when:** a clean checkout builds and launches on the Mac with a disposable LearnRecur profile, without reading or changing local Anki data or the official installation. Production defaults must enforce the same separation. Record the commands and any packaging limits. A working source build does not by itself prove a packaged app is ready for daily use.

### 2. Check ordinary deck transfer

**Complete on September 30, 2026.** The synthetic deck passed native Mac export and import into an isolated upstream release, with matching content, templates, media, deck presets, scheduling, and review history. [ORDINARY-DECKS.md](learnrecur/ORDINARY-DECKS.md) records the evidence and remaining limits, including a Browse crash during automation.

Use synthetic examples to check note types, HTML/CSS, media, review controls, and representative learning and review states. Create and edit an ordinary deck in LearnRecur, then export it into a disposable upstream Anki profile. Check scheduling information when the export includes it. Use synthetic packages; do not pull examples from the user's local Anki data.

**Done when:** the round trip preserves the tested content, templates, media, and included scheduling data. Ordinary review works without an AI connection. List what passed and what hasn't been checked.

### 3. Review one skill with cached exercises

**Local proof checked on September 30, 2026.** One Spanish skill passed paired reveal, variation, Again, undo, restart, and review with outbound network access blocked. [CACHED-SKILL.md](learnrecur/CACHED-SKILL.md) records the storage choices, commands, and remaining limits.

Add one linked skill card and a small bank of manually supplied exercises. Show different variations on successive reviews through Anki's native reveal and rating code. Try Again and undo. Check that the displayed prompt stays paired with its answer through reveal, redraw, and interruption. Record how exercise-use data stays consistent with review history.

**Done when:** exercises vary while the card keeps one schedule and review log. Rating and undo leave review history and local exercise-use records consistent, including offline. Pass this check before moving on to the hosted loop.

### 4. Connect generation and sync

Add collection and media sync, authenticated skill import, skill revisions, exercise storage, generation and refill jobs, and the local cache. Jobs must survive restarts, avoid duplicates, and stop after bounded retries. Reserve estimated cost after discounts and credits before running paid generation. Check that linked skills, cards, and exercise-use records recover after interruption. Use synthetic accounts and data for failure tests.

Choose the simplest deployment that meets measured requirements and can move between hosts. Include encrypted access, credentials, restart recovery, complete backups, and restoration.

**Done when:** retrying imports creates no duplicate skills or cards, and interrupted generation creates no duplicate exercises. Offline reviews survive reconnect. A crash between the two sync paths recovers without losing reviews or duplicating cards. Restore the collection, media, companion data, and pending jobs on another host. Record resource use, expected out-of-pocket cost, and any credit expiry dates.

### 5. Complete the skill workflow

Add a small Skill editor, revision handling, report-and-skip, fallback when exercises run out, generation status where needed, and a complete LearnRecur export. Add the project import skill with preview by default and explicit preview bypass. Fit these features into Anki's existing UI.

**Done when:** reports exclude exercises immediately, including offline, and skipping never submits a rating. Editing a skill preserves its card history and retires unused exercises from the old revision. Older eligible exercises can be reused when needed. If none remain, the card stays unrated without repeating a rejected prompt. When the budget runs out, generation pauses and cached review continues. Check import and full backup/export behavior too.

### 6. Check exercise quality and maintenance effort

Generate exercises for a small set of narrow Spanish grammar skills and inspect them manually. Check correctness, ambiguity, scope, comparable difficulty, variation, and explanations. Run repeatable study and recovery checks in disposable collections. Measure how often exercises run out, actual API use, hosting cost after discounts and credits, and the work needed to merge an upstream update.

**Done when:** the working app has evidence for both its behavior and exercise quality, with remaining problems recorded. The user can choose real material for a daily-use trial later. Routine development must not depend on the user studying test examples, and we can't call the app ready for daily use before that trial.

After these milestones, decide whether to add outside users, Windows or mobile clients, mixed decks, or a paid hosting plan. Use measured progress to estimate dates.

## Current progress

- **Repository:** Anki 26.09.3 at `29bb700b951e3f0c0cb69b77c0180fc1fe33e6ba`, with upstream history, source layout, license, and submodules preserved. The user approved the initial direct push to `main`. Later changes use PRs.
- **Merged:** the user merged [the isolation PR](https://github.com/bennetthilberg/learnrecur/pull/1), [the ordinary-deck checks and icon PR](https://github.com/bennetthilberg/learnrecur/pull/2), and [the native export checks PR](https://github.com/bennetthilberg/learnrecur/pull/3) on September 30, 2026.
- **Checked on September 30, 2026:** the source build and Mac installer package succeed on Apple Silicon with macOS 27 and Xcode 27. The package contains `LearnRecur.app` with bundle ID `io.github.bennetthilberg.learnrecur.anki`. Its ad hoc signature passes verification. [MAC-DEVELOPMENT.md](learnrecur/MAC-DEVELOPMENT.md) has the commands and limits.
- **Isolation:** production defaults use `~/Library/Application Support/LearnRecur`. The development launcher uses `out/learnrecur/dev-data`. Anki's base-directory and single-instance settings are ignored. Existing Anki folders and unmarked nonempty folders are rejected. Profiles, collections, media, preferences, and add-on folders cannot follow links outside LearnRecur storage. Temporary files use a separate directory. The upstream desktop updater is disabled; sync requires a separately configured server.
- **Review fixes:** downgrade checks collection and related storage paths before opening them. The sync login asks for the configured server's credentials and has no AnkiWeb registration link. A separate HTTPS clock check retains the five-minute warning while updates stay disabled; unavailable network checks allow offline review. Non-Mac installer builds and packages are blocked until their installation paths are isolated.
- **Tests:** 184 Python library tests and 171 Qt tests passed, including 37 isolation, login, downgrade, and clock checks. Four installer tests confirm that Linux and Windows packaging stops before changing output or running build commands. Changed Python files pass lint and formatting checks; Rust formatting passes. The whole upstream tree has existing lint findings, so CI runs focused lint checks rather than requiring those unrelated fixes.
- **Mac review:** a synthetic Basic card showed its question and answer through the native reviewer. Choosing Good recorded one rating of 3 and moved the card into learning with one repetition. After quitting and reopening the packaged app, the deck, learning state, and studied-card count remained. Tools > Check for Updates was disabled, and Sync requested a LearnRecur server. No local Anki data was used.
- **Ordinary decks:** milestone 2 is complete. Eight package cases passed across current/legacy formats, exports with/without scheduling, and FSRS/older scheduling. They cover Basic, typed-answer, Cloze, custom HTML/CSS, media, note creation and edits, review undo, and persistence. The packaged Mac app also passed import, editing, typed-answer feedback, Cloze, styled-image, rating, and review-undo checks. Its native export dialog and Save dialog produced a synthetic package that upstream Anki 26.09.3 imported into a disposable profile. After restart, content, templates, media, deck presets, scheduling, and three review records matched. This final comparison used the downloaded upstream release's own library and independent Rust bridge. [ORDINARY-DECKS.md](learnrecur/ORDINARY-DECKS.md) records the app isolation, hashes, commands, and limits.
- **Repeatable upstream check:** `qt/tools/prepare_anki_compatibility_app.py` checks the pinned release hash and signatures, creates a guarded app copy in fresh synthetic storage, and rejects existing or symlinked paths. Its prepared app passed another native import and exact collection comparison. Seven guard tests passed. The commands are in `learnrecur/ORDINARY-DECKS.md`.
- **Icon:** the Mac bundle and Qt windows use a simple blue seahorse. The SVG, Qt PNG, and Mac ICNS are committed together, with a regeneration script. The rebuilt package and signature passed locally. The current suites pass 192 library tests and 178 Qt tests.
- **CI:** a LearnRecur Mac workflow builds the app and runs the Python and Qt suites plus focused lint. The ordinary-deck and icon code at `0ec554846` passed a [fresh-checkout run](https://github.com/bennetthilberg/learnrecur/actions/runs/36780279343). All 32 inherited workflow jobs remain restricted to upstream; scheduled Dependabot version-update PRs remain paused.
- **Cached skill:** one native card cycles through three manually supplied Spanish preterite exercises. Its bank is in a note field, and a small cursor commits with the native rating, schedule, and review log. Reveal does not consume an exercise; undo and redo restore the cursor with scheduling. Native Mac review passed Again, variation, undo, and restart. A process sandbox blocked external connections while cached review and ordinary typed-answer review passed. The current suites pass 222 library tests and 185 Qt tests, including the eight ordinary-deck round trips. [CACHED-SKILL.md](learnrecur/CACHED-SKILL.md) has the reproducible checks and limits.
- **Open Mac issue:** accessibility queries during Browse and deck navigation can crash Qt with exit code 139. Both LearnRecur and the private upstream release reach `__AXCopyAttributeValueForHierarchy` in the faulting stack. The cause remains unresolved. Normal skill review passed; the offline automation retry used temporary Qt flags. Investigate this separately before claiming the Mac app is dependable.
- **Not checked:** filtered decks, audio/video, add-ons, conflicting note-type names, older Anki releases, collection-package restoration, notarization, distribution on other Macs, production sync-server storage and deployment, skill editing and reporting, hosted skill storage, hosting, and generation. The desktop's legacy `--syncserver` mode is disabled until separate server setup is ready. This development package isn't a daily-use release.
- **Next:** review and merge the cached-skill PR. Investigate the Qt accessibility crash in a separate fix. Then begin milestone 4 with a local authenticated skill-import path and stable links to native cards; check retry and interruption before adding paid generation or hosting.
