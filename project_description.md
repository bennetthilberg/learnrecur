# LearnRecur Project Description

## 1. One-Sentence Product Definition

LearnRecur is a web-first spaced repetition practice app that lets a learner upload or describe any small, well-defined academic skill, then receive a stream of AI-generated, objectively gradable exercises that keep that skill fresh over time.

## 2. Core Product Idea

The original motivation for LearnRecur came from learning Spanish and wanting something like Anki, but for more than vocabulary. Anki is excellent for discrete flashcards, especially vocabulary, facts, and small recall prompts. LearnRecur is intended to apply the same spaced repetition logic to broader but still compact skills: grammar rules, conjugation patterns, math procedures, symbolic transformations, biology classifications, historical distinctions, and other concepts that can be tested with small practice exercises.

The product is not primarily a lesson platform. It is not where the user learns something for the first time. It is where the user takes something they already encountered in a class, textbook, worksheet, lecture, video, or note, and turns it into repeatable practice that keeps the concept available in memory.

The working product phrase is:

> Easy spaced repetition to help you solidify everything you learn.

The key difference from Anki is that LearnRecur does not repeatedly show a static card. It schedules a skill, then generates or serves a fresh exercise for that skill whenever the skill is due.

## 3. Product Goals

### 3.1 Primary Goal

Help learners reliably review and solidify small academic skills through short, objective, high-quality practice exercises scheduled by spaced repetition.

### 3.2 User Experience Goal

The app should feel like a calm, focused Khan Academy practice flow rather than a flashcard deck editor or a tutoring chat. The user should be able to:

1. Add a skill quickly.
2. Trust that the app understood what should be practiced.
3. Start a session.
4. Answer one exercise at a time.
5. Get instant feedback.
6. Move on without tuning scheduling knobs.

### 3.3 Quality Goal

Exercise trust is the most important early success metric. Users must feel that generated exercises are relevant, fair, textbook-like, answerable, and objectively graded.

The product should avoid common bad AI exercise patterns:

- Questions that are much longer or windier than necessary.
- Questions that require a reasoning process the model did not actually consider.
- Questions with unclear or subjective answers.
- Questions that do not match the syntax, format, or style the user is seeing in class.
- Questions that are theoretically related to the skill but not useful practice for it.
- Questions that are too broad, tricky, or unfair.

## 4. What LearnRecur Is Not

### 4.1 Not A Full Learning Platform In V1

LearnRecur is not initially a place where users go to learn a full concept from scratch. It may eventually include explanations, remediation, or links back to source material, but the first product is a review and practice tool.

### 4.2 Not A General AI Tutor In V1

The product should not feel like a chat tutor where every answer triggers a live model response. Practice should be fast and deterministic. AI is used to extract skills, generate exercises, and verify exercise quality ahead of time, not to subjectively judge every response at submit time.

### 4.3 Not Just A Flashcard App

The product should not schedule individual static cards as the primary unit. The scheduled unit is the skill. Exercises are the practice instances produced for that skill.

### 4.4 Not A School/Admin Platform In V1

The long-term vision may include colleges, K-12, instructors, student cohorts, analytics, and annual per-student pricing. The first serious version is personal-use software for a solo learner.

## 5. Target Users

### 5.1 V1 User

The V1 user is a solo adult learner who wants to keep academic material fresh. This includes:

- A student practicing material from a class.
- A self-learner working through a textbook.
- A person learning a language, math topic, science concept, or professional exam concept.
- The founder/user using the app for Spanish grammar and other personal study.

### 5.2 Early Testing Domain

The product should be subject-agnostic from the beginning, but Spanish grammar is the main proving-ground example. The app should not hard-code Spanish as the product category. Spanish examples are useful because they reveal many important requirements:

- Source material may be a textbook page.
- The user may need practice with grammar rules, not just vocabulary.
- Questions should preserve classroom syntax and familiar sentence formats.
- Answers should be objective.
- Some answers may require normalization, such as accents, spelling, or conjugated forms.

Other intended example domains include:

- Calculus, such as applying the power rule or finding derivatives.
- Fractions, decimals, and algebraic simplification.
- Biology concepts that can be tested by classification or identification.
- History distinctions, dates, or cause/effect relationships when answers are objective.
- Any academic skill that can be broken into narrow, testable exercises.

