# LearnRecur roadmap

This roadmap sets the order of work and what needs to pass before moving on. It leaves room to choose files, tools, and smaller tasks as we go. Pick a small task within the earliest unfinished milestone and update the progress notes after useful work.

[PRODUCT-SEED.md](learnrecur/PRODUCT-SEED.md) preserves the plan supplied on September 29, 2026. The decisions below include the user's later comments. Direct user instructions take precedence over that plan. Its embedded build prompt is background, not permission to start work.

## Product decisions

LearnRecur lets users study ordinary decks and practice skills in the same Mac app. It has its own collection and storage. Ordinary decks must transfer back to Anki, but users don't have to use official Anki alongside LearnRecur. We don't need shared storage or continuous sync with an existing AnkiWeb collection.

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

**Done when:** a clean checkout builds and launches on the Mac with a disposable LearnRecur profile, without touching the official Anki installation or collection. Record the commands and any packaging limits. A working source build does not by itself prove a packaged app is ready for daily use.

### 2. Check ordinary deck transfer

Use synthetic examples to check note types, HTML/CSS, media, review controls, and representative learning and review states. Create and edit an ordinary deck in LearnRecur, then export it into a disposable upstream Anki profile. Check scheduling information when the export includes it. Use copies for any optional real-deck checks.

**Done when:** the round trip preserves the tested content, templates, media, and included scheduling data. Ordinary review works without an AI connection. List what passed and what hasn't been checked.

### 3. Review one skill with cached exercises

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

- **Checked on September 30, 2026:** the checkout contains Anki 26.09.3 at `29bb700b951e3f0c0cb69b77c0180fc1fe33e6ba` with its full history of 12,541 commits. Both remotes point to the expected repositories. Application source, license, and submodule references are unchanged by this setup.
- **Prepared:** agent guidance, this roadmap, a copy of the product seed, companion and deployment directories, and repository documentation. All 32 inherited workflow jobs have repository conditions that keep them inactive here. Scheduled Dependabot version-update PRs are paused. Application CI hasn't been added.
- **Repository checks passed:** Git object connectivity and ancestry, unchanged application/build/license/submodule files, workflow YAML and original job conditions, documentation links, and rules that keep runtime files out of Git. These checks don't establish that the app works.
- **Repository review:** the user approved the setup and documentation on September 30, 2026, including a direct push to `main`. Use pull requests for later changes unless the user asks otherwise.
- **Not built or checked:** LearnRecur features, build and launch isolation, app identity and data-path changes, dependencies and submodules, hosting, generation, and deck tests. Milestone 1 is partly complete. Don't launch the fork with a real collection.
- **Decisions still needed:** companion tools and storage, recovery and undo behavior, and host selection. Choose these during the relevant milestones.
- **Recommended first PR:** build and run the Mac app with a LearnRecur development launcher and a disposable data directory. Check application identity, profile selection, and update behavior so it cannot use or update official Anki. Create and review a synthetic card, then quit and reopen to check that it saves in the separate directory. Record build/run commands and focused isolation checks. Full deck-transfer checks follow in milestone 2, then cached skill exercises in milestone 3. This setup does not authorize using the user's existing Anki profile.
