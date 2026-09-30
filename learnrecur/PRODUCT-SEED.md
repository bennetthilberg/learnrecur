# LearnRecur: an Anki fork for practicing skills

**Project seed — September 29, 2026.** This is the plan for a new repository, not a change to the current LearnRecur app. It records product decisions; the implementation details below are starting choices to prove in a small working slice.

## The idea

LearnRecur should feel like Anki. Ordinary decks still work as they do in Anki. A LearnRecur deck adds a new kind of review item: a **skill** with one Anki card and one schedule. Each time that card comes due, the app shows a short exercise drawn from a bank of variations of that skill. The variation changes; the thing being remembered does not.

This is for keeping already-learned material available and practicing its use. It is not a course, a textbook reader, or a tutor that teaches a topic from scratch. Spanish grammar and conjugation are the first proving ground, but no part of the model should require Spanish. A narrow math procedure or classification rule should work too.

The fork is a serious product choice, not an add-on that sends a request from card JavaScript. The point is to keep Anki's mature review flow, scheduling, deck tools, and import behavior while making skills, exercise banks, and background generation native parts of the app. Anki's core is Rust and Python, and its desktop UI combines Qt with web code, so this will require work in several parts of the codebase. [Anki architecture](https://github.com/ankitects/anki/blob/main/docs/architecture.md).

**Technical judgment:** the idea is feasible and well matched to a personal daily-use tool, but it is not an easy fork. Showing a varied exercise on a native card is the first challenge; making that survive sync, offline study, Anki upgrades, and later mobile clients is the lasting cost. The first slice below is a real go/no-go test, not a formality.

## What V1 is

V1 has one user on one Mac, plus a hosted generation and sync backend from day one. The fork runs with its own profile so trying it does not disturb the user's official Anki collection. It can import existing ordinary Anki decks, including learning progress where the export contains it, and review them normally. Anki's packaged-deck import supports scheduling information; the actual import path must be tested against the user's decks before relying on it. [Anki packaged-deck manual](https://docs.ankiweb.net/importing/packaged-decks.html).

LearnRecur skills live in dedicated decks for V1. Ordinary cards and skill cards can coexist in the same app and collection, but the UI prevents placing both kinds in one deck for now. This is a V1 guard, not a separate scheduling architecture: each skill still maps to a normal Anki card. Later, lifting the deck guard should make mixed decks possible without migrating every review.

There is no mobile client, public signup, billing, automatic answer grading, typed-answer requirement, lesson flow, or hosted textbook ingestion in V1. There is also no special approval state for imported skills: a skill exists as soon as its import succeeds. Anki's normal new-card limits and suspend controls determine when it enters study. Waiting for a first usable exercise is an operational readiness condition, not an editorial approval queue.

## A day in the app

The user opens the familiar Anki deck list, selects a deck, and sees a short prompt. For example, a skill might be “form regular Spanish -ar verbs in the first-person preterite.” One review asks for *hablar* in a short sentence; the next can ask for *trabajar* in a different sentence. It should not silently change to irregular stems, another tense, or a harder skill because the previous review was rated Easy.

The user works out the answer mentally, aloud, or on paper. Space reveals the answer and a brief explanation. The user then chooses Anki's ordinary 1–4 ratings: Again, Hard, Good, or Easy. The fork sends that rating through Anki's native answer path, so FSRS, due dates, review history, and ordinary deck behavior remain Anki's responsibility. [Anki studying manual](https://docs.ankiweb.net/studying.html); [Anki deck options and FSRS](https://docs.ankiweb.net/deck-options.html).

If the answer was wrong, the explanation appears immediately. When that skill comes back through Anki's learning or relearning steps, it should show a **fresh, closely matched variation**. If unused exercises are exhausted, an older one may be reused rather than interrupting study. That fallback should be rare because the server refills a generous but bounded bank ahead of demand.

“Report and skip” handles a flawed or unfair exercise. It immediately excludes that exercise from future selection, records a report for later inspection, and shows another cached variation of the same due skill. It does **not** submit a rating or change the skill's schedule. If no alternative is cached, the app should say so and let the user leave the card unrated until new exercises arrive; it must not loop back to the reported prompt.

The choice to vary examples is supported by retrieval-practice research showing better transfer to new examples from varied practice than repeated practice of one example. Research also found that explanatory feedback helped with new inference questions more than answer-only feedback. These studies support the direction, but they do not directly establish the ideal after-Again rule for this exact product; that rule needs learner testing. [Butler et al., 2017](https://scholars.duke.edu/publication/1292911); [Butler et al., 2013](https://profiles.wustl.edu/en/publications/explanation-feedback-is-better-than-correct-answer-feedback-for-p/).

## How skills get into LearnRecur

A V1 skill is editable **text**, not a stored textbook page. Its description says what rule or method the user already learned, which prerequisite knowledge may be assumed, what a fair exercise may ask, and what is out of scope. A title, description, examples, and constraints can be separate text fields if that makes editing clearer. One broad textbook section should usually become several narrow scheduled skills.

The first import path is Codex. The user gives Codex a textbook passage in their own session. A project-provided agent `SKILL.md` tells Codex how to identify narrow skills, describe their boundaries, and show a readable preview. **By default Codex waits for user confirmation before writing any skills.** If the user explicitly says to skip the preview, it can submit directly. The documented, authenticated batch API is the durable import surface; a thin MCP interface can wrap it later if that improves the experience. The API must make retries safe, so a repeated submission does not create duplicate cards. The textbook passage itself is not uploaded to or retained by LearnRecur in V1.

This split lets skill drafting use the user's existing Codex session. It does not assume that an MCP connection or a consumer ChatGPT subscription grants the hosted worker inference credits. The worker uses a separate, user-supplied model API key for exercise generation. The key stays on the server, not in card content or the desktop profile.

The app also offers a small Skill editor inside the Anki-style UI. The user can correct the description directly. Editing a skill creates a new description revision. Unused exercises from the old revision should be retired and refilled; review history stays on the same card unless the user deliberately decides the edit changed the skill so much that it needs a new card. For V1, editing may require a connection to the server; offline **review** is the required offline behavior.

## Technical shape to prove

Use a pinned Anki release as the upstream base and keep the fork diff small enough to carry upstream updates. Do not copy the old LearnRecur web stack or its schema into this project by default. The old product's Next.js, Clerk, Prisma, and deterministic grading rules describe a different implementation. The fork should fit Anki's own architecture and keep ordinary cards untouched.

The proposed split is:

| Part | Owns |
| --- | --- |
| Anki collection and native sync | Decks, ordinary cards, one card per skill, ratings, FSRS state, review history, media |
| LearnRecur companion service | Skill text and revisions, import API, generated exercises, reports, provider jobs, spend accounting |
| Mac fork | Anki UI, Skill editor, cached exercises, review presentation, offline usage log, reconciliation between the two services |

Anki provides a self-hosted sync server, but it is a sync server for Anki collections and media, not a full self-hosted AnkiWeb product or a general API for arbitrary LearnRecur tables. Its documentation warns that client/server protocol versions can diverge and that the server's storage must be kept apart from a desktop profile. It also says the default server uses unencrypted HTTP, so internet access needs HTTPS or a private network. [Anki self-hosted sync manual](https://docs.ankiweb.net/sync-server.html).

In the first design, the companion service is the source of truth for Skill descriptions. A linked Anki note/card holds a stable skill ID and a readable copy of the description, so the card remains understandable in Anki exports. The Mac client fetches newly imported skills, creates any missing native card **through Anki's normal collection API**, and then uses native sync for that card and its reviews. The companion API carries the canonical description, exercise banks, text edits, and reports. This avoids having a worker write directly into a collection file while a sync is in progress. It also means there are two sync paths; the first engineering proof must demonstrate that they reconcile safely after a crash or disconnection. A normal Anki export may not include the exercise bank, so provide a separate complete LearnRecur export/backup path. If Anki's current code suggests a cleaner path, prefer the tested path over this sketch.

When a skill card is about to be shown, the fork selects a locally cached exercise and renders its stored prompt. Revealing the answer reads the stored answer and explanation. No network call and no model judgment sits on the reveal or rating path. A local usage record links the exercise ID to the review and later syncs to the companion service. Reported items are excluded locally at once, even while offline. The server refills banks asynchronously for active skills, using a bounded target rather than generating indefinitely. Jobs must survive restart, deduplicate retried requests, and stop after bounded failures.

Generation should produce a structured prompt, answer, explanation, skill revision, and duplicate fingerprint. Deterministic checks can reject malformed, empty, near-duplicate, out-of-revision, or obviously out-of-scope output. Those checks cannot prove that an AI answer is correct. During the personal test, sample real generated exercises across several skills and manually inspect ambiguity, truth, scope, and difficulty. Reports should feed that inspection and retire bad items. The decisive risk is exercise quality, not token volume.

## Hosting and cost

Start on a portable small VPS **only if the full hosting cost stays at or below $5/month**. The user's 24/7 Windows utility PC is the fallback if a suitable VPS or credit is unavailable. Keep deployment reproducible so moving between a promo VPS and the home PC is routine. Favor a minimal standalone Anki sync server, the companion API, a small persistent database, and a worker; benchmark memory and disk needs before choosing a box. Put the public endpoint behind HTTPS or a private-network tunnel, restrict it to the personal account, and keep sync credentials, import tokens, and provider keys out of source control.

The AI API has a **separate configurable $5/month estimated-use limit**. Before a generation job starts, reserve an estimated maximum based on the chosen model and token limits; stop starting jobs when the remaining budget is too small. Also set the provider's own spending alert or limit if available. This app-side estimate is not a guaranteed provider billing cap, so record actual usage when the provider returns it and keep concurrency bounded. At the limit, generation pauses, while review continues from cached exercises and finally reuses older unreported exercises. Model and pricing are configuration, not baked into product code.

Back up the whole state: Anki sync collection and media, the companion database, and job state. Test restoration onto a different host before treating the setup as reliable. Services should start after reboot, recover interrupted jobs without duplicating exercises, and make the Mac's unsynced reviews safe through an outage. A migration must not require the old VPS to remain available.

## Build order and proof of completion

1. **Fork proof.** Pin an Anki release; build and run it on the Mac in a separate profile. Import a copy of an existing ordinary deck and confirm its note type, media, learning progress, review, and export behavior. In a scratch profile, add one linked Skill card and show two different locally stored exercises on successive reviews while Anki keeps one schedule and review log. This is the go/no-go test for the fork architecture.
2. **Hosted loop.** Bring up self-hosted Anki sync and the companion service on a portable host. Add authenticated skill import, a durable generation/refill job, structured exercise storage, local cache, and reconciliation. Prove ordinary sync and Skill sync after disconnect, restart, and host restoration. Keep generation out of the review path.
3. **Daily-use slice.** Add the blended Skill editor, back-side explanation, report-and-skip, budget control, and the agent `SKILL.md`. Verify default preview/confirmation and explicit preview bypass. Import a small set of real Spanish grammar skills through Codex and review them for at least a week.
4. **Decision after personal use.** Measure whether the exercises are fair, whether a skill is narrow enough to schedule, how often cached items run out, real API spend, server cost, and how hard upstream changes are to merge. Only then decide on a small outside test, mobile app, mixed decks, or a paid service.

V1 is usable when the Mac fork can review ordinary imported cards and LearnRecur skills in the same app; generated exercises vary without changing the Skill card's schedule; 1–4 ratings and Again behave through native Anki; reports do not rate; an offline session works from cache; exhausted banks fall back to safe reuse; a restarted backend refills without duplicates; import retries do not duplicate skills; a complete backup restores on a new host; and the week of Spanish use finds the loop worth keeping. Tests should cover the data and restart cases, with manual checks of real exercise quality and the actual app flow. This is likely a substantial fork effort: the first proof is a focused engineering slice, while a dependable daily driver and later mobile clients will take longer. Do not promise a date before the fork proof.

## Old LearnRecur and the later business

Leave the current website and services running until the fork is usable. Do not migrate its skill state or review history for V1; this project starts fresh. Preserve the old repository, database, uploads, configuration needed for recovery, and the untracked product-discovery notes. Once the new app has passed the personal-use test, verify a backup and restore path, then decide whether to archive the old repository and shut down the old service. The old site can later become a simple landing page or point to the fork's repository, but no website work is needed now.

A future $5/month hosted sync and AI plan is a **business hypothesis**, not V1 scope. A small fee could pay for convenience: managed sync, backup, and automatic generation. BYOK keeps inference cost with the user; an included-AI tier needs measured cost per active learner, payment fees, support, and abuse controls before pricing. The likely differentiator is trustworthy skill-level practice woven into Anki's fast review loop, not generic “AI makes flashcards.” Existing add-ons and the cost of maintaining an upstream fork are real competition and cost, so the one-week personal test comes before business claims.

Anki's repository is licensed under **AGPL-3.0-or-later**, with some separately licensed components. A distributed fork must comply with that license, and modified AGPL server code used over a network has source-availability obligations for its users. Selling a hosted service is compatible with open-source code, but a future commercial launch should review the exact combined code and notices. Use a distinct LearnRecur name and identity so no one mistakes the fork for official Anki. [Anki license](https://github.com/ankitects/anki/blob/main/LICENSE); [GNU explanation of the AGPL network clause](https://www.gnu.org/licenses/why-affero-gpl.html).

## Prompt to seed the new project

> Build a Mac-first LearnRecur fork of Anki using the decisions in this document. Start by inspecting the current Anki source, build instructions, sync protocol, and license, then pin a suitable upstream release. The first slice is a separate-profile Mac build with ordinary deck import and one Skill card that presents different cached exercises on successive reviews while Anki owns scheduling and review history. Keep the ordinary Anki path intact. Do not implement automatic grading, mobile, billing, a website, or full textbook ingestion. Treat the two-sync-path design as a hypothesis to prove with a disconnect/restart test before expanding it. Record what works, what failed, and the exact next step in the new repository.

The new repository should copy this document as its initial product contract, then write its own `AGENTS.md` and implementation roadmap. The current web app's stack instructions should remain with the old repository; they do not govern this fork.