## 6. Core Workflow

### 6.1 Skill Creation

The user creates practice material by either:

- Typing a description of a skill.
- Uploading a small image.
- Uploading a short PDF.

The most important intended workflow is uploading a screenshot or short excerpt from a textbook, worksheet, class handout, or notes. The user can add a description such as:

> This is a skill I want to practice.

or:

> Practice when to use ser versus estar.

The system parses the source material and proposes one or more narrow skills.

### 6.2 AI Skill Drafting

When material is uploaded or described, AI should produce skill drafts. A skill draft should include:

- Title.
- Objective.
- Rules.
- Examples.
- Difficulty notes.
- Exercise constraints.
- Tags.
- References to source material.

The user reviews and edits these fields before the skills become active. This is important because the app must not silently misunderstand the source material and start scheduling the wrong thing.

### 6.3 Narrow Skill Splitting

If uploaded material is broad, the app should propose multiple smaller skills rather than treating the whole page as one scheduled unit. For example, a textbook page on Spanish past tense might be split into:

- Recognize regular preterite endings.
- Choose preterite versus imperfect for completed actions.
- Conjugate irregular preterite stems.

Each skill should be narrow enough that one exercise can meaningfully test it.

### 6.4 Practice Session

The practice session is due-queue-first. The user does not normally pick a skill manually. The app selects due skills across the selected scope and presents one exercise at a time.

Each exercise should look and feel similar to a Khan Academy practice problem:

- A focused prompt.
- Multiple choice or exact input.
- A clear correct answer.
- Instant feedback.
- A brief explanation available immediately after answering.

The session continues until the user stops. There is no required fixed session size in V1.

### 6.5 Feedback

Feedback must be instant. There should be no live AI call after the user submits an answer. Any explanation shown after an answer should be generated and verified when the exercise is generated.

Feedback should include:

- Correct or incorrect result.
- Correct answer.
- Brief explanation.
- Optional rating override for correct answers.

Full tutoring, long remediation, and conversational explanations are later-scope.

## 7. Exercise Model

### 7.1 Exercise Types For V1

V1 supports:

- Multiple choice.
- Exact input.

Exact input can include:

- Text answers.
- Numeric answers.
- Fractions and decimals.
- Basic math expressions.

Later exercise types may include:

- Fill-in-the-blank with multiple blanks.
- Matching.
- Ordering.
- Labeling.
- Multi-step exercises.
- Diagram-based exercises.
- Audio prompts for language learning.

### 7.2 Objective Grading Requirement

Correctness should be objective. The app should know whether the answer is correct based on an answer key, accepted answer list, numeric tolerance, symbolic equivalence, or another deterministic rubric.

The model should not be asked, after the fact, "Was this answer correct?" for ordinary V1 practice. AI may help generate the answer spec, but runtime grading should be deterministic.

### 7.3 Answer Normalization

The product should support reasonable equivalence without becoming subjective.

Text answer normalization should support:

- Case-insensitive matching.
- Optional whitespace normalization.
- Optional accent/diacritic normalization.
- Accepted answer variants.

Numeric answer normalization should support:

- Integers.
- Decimals.
- Fractions.
- Tolerances when appropriate.

Math answer normalization should support:

- Basic equivalent algebraic expressions.
- Symbolic equivalence checks for simple forms.
- Fallback accepted text for common formatting variants.

Example:

- If the correct answer is `0.75`, `3/4` should be accepted.
- If the correct derivative is `12x^3`, `12*x^3` should be accepted.

### 7.4 Exercise Metadata

Each exercise should store:

- Skill ID.
- Exercise type.
- Prompt.
- Optional prompt math.
- Choices, if multiple choice.
- Answer kind.
- Answer spec.
- Expected response time.
- Difficulty.
- Explanation.
- Source references.
- Generation metadata.
- Verification status.
- Verification notes.
- Freshness key or duplicate-detection key.
- Retirement/flag status.

### 7.5 Text And Math Rendering

V1 exercise prompts should support text and math/LaTeX. The product should not support generated diagrams or AI-generated visual exercise assets in V1.

Uploaded material can contain images or PDF pages, but generated exercises in V1 should render as text/math.

