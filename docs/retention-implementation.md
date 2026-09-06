# Configurable retention implementation

Working branch: `a/retention-preferences`, based on `origin/main` at `03db079`.
The original checkout at `7b6c7f9` and its untracked product-discovery work are preserved.

## Policies

- User preference defaults to Balanced; collection and skill overrides are nullable. Resolution is skill, collection, user, Balanced. Explicit Balanced is different from using the default.
- Mixed review defaults off. Familiarity defaults false and is an explicit skill declaration, never a synthetic FSRS review.
- Newly generated text contracts snapshot `policyVersion: 2`, preserve Unicode letters/accents and normalize canonical Unicode to NFC. Natural text ignores capitalization and normalizes whitespace; Exact preserves both; Custom changes only those two choices. Explicit accepted alternatives express limited equivalence.
- Unversioned text retains the existing legacy normalization defaults, including accent folding. Existing exercise contracts and historical outcomes are not rewritten. New attempts snapshot their answer contract; older attempts refer to their immutable exercise contract.
- Automatic correct ratings are Good (`correct-good-v2`); wrong answers remain Again and deliberate correct Hard/Good/Easy overrides remain available. Legacy attempt records receive `speed-v1` without recalculation. Replay uses recorded final ratings.
- A text policy change renews future text inventory with the existing retirement mechanism. A skill revision and row lock fence obsolete input generation. Collection text changes affect inheriting skills in a bounded edit of at most 500 skills. Explicit overrides do not count toward this bound, and preference-only saves do not invalidate stock or require this limit. An oversized text edit returns specific guidance without a partial save. Existing schedules are preserved.
- Planner evidence is bounded to 20 recent recorded reviews and 100 recent exercises, ordered chronologically with IDs breaking ties. Raw private learner answers are not selected. Confirmed defective exercises are excluded.
- Recovery ends after two consecutive correct unassisted scheduled reviews after the latest eligible failure, with at least one on a later UTC calendar day. A failure reopens recovery. Missing legacy history conservatively requires two unassisted correct scheduled reviews across UTC days. This is an initial heuristic, not a demonstrated optimum.
- Mixed selection preserves the earliest overdue UTC day, then prefers a different compatible skill. Compatibility requires the same nonempty collection plus a shared tag or at least two substantive objective terms. Only due, eligible work is selected.

## Migration and validation boundary

Migration `20260906173000_retention_preferences` is additive. No production migration or deployment is authorized by this implementation. Rolling back the migration discards new preferences and audit metadata; roll back the application with it, or preferably retain the additive columns. Historical grades and schedules require no backfill or replay.

Separate disposable databases were created for this branch and all 32 migrations applied successfully. CI cleaned up the first `e2e_*` database; final local reruns use `retention_local_1788719520`, outside that cleanup namespace. The worktree's ignored `.env.local` points to the local test database. The existing application database was not migrated. Do not run its background worker against a real queue during tests.

## Configuration examples

For a Spanish maintenance collection, select **Recall first** and **Natural language** in the collection's Practice preferences. On each previously studied skill, select **I have already studied this skill**. Leave its preference at **Use default**. Start practice inside that collection and enable the session's **Mixed review** switch when choosing the applicable rule is useful. Formation prompts retain necessary tense cues. Use existing Exercise focus to ask for familiar vocabulary, glossed incidental terms, and contrasts supported by the approved source. This fits a chosen 10–15 minute maintenance session; the app does not prescribe a new daily schedule.

For a math collection, explicitly select **Balanced** to retain that mix even if the user default is Recall first. Numeric fractions and basic symbolic equivalence keep their existing deterministic contracts; text comparison does not affect them. For case-sensitive identifiers or literal protocol strings, select **Exact text** on the relevant skill or collection. Our isolated technical fixture defines a toy protocol requiring `GET /v1`, avoiding assumptions about real protocols' normalization rules.

