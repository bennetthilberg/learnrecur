# LearnRecur roadmap

This roadmap sets the order of work and the evidence needed to move forward. It does not prescribe every file, framework, or task. Agents should choose a narrow task within the earliest unfinished milestone and update the progress section after meaningful work.

The starting product description is [PRODUCT-SEED.md](learnrecur/PRODUCT-SEED.md), dated September 29, 2026. It preserves the supplied plan. The decisions below also record the user's subsequent clarifications. Follow direct user instructions when they differ from the seed document; its embedded build prompt is background, not permission to begin implementation.

## Product decisions

LearnRecur is a Mac app that can replace Anki for ordinary deck use and add skill practice in the same interface. It has its own collection and storage. Users can transfer ordinary decks back to Anki; they do not need to use official Anki alongside LearnRecur. Shared live storage and continuous sync with an existing AnkiWeb collection are not requirements.

Each skill is one scheduled Anki card with a bank of exercise variations. The user solves mentally, aloud, or on paper, reveals an answer and short explanation, and chooses Again, Hard, Good, or Easy. Anki handles scheduling and review history. Ordinary cards retain their existing behavior.

Use dedicated skill decks and ordinary decks in V1. Mixed decks remain a later possibility. Mac is the first client; Windows and mobile are later decisions. Keep Anki's minimal, functional UI and add only the controls and text the new features need.

Default development fixtures are synthetic ordinary cards and narrow Spanish grammar skills. Include synthetic HTML, media, and scheduling cases. A disposable copy of the user's Puerto Rico vocabulary deck is an optional compatibility example, not a required development dependency. Never change the user's actual Anki data or installation.

The initial backend proposal is a matching Anki sync server plus a companion service. Anki owns collection/media sync; the companion owns skill text and revisions, exercise banks, reports, generation jobs, and spend records. The client creates linked cards through native collection APIs and reconciles both stores. Prove that this works before expanding it.

Skill import starts with an authenticated, retry-safe batch API. A later project agent skill drafts narrow skills from text in the user's Codex session and previews them before import unless the user explicitly bypasses the preview. Store skill descriptions, not the source textbook passage. Generation uses a separately authorized API key held on the server.

The hosted V1 needs reproducible deployment, a $5/month hosting ceiling, and a separate configurable $5/month estimated generation limit. The Windows utility PC is the hosting fallback. Select a host after measuring requirements. Keep the old LearnRecur product intact; no state migration or shutdown is part of V1.

## Repository structure

Use one repository with Anki's existing source layout and Git ancestry. Keep desktop and sync-server code in their upstream paths. Add the companion API and worker under `learnrecur/companion/`, and deployment and backup configuration under `learnrecur/deploy/`. These components deploy independently; no nested desktop/server repositories are needed. Preserve upstream's existing translation and installer-template submodules.

The initial base is Anki 26.09.3. [UPSTREAM.md](learnrecur/UPSTREAM.md) records the exact commit and maintenance procedure. Upstream workflow jobs are inactive in LearnRecur, and scheduled Dependabot version-update PRs are paused. Add focused CI after establishing the build. Review inherited automation again whenever upstream changes.

## Milestone order

### 1. Establish and build the upstream base

Inspect Anki's current source, build/release process, sync protocol, and licensing. Choose a stable release, record its exact commit, and preserve its history and directory layout. Establish the LearnRecur application identity and isolated data paths. Review inherited workflows and update behavior before enabling them. Record reproducible Mac build/run commands and add focused CI as the build becomes understood.

**Done when:** a clean checkout can build and launch on the Mac with a disposable LearnRecur profile, without touching the official Anki installation or collection. Record the upstream pin, actual commands, and any packaging limitations. Do not claim a packaged daily driver from a source-run check alone.

### 2. Prove ordinary deck compatibility

Use synthetic fixtures to cover note types, HTML/CSS, media, ordinary review controls, and representative learning/review states. Include creating and editing an ordinary deck in LearnRecur. Test export back into a disposable upstream Anki profile; preserve scheduling where the export includes it. Use copies for any optional real-deck checks.

**Done when:** the ordinary deck round trip preserves the tested content, templates, media, and included scheduling data, and ordinary review works without an AI connection. List what was tested and what remains unverified.