## 8. Spaced Repetition Model

### 8.1 Scheduled Unit

The scheduled SRS unit is the skill, not the exercise and not the exercise template.

When a skill is due:

1. The app selects or generates one verified exercise for that skill.
2. The user attempts the exercise.
3. The attempt produces a rating.
4. FSRS updates the skill's card state.
5. The skill is scheduled for its next review.

### 8.2 Algorithm

Use FSRS via the `ts-fsrs` library. FSRS is an open spaced repetition scheduler similar to what modern Anki can use.

The app stores FSRS card state on the skill:

- Due date.
- Stability.
- Difficulty.
- Elapsed days.
- Scheduled days.
- Learning steps.
- Repetition count.
- Lapses.
- State.
- Last review date.

### 8.3 One Exercise Per Review Event

When a skill is due, one exercise attempt counts as one review event. This is closest to Anki's card review model and keeps the practice flow fast.

Possible future improvement: weak or newly created skills could require a mini-set of 2-3 exercises, but V1 should keep one exercise per scheduled review.

### 8.4 Rating Policy

The app should map attempts to FSRS ratings without asking the user to constantly tune the scheduler.

V1 rating policy:

- Incorrect answer maps to `Again`.
- Correct and very fast maps to `Easy`.
- Correct and not very fast maps to `Good`.
- `Hard` is only applied when the user manually chooses it.

This avoids punishing the user for defocusing, getting interrupted, or leaving the tab open. Slow correct answers should not automatically become Hard.

### 8.5 Optional Rating Override

After feedback, the UI can show subtle Hard/Good/Easy controls with the default selected. The user can ignore them and continue quickly.

For wrong answers, the default should remain `Again`. A future version could allow manual override, but the cleaner V1 policy is wrong equals Again.

### 8.6 Timing Signal

Response time can help distinguish Good from Easy, but only for correct answers. The timer should pause or ignore hidden-tab time so leaving the screen does not distort scheduling.

Each exercise should include an expected response time. Fast correct answers can be classified as Easy relative to this expected time.

## 9. Exercise Generation Strategy

### 9.1 Hybrid Queue

Exercises should be generated in a hybrid queue:

- Keep a small buffer of ready-to-show verified exercises per active skill.
- Refill that buffer asynchronously.
- Avoid forcing the user to wait for an AI call during practice.

Target buffer:

- 3-5 verified exercises per active skill.

### 9.2 Fresh Variations

The app should avoid exact repeats by default. However, similar patterns are allowed and desirable because skill practice requires repetition.

Example:

- A user practicing ser versus estar should see many similar sentences testing location versus identity versus temporary state.
- A user practicing derivatives should see many similar power-rule examples.

The app should avoid exact duplicates or near-duplicates that feel lazy.

### 9.3 Source Material Use

Uploaded source material should shape the skill and exercise style strongly.

The app should:

- Preserve familiar instructional framing.
- Match the syntax and format the user is seeing in class.
- Use source examples as style references.
- Use source exercises as format references.
- Generate fresh exercises when possible.

The user is generally comfortable with copying wording from class material for personal review, but the better default is to generate new exercises that are very similar in format and style rather than simply reusing completed textbook exercises. The app should avoid becoming a photocopying tool.

### 9.4 Conservative Verification

Generated exercises should pass a second verification step before entering the ready queue. The verifier should reject exercises unless they are clearly:

- Relevant to the skill.
- Objective.
- Answerable.
- Appropriately scoped.
- Not too broad.
- Not unfair.
- Not a duplicate.
- Consistent with the answer spec.

The verifier should be conservative. It is better to reject questionable exercises and regenerate than to damage user trust.

## 10. Skill Organization

### 10.1 V1 Organization

Use collections plus tags.

Examples:

- Spanish grammar.
- Calculus refresh.
- Biology exam review.

Tags can identify subject, unit, concept, or source.

This avoids a heavy school-like hierarchy while still keeping many skills manageable.

### 10.2 Later Organization

Later versions may add:

- Courses.
- Units.
- Lessons.
- Instructor-created collections.
- Shared templates.
- Class assignments.
- School/org workspaces.

These should not be added to the V1 data model unless necessary.

## 11. Progress And Mastery