Settings exposes the user practice default and Mixed review default. Collections and skills provide real nullable overrides; explicit Balanced remains distinct from inheriting Balanced. A draft moved between collections immediately inherits its destination's settings, retires obsolete text stock, and invalidates running activation. Existing active-skill guidance editing does not move or redefine the skill.

## Preparation, history and API contracts

Activation continues to require at least three verified choice exercises, including eligible verified agent candidates. A familiarity declaration opens verified production at zero repetitions and queues suitable input after activation. Choice remains usable while input prepares. Existing target counts, daily quotas, idempotency and retry limits bound preparation. Practice opening and successful review submission also check at most ten due skills in scope, and preference saves check at most ten affected active skills, with the remainder picked up through practice or existing preparation controls. A failed or limited job remains visible through existing skill preparation controls; the empty practice screen reports preparation needed rather than claiming the learner is caught up.

An explicit Prepare math operation supplies the symbolic capability to planning without relying on title tokens. Native generation and verification still enforce the approved objective. Automatic preparation continues to use the existing conservative subject inference. Input candidates retain original planning slots across deterministic rejection, duplicate removal and verifier rejection.

Recall first picks an available production mode before fresh/least-recently-used exercise rotation (math, numeric, text, then choice). Only verified usable contracts can participate; this order does not convert conceptual objectives into exact-string questions. The existing capability planner and verifier must support the mode. Every review still advances exactly one skill schedule.

The production generator receives the last 20 eligible review outcomes and the last 100 valid exercises through two bounded queries. Cutoffs use the caller's real clock; ties use IDs. Reviews carry actual answer mode/family, final rating, time, scheduled status and observed assistance, without learner answer strings. Confirmed defective exercises are excluded even while schedule correction is pending. Mode and family history influence mode/family variety; recent outcomes determine recovery and difficulty. Explicit zero independent successes stays zero, even when assisted attempts received correct ratings.

Versioned `practiceContext` records server-derived answer mode plus the browser's mixed/reduced-cue presentation flags. Switching to standard practice marks the title as seen for that item, even if mixed is enabled again. Native practice currently has no hint subsystem, so recorded assistance is `none`; choice and planned learning-time labels do not imply observed help. These fields describe the recorded presentation, not proof of no earlier exposure, a real delayed-transfer event, spoken fluency, or human retention gains.

New external text candidates use comparison policy v2. `policyVersion` defaults to 2; normalization defaults to case/whitespace leniency and **no** diacritic folding. Explicit `normalization.diacritics: true`, contradictory profiles, or candidates that differ from the owned skill's resolved profile are rejected. Exact candidates must explicitly disable case and whitespace normalization. Existing stored unversioned exercise contracts remain legacy; an obsolete unversioned agent candidate cannot be newly published as if it conformed to v2. The owner can retry preparation under the current contract. Invalid persisted agent policy fields fail that item without silently substituting grading defaults or aborting the whole batch. Preference pages can render invalid stored display settings for repair. Replacing or clearing malformed previous policies retires future text stock; malformed new submissions are rejected. Unrelated skill preferences can be saved while an inherited policy is malformed, but generation remains strict until that policy is repaired. Agent skill specifications also accept nullable `practicePreference`, nullable `textPolicy`, and explicit `alreadyStudied`.

Prompt versions are `skill-mcq-v2`, `skill-exact-input-v2`, and `skill-math-v1`. Export version 4 adds user/collection/skill preferences and new attempt comparison/rating/context snapshots. Existing ownership filters and cascades cover these additive columns; no separate deletion subsystem is introduced.

## UI critique and corrections

1. Default dimmed helper text was too faint. Preference descriptions now use the approved secondary text token.
2. Advanced controls fell after the mobile lifecycle controls because they lacked a named grid area. They now sit directly after practice guidance.
3. The session switch floated against the page edge. It now aligns with the existing practice width.
4. Repeated generation explanations crowded the select. Its description now states the effective value and a short explanation of Recall first.
5. Exact whitespace could disappear in correct-answer feedback. The answer display preserves whitespace and line breaks.