### 3. Prove one skill card with cached variations

Add one linked skill card and a small manually supplied exercise bank. Present different variations on successive reviews while using Anki's native reveal and rating paths. Exercise Again and undo. Keep the selected prompt and its answer paired through reveal, redraw, and interruption. Document how exercise usage is reconciled with native review history.

**Done when:** one card retains one schedule and review log while its exercises vary; rating and undo leave both native history and local usage consistent. The slice works offline. This is the gate for proceeding with the proposed fork architecture.

### 4. Connect the hosted generation and sync loop

Add ordinary collection/media sync, authenticated skill import, skill revisions, structured exercise storage, bounded durable generation/refill jobs, and the local cache. Introduce cost reservation before running paid generation. Reconcile skill creation and usage with native cards after interruption. Use synthetic accounts and data for failure testing.

Start with the simplest deployment that meets measured requirements and can move between hosts. Include encrypted access, credential management, reboot recovery, complete backups, and restoration.

**Done when:** import retries create no duplicate skills/cards; interrupted generation creates no duplicate exercises; offline reviews survive reconnect; and a crash between the two sync paths recovers without losing reviews or duplicating cards. Restore collection/media, companion state, and pending jobs on another host. Record measured resource use and cost assumptions.

### 5. Complete the skill workflow

Add the minimal Skill editor, revision invalidation, report-and-skip, exhausted-bank behavior, generation status where needed, and complete LearnRecur export. Add the project import skill with preview by default and explicit preview bypass. Integrate these features into Anki's existing UI conventions.

**Done when:** reported exercises are excluded immediately, including offline; skipping never rates; revisions preserve card history; eligible older exercises can be reused; and having no eligible exercise leaves the card unrated without a loop. Budget exhaustion pauses generation while cached review continues. Import and full backup/export behavior have been demonstrated.

### 6. Evaluate usefulness and maintenance cost

Generate and manually inspect exercises for a small set of narrow Spanish grammar skills. Evaluate correctness, ambiguity, scope, comparable difficulty, variation, and explanations. Run repeatable study/recovery checks using disposable test collections. Measure cache exhaustion, actual API usage, hosting cost, and the effort of carrying an upstream update.

**Done when:** the working slice has evidence for both operational behavior and exercise quality, with remaining limitations stated. A personal daily-use trial can follow when the user chooses real study material; routine development must not depend on the user studying test fixtures. Do not call the app a proven daily driver until that real-use trial has happened.

Only then decide whether to add outside users, Windows/mobile clients, mixed decks, or a hosted paid plan. Set timelines from measured work rather than promising a release date before the fork proof.

## Current progress

- **Verified on September 30, 2026:** the local checkout contains Anki 26.09.3 at `29bb700b951e3f0c0cb69b77c0180fc1fe33e6ba` with its full ancestry (12,541 commits). `origin` and `upstream` point to the expected repositories. Anki's application source, license, and submodule references are unchanged by this preparation.
- **Completed:** agent guidance, ordered roadmap, portable copy of the product seed, companion/deployment directory scaffolding, and fork-specific repository documentation. All 32 inherited workflow jobs have repository guards; scheduled Dependabot version-update PRs are paused. No application CI is active yet.
- **Preparation checks passed:** Git object connectivity and upstream ancestry, unchanged application/build/license/submodule files, workflow YAML and preservation of original job conditions, local documentation links, agent entry points, and runtime-file ignore rules. These are repository checks, not application tests.
- **Publication:** preparation remains local for review. The existing GitHub repository was retained and is still empty; no push or repository deletion was performed.
- **Not started:** application changes, build or launch verification, application identity/data-path changes, dependency/submodule initialization, hosting, generation, or deck tests. Milestone 1 is partially complete; the fork is not ready to run against any real collection.
- **Open technical decisions:** companion implementation/storage, reconciliation and undo mechanics, and host selection. Resolve these through the relevant milestone instead of choosing the whole stack now.
- **Next action:** inspect the pinned `justfile`, Mac build requirements, and launch/data-path code. Establish a disposable profile path before any app launch, then build and verify isolation to complete milestone 1. Repository preparation does not authorize launching the unmodified app against the user's existing Anki profile.