### 11.1 V1 Progress UI

The V1 progress UI should be simple:

- Due count.
- Active skill count.
- Recent accuracy.
- Per-skill mastery/schedule state.
- Session stats.

The UI should not start with rich analytics dashboards. Those matter later, especially for instructors and institutions, but early product success depends on practice quality and trust.

### 11.2 Mastery State

Skill mastery labels can be derived from FSRS state:

- New.
- Practicing.
- Growing.
- Strong.
- Relearning.

These are user-facing summaries, not separate scheduling logic.

## 12. Flagging And Quality Feedback

Users need a way to flag bad exercises. A flagged exercise should:

- Be removed from future practice immediately.
- Store flag reason and optional notes.
- Trigger replacement generation later.
- Preserve enough metadata to improve generation and verification.

Editing generated exercises directly is powerful but out of V1 scope. V1 should support flag and remove.

## 13. User Interface Direction

### 13.1 Overall Feel

The UI should feel calm, focused, and Khan Academy-like:

- Quiet, practical, and friendly.
- Fast to use.
- Clear feedback.
- Low-friction controls.
- No unnecessary gamification early.

The UI should not feel like:

- A marketing landing page.
- A generic chat app.
- A dense Anki clone.
- A game-first habit app.

### 13.2 Practice Screen

The practice screen is the heart of the product and should be the first polished prototype.

It should show:

- Skill title.
- Mastery/difficulty badges.
- Timer or progress indicator.
- Prompt.
- Answer controls.
- Check button.
- Instant feedback after submit.
- Optional rating override.
- Continue button.
- Flag button.

The screen should avoid visible instructions about product mechanics unless they are essential. The app should teach through affordances.

### 13.3 Mobile

V1 should be responsive web, not native mobile and not necessarily a PWA. It should work well in mobile browsers and feel almost native in the practice flow, but mobile app shells, push notifications, and offline support are later.

### 13.4 Reminder UX

Email reminders are appropriate for V1 or late V1. Push notifications are later because mobile web push adds more permission and platform complexity.

## 14. Technical Stack Decisions

### 14.1 Core Stack

The selected stack is:

- Next.js App Router.
- TypeScript.
- React.
- Mantine UI.
- Clerk for user management.
- Neon Postgres.
- Prisma.
- Cloudflare R2 for object storage.
- Google Gemini for AI extraction, generation, and verification.
- Inngest for background jobs.
- Resend for email.
- Vercel for hosting.
- `ts-fsrs` for spaced repetition.
- CortexJS Compute Engine for basic math equivalence.
- Zod for structured contracts.

### 14.2 Stack Philosophy

The stack should be boring, reliable, and simple enough to move quickly. The innovation is the product experience: easy spaced repetition for everything. The innovation should not be an unusual database, custom queue, exotic framework, or clever infrastructure.

### 14.3 TypeScript Decision

Although the founder has less personal TypeScript experience and was open to JavaScript, TypeScript was selected because the product depends heavily on structured contracts:

- Exercise schemas.
- Answer specs.
- AI structured outputs.
- FSRS state.
- Grading logic.
- Background jobs.
- Database models.

Since much of the project will be built with AI agents, strong type contracts should reduce integration errors and make future work safer.

### 14.4 AI Provider Decision

Use one strong provider for V1 rather than building provider abstraction immediately.

The selected provider is Google Gemini, with the intended default model:

- `gemini-3.5-flash`

The model should remain environment-configurable through `GEMINI_MODEL` so it can be changed without code edits.

Gemini is responsible for:

- Parsing user descriptions and uploaded source material.
- Drafting narrow skills.
- Generating candidate exercises.
- Verifying candidate exercises.

Gemini should not be required after every user answer.

### 14.5 Database Decision

Use Postgres plus Prisma.

Neon is the intended hosted Postgres provider. It works well with serverless Next.js deployments and is a good default for a Vercel-hosted product.

### 14.6 Storage Decision

Use S3-compatible object storage, specifically Cloudflare R2. Uploaded originals should be kept with the skill so the user can review, reprocess, or improve the skill later.

### 14.7 Background Jobs Decision

Use Inngest for managed background jobs. This is important because upload parsing, AI extraction, exercise generation, verification, and queue refills should not block ordinary web requests.