Existing Mantine controls, Phosphor icons, fonts, colors and navigation remain the visual foundation. Desktop and mobile browser scenarios exercise settings reload, disabled saving controls, network-error retry, keyboard toggles, accent feedback, exact technical rejection and symbolic grading.

## Local verification

The original checkout and unrelated product-discovery files remain untouched. A separate disposable database and isolated Clerk test users support all database/browser checks. No real account settings, production migration, manual deployment, paid live evaluation, or merge has been performed. Repository integrations automatically create Vercel previews on push.

Verified locally:

- `npm run lint` passes.
- Unit suite: 882 tests, including actual-assistance and candidate-slot regressions. `npm run test:coverage` passes repository thresholds.
- `npm run prisma:validate`, `npm run prisma:generate`, and `npm run build` pass.
- `npm run check:runtime-audit` passes with the repository's existing accepted development-dependency exceptions and no blocking runtime findings.
- Database coverage totals 371 tests across the full suite and targeted reruns. The full run passed 360 tests and exposed three math fixtures missing a math capability plus an export assertion for a deliberately omitted field. Corrected suites passed 112/112; the final retention suite, including real query-window, large-collection and input-provenance regressions, passed 18/18. The title-independent math refill regression also passes. Final regressions also cover familiarity changes during activation, read-model fields and independently runnable exports.
- `E2E_BASE_URL=http://localhost:3011 npm run test:e2e:all` passes all 28 checks, including setup/cleanup, signed-out gates, ownership, every answer mode, settings, failures, loading, keyboard controls, and desktop/mobile retained-cue behavior. Screenshots of settings, skill preferences, and feedback were inspected at 1280 and 390 pixels. The final targeted browser rerun also covers unlocked preparation copy and the existing compact mobile controls. Browser checks use the repository's development-server harness; an additional production-start trial could not pass Clerk development authentication.

PR checks and review threads are the source of truth for hosted verification and review of the submitted head. A passing local build is not deployment evidence.

The automatic Codex review and both permitted manual reviews were consumed. All valid findings were fixed and their conversations resolved. The final malformed-policy repair follows the last review and has not been re-reviewed; do not claim a clean review of that exact head. CodeRabbit's original findings were addressed, while its follow-up review was rate limited.

The offline generation corpus now includes Spanish, French terminology, exact technical text, numeric and symbolic math, and biological discrimination. All seeded acceptance/critical-defect expectations pass in unit tests. The offline CLI retains its default **pause** gate because each provider has fewer than 30 fixture trials; this is expected insufficient evidence, not a live quality certification. No threshold was lowered and no live provider calls were made for this slice.

Do not run the existing unit/coverage suite concurrently with browser tests: the existing E2E isolation unit test writes and removes the same manifest file the browser harness uses. Database integration suites also run serially by repository configuration.

## Research boundaries

Spaced practice and task-sensitive retrieval motivate these options ([Kim and Webb](https://onlinelibrary.wiley.com/doi/abs/10.1111/lang.12479), [Suzuki and Sunada](https://www.cambridge.org/core/journals/studies-in-second-language-acquisition/article/abs/dynamic-interplay-between-practice-type-and-practice-schedule-in-a-second-language/C01D682D82EDBD00AF29965FCA57BAF3)). Compatible grammar interleaving and appropriately related transfer tasks have supporting research ([Pan et al.](https://sc-pan.github.io/pdf/PRKL_2024.pdf), [Pan and Rickard](https://sc-pan.github.io/pdf/PR_2018.pdf)); the exact mix and UTC recovery heuristic here are initial product rules. Meaningful spelling distinctions are correctness requirements ([RAE](https://www.rae.es/sites/default/files/Libro_de_estilo_prensa_RAE.pdf)). The fixtures establish implementation behavior, not improved human retention or FSRS calibration across changing exercise modes.