### 14.8 Email Decision

Use Resend for transactional email and due-practice reminders. Clerk owns authentication emails.

## 15. Core Data Model

The core models are:

- `Collection`.
- `Skill`.
- `SourceFile`.
- `SkillSourceRef`.
- `Exercise`.
- `ExerciseAttempt`.
- `ReviewLog`.
- `GenerationJob`.
- `ExerciseFlag`.
- `ReminderPreference`.

### 15.1 Collection

A collection groups skills for a user. It is the V1 replacement for heavier course/unit hierarchy.

### 15.2 Skill

A skill is the central product object and the FSRS scheduled unit.

It stores:

- User ownership.
- Collection.
- Title.
- Objective.
- Rules.
- Examples.
- Difficulty notes.
- Exercise constraints.
- Tags.
- Status.
- Ready exercise target.
- FSRS card state.

### 15.3 SourceFile

A source file is an uploaded image or PDF with metadata and extraction status.

### 15.4 SkillSourceRef

A source reference links a skill back to source material. V1 should keep light references, not full citation-grade source tracking.

### 15.5 Exercise

An exercise is one generated practice item. It is not the scheduled unit. It is selected when its skill is due.

### 15.6 ExerciseAttempt

An attempt records the user's response, correctness, elapsed time, proposed rating, and final rating.

### 15.7 ReviewLog

A review log records the FSRS transition for a skill after an exercise attempt.

### 15.8 GenerationJob

A generation job tracks async extraction, generation, verification, and refill work.

### 15.9 ExerciseFlag

An exercise flag records user feedback that an exercise is bad, unfair, wrong, or not useful.

### 15.10 ReminderPreference

Reminder preferences control due-practice emails.

## 16. Permissions, Privacy, And Data Control

### 16.1 V1 Assumption

V1 is designed for adult solo users. K-12 compliance, guardian workflows, FERPA/COPPA-style school requirements, and institutional data agreements are later.

### 16.2 Content Boundary

The app should focus on academic skills. It should reject unsafe, harmful, or non-testable requests.

### 16.3 User Data Controls

V1 should include basic controls:

- Delete skills.
- Delete uploads.
- Delete or retire exercises.
- Export basic user data eventually.
- Account deletion via Clerk/app flow.

## 17. Future Product Vision

### 17.1 Personal Use To Private Beta

After the solo workflow is strong, the product can support a private beta with:

- Better onboarding.
- Feedback capture.
- Reliability improvements.
- Usage limits.
- More polished source ingestion.

### 17.2 Sharing And Templates

A future version may allow:

- Shareable skills.
- Copyable collections.
- Public or private templates.
- Community-generated practice packs.

This is intentionally not V1.

### 17.3 Classroom And Institutional Use

The long-term vision includes schools, colleges, and K-12 institutions. In that version:

- Instructors can create collections for classes.
- Students practice assigned skills.
- Instructors track progress.
- Administrators see higher-level analytics.
- Schools pay annually per student.

The institutional version should not distort the early solo learner product. It should build on a strong personal practice engine.

## 18. Current Implementation Snapshot

As of the first implementation pass, the repository includes:

- Next.js/TypeScript app scaffold.
- Mantine UI.
- Dashboard page.
- Practice page.
- Skill creation page.
- In-memory demo mode.
- Objective answer checking.
- FSRS review mapping.
- Prisma schema.
- Gemini service layer skeleton.
- R2 upload-signing endpoint.
- Inngest endpoint and placeholder functions.
- Resend reminder helper.
- Clerk webhook endpoint and optional middleware.
- Unit tests for answer checking, FSRS mapping, and demo review flow.
- External setup checklist in `human-stuff.md`.

The demo mode exists so the product can be clicked before external credentials are configured.

## 19. Non-Negotiable Product Principles

1. Schedule skills, not static flashcards.
2. Correctness must be objective in V1.
3. Feedback must be instant.
4. AI-generated exercises must be verified before practice.
5. Source material should shape style and syntax.
6. The practice screen is the core experience.
7. Start personal and subject-agnostic.
8. Keep the stack boring and reliable.
9. Make exercise trust the early success metric.
10. Do not let future classroom scope bloat the V1 product.

