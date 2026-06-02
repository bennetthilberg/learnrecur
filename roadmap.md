# LearnRecur Roadmap

## 1. Roadmap Purpose

This roadmap describes how to take LearnRecur from a completely empty repository to a polished, feature-rich product. It intentionally starts from zero rather than from the current implementation, so it can be used as a long-term build plan, a handoff document for future agents, or a planning artifact for investors/collaborators.

The product should grow in layers:

1. Build a trustworthy solo practice loop.
2. Make AI ingestion and exercise generation reliable.
3. Polish the product into a daily-use personal tool.
4. Expand subject coverage and quality systems.
5. Add collaboration/sharing.
6. Add classroom/institution workflows.
7. Mature into a scalable EdTech platform.

## 2. Product North Star

LearnRecur should become the easiest way to turn anything a person learns into spaced repetition practice.

The product should be judged by these questions:

- Can a user quickly convert real learning material into practice?
- Are generated exercises trustworthy?
- Is answering exercises fast and satisfying?
- Does the schedule help the user remember skills over time?
- Does the app stay useful across subjects?
- Does the system scale from one learner to a classroom without losing the simple practice loop?

## 3. Phase 0: Blank Repository To Technical Foundation

### 3.1 Goals

Create the project foundation with the selected boring, reliable stack. The goal is not feature depth yet. The goal is a correct skeleton that future work can safely build on.

### 3.2 Stack Setup

Set up:

- Next.js App Router.
- TypeScript.
- React.
- Mantine UI.
- ESLint.
- Vitest.
- Prisma.
- Postgres-compatible schema.
- Clerk integration points.
- Environment variable structure.
- Vercel-compatible build.

### 3.3 Initial Project Files

Create:

- `README.md`.
- `.env.example`.
- `prisma/schema.prisma`.
- `prisma.config.ts`.
- `src/app/layout.tsx`.
- `src/app/page.tsx`.
- `src/app/globals.css`.
- `src/components`.
- `src/lib`.
- `src/test`.

### 3.4 Environment Contract

Define these environment variables:

- `NEXT_PUBLIC_APP_URL`.
- `NEXT_PUBLIC_DEMO_MODE`.
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`.
- `CLERK_SECRET_KEY`.
- `CLERK_WEBHOOK_SECRET`.
- `DATABASE_URL`.
- `GEMINI_API_KEY`.
- `GEMINI_MODEL`.
- `R2_ACCOUNT_ID`.
- `R2_ACCESS_KEY_ID`.
- `R2_SECRET_ACCESS_KEY`.
- `R2_BUCKET_NAME`.
- `R2_PUBLIC_BASE_URL`.
- `INNGEST_EVENT_KEY`.
- `INNGEST_SIGNING_KEY`.
- `RESEND_API_KEY`.
- `RESEND_FROM_EMAIL`.

### 3.5 Acceptance Criteria

- App runs locally.
- Production build passes.
- TypeScript passes.
- Lint passes.
- Prisma client generates.
- Demo mode can be enabled without external services.

## 4. Phase 1: Core Domain Model

### 4.1 Goals

Define the product objects before building too much UI. This prevents the app from becoming a loose demo that cannot support the real workflow.

### 4.2 Prisma Models

Implement:

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

### 4.3 Skill As FSRS Unit

The schema must store FSRS card state on `Skill`, because the schedule belongs to the concept being practiced, not to an individual generated exercise.

Store:

- Due date.
- Stability.
- Difficulty.
- Elapsed days.
- Scheduled days.
- Learning steps.
- Repetitions.
- Lapses.
- State.
- Last review timestamp.

### 4.4 Exercise Contract

Exercises must support:

- Multiple choice.
- Exact input.
- Answer kinds: choice, text, numeric, math.
- Expected response time.
- Difficulty.
- Explanation.
- Verification status.
- Freshness key.
- Source references.

### 4.5 Acceptance Criteria

- Data model can represent all V1 decisions.
- No classroom/org models yet.
- No sharing model yet.
- Schema supports future background generation.
- Schema supports exercise flagging and replacement.

## 5. Phase 2: Objective Answer Checking

### 5.1 Goals

Build deterministic grading before AI generation. AI output is only useful if the system can objectively check the result.

### 5.2 Multiple Choice

Check by stable choice ID, not by label text. Labels may contain formatting, math, or translated text.

### 5.3 Text Answers

Support:

- Accepted answer list.
- Case sensitivity control.
- Whitespace normalization.
- Diacritic/accent normalization.

### 5.4 Numeric Answers

Support:

- Integers.
- Decimals.
- Fractions.
- Tolerance.
- Optional accepted text variants.

### 5.5 Math Answers

Use CortexJS Compute Engine or an equivalent math parser to support basic symbolic equivalence.

Start with:

- Simple polynomial expressions.
- Basic multiplication notation variants.
- Simplified equivalent expressions.

Avoid claiming full CAS-level equivalence in V1.

### 5.6 Tests

Write tests for:

- Choice correctness.
- Text normalization.
- Accent normalization.
- Fraction/decimal equivalence.
- Numeric tolerance.
- Basic math equivalence.
- Incorrect answer cases.

### 5.7 Acceptance Criteria

- No AI call is needed after answer submission.
- Correct answers are accepted in common equivalent forms.
- Incorrect answers are rejected reliably.
- The answer checker returns a normalized answer and correct-answer display string.

## 6. Phase 3: FSRS Scheduling Engine

### 6.1 Goals

Implement the memory scheduling loop using `ts-fsrs`.

### 6.2 Card Creation

Every active skill gets a new FSRS card state when activated.

### 6.3 Review Mapping

Implement V1 rating policy:

- Incorrect answer -> `Again`.
- Correct and very fast -> `Easy`.
- Correct and normal speed -> `Good`.
- Correct and manually marked hard -> `Hard`.

### 6.4 Timer Rules

The visible response timer should:

- Count only while the practice tab is visible.
- Reset on each exercise.
- Not punish the user for switching tabs or stepping away.

### 6.5 Review Logs

Every completed exercise should produce:

- Exercise attempt.
- Final rating.
- Previous FSRS state.
- Next FSRS state.
- Review timestamp.
- Due timestamp.
- Scheduled days.

### 6.6 Tests

Write tests for:

- Wrong maps to Again.
- Quick correct maps to Easy.
- Normal correct maps to Good.
- Manual Hard works.
- FSRS state advances after review.
- Due queue excludes not-yet-due skills.

### 6.7 Acceptance Criteria

- One due skill produces one exercise review event.
- FSRS state updates after answer confirmation.
- Dashboard due counts reflect schedule.
- The user can practice without thinking about scheduler settings.

## 7. Phase 4: Clickable Practice Prototype

### 7.1 Goals

Build the first real-feeling product surface: the practice screen. Use demo data before wiring production persistence and AI.

### 7.2 Demo Data

Seed in-memory or database-backed examples:

- Spanish grammar skill: ser vs. estar.
- Math skill: power rule derivatives.
- At least one multiple choice exercise.
- At least one exact text exercise.
- At least one exact math exercise.

### 7.3 Practice Screen

Build UI for:

- Skill title.
- Mastery badge.
- Exercise difficulty badge.
- Timer/progress indicator.
- Prompt.
- Multiple choice cards.
- Text input for exact answers.
- Check button.
- Correct/incorrect feedback.
- Correct answer display.
- Pre-generated explanation.
- Hard/Good/Easy override for correct answers.
- Continue button.
- Flag button.

### 7.4 Flow

The practice flow should be:

1. Load next due skill.
2. Show one verified exercise.
3. User answers.
4. App checks answer deterministically.
5. App shows instant feedback.
6. User optionally changes rating.
7. User continues.
8. App updates skill schedule.
9. App shows next due skill or all-caught-up state.

### 7.5 UX Quality

The screen should feel:

- Calm.
- Fast.
- Focused.
- Non-chatty.
- Similar in spirit to Khan Academy practice.

Avoid:

- Large marketing hero sections.
- Long instructions.
- Debug text.
- Overly gamified elements.

### 7.6 Acceptance Criteria

- User can complete multiple due exercises.
- Correctness feedback is instant.
- Schedule updates after continue.
- Flagging removes an exercise.
- The page works on desktop and mobile browser widths.

## 8. Phase 5: Dashboard And Collections

### 8.1 Goals

Give the user a simple home base without overbuilding analytics.

### 8.2 Dashboard Content

Show:

- Due count.
- Active skill count.
- Recent accuracy.
- Collections.
- Collection due counts.
- Skills list.
- Skill mastery labels.
- Skill tags.
- Next due date or due-now state.

### 8.3 Collections

Support:

- Create collection.
- Rename collection.
- Description.
- Color.
- Archive collection later.

### 8.4 Tags

Support tags on skills for filtering and organization.

### 8.5 Acceptance Criteria

- User can understand what needs review today.
- User can see which skills exist.
- Dashboard stays lightweight and does not become an analytics product too early.

## 9. Phase 6: Skill Creation Without AI Dependency

### 9.1 Goals

Before production AI ingestion, allow manual skill creation and editable skill drafts. This makes the practice loop testable even if AI is unavailable.

### 9.2 Manual Skill Drafts

Build form fields for:

- Collection.
- Title.
- Objective.
- Rules.
- Examples.
- Difficulty notes.
- Exercise constraints.
- Tags.

### 9.3 Draft Review

Users should review a structured skill card before activation. This same UI should later be reused for AI-drafted skills.

### 9.4 Starter Exercises

For early development, generate or seed placeholder starter exercises so new skills can enter the practice queue.

### 9.5 Acceptance Criteria

- User can create a skill manually.
- User can edit the structured draft.
- User can activate the skill.
- Activated skill has FSRS state and at least one ready exercise.

## 10. Phase 7: Authentication And Persistence

### 10.1 Goals

Move from demo mode to real user-owned data.

### 10.2 Clerk

Implement:

- Clerk provider.
- Protected routes.
- Sign-in.
- Sign-up or invite-only access.
- User ID propagation into database writes.
- Clerk webhook for user lifecycle events if app mirrors users.

### 10.3 Persistence

Replace in-memory demo store with Prisma-backed server actions and queries.

Persist:

- Collections.
- Skills.
- Source files.
- Exercises.
- Attempts.
- Review logs.
- Flags.
- Reminder preferences.

### 10.4 Demo Mode

Keep demo mode useful for local development:

- No Clerk required.
- No database required if possible.
- Seeded examples still work.

### 10.5 Acceptance Criteria

- User data persists across reloads and deploys.
- Routes are protected when Clerk is configured.
- Demo mode remains available for local development.
- No user can see another user's data.

## 11. Phase 8: Uploads And Source Retention

### 11.1 Goals

Allow users to upload the source material that should become practice.

### 11.2 Upload Scope

V1 supports small uploads:

- Images.
- Short PDFs.

Large textbooks, whole chapters, and long documents are later-scope.

### 11.3 R2 Storage

Use Cloudflare R2 for source files:

- Private bucket by default.
- Signed upload URLs.
- User-scoped object keys.
- File size limit.
- MIME type validation.

### 11.4 SourceFile Records

Store:

- Original file name.
- MIME type.
- Size.
- Bucket.
- Storage key.
- Optional public URL.
- Status.
- Extracted text.
- Metadata.

### 11.5 Source References

Keep light references from skills back to source material:

- Source file.
- Page label.
- Snippet.
- Metadata.

Do not overbuild exact region citations in V1.

### 11.6 Acceptance Criteria

- User can upload a small image/PDF.
- File is stored in R2.
- SourceFile record is created.
- User can see source associated with generated skills.
- User can delete source files and associated records.

## 12. Phase 9: AI Skill Extraction

### 12.1 Goals

Turn source material into narrow, reviewable skill drafts.

### 12.2 Gemini Integration

Use Gemini server-side only. Keep `GEMINI_MODEL` configurable, defaulting to `gemini-3.5-flash`.

### 12.3 Extraction Inputs

The extraction job receives:

- User description.
- Extracted text from source material.
- File metadata.
- Optional page snippets.

### 12.4 Extraction Output

Gemini should return structured JSON matching a Zod schema:

- Title.
- Objective.
- Rules.
- Examples.
- Difficulty notes.
- Exercise constraints.
- Tags.

### 12.5 Skill Splitting

Prompt Gemini to split broad material into multiple narrow skills. The output should be one or more proposed skills, each independently practiceable.

### 12.6 Review UI

Reuse the skill draft review UI. The user must approve or edit AI drafts before activation.

### 12.7 Acceptance Criteria

- One upload can produce multiple narrow skill drafts.
- Drafts are editable.
- Drafts preserve recognizable source style.
- Broad concepts are split.
- Unsafe or non-academic requests are rejected.

## 13. Phase 10: AI Exercise Generation

### 13.1 Goals

Generate high-quality practice exercises for each skill.

### 13.2 Generation Inputs

Each generation job should include:

- Skill title.
- Skill objective.
- Rules.
- Examples.
- Exercise constraints.
- Source snippets.
- Prior generated freshness keys.
- Desired count.
- Desired difficulty mix.
- Desired exercise type mix.
- Current skill mastery state.

### 13.3 Generation Outputs

Each generated exercise should include:

- Type.
- Prompt.
- Optional prompt math.
- Choices.
- Answer spec.
- Expected seconds.
- Difficulty.
- Explanation.
- Freshness key.

### 13.4 Exercise Type Mix

Early skills can start with more constrained questions:

- Multiple choice.
- Direct exact input.

As mastery improves, shift toward:

- Exact text input.
- Numeric input.
- Math expression input.
- Slightly more challenging contexts.

### 13.5 Style Requirements

Generated exercises should:

- Look like textbook/class practice.
- Use source examples as format references.
- Preserve familiar syntax.
- Avoid unnecessary complexity.
- Keep answer requirements clear.
- Avoid trick questions.

### 13.6 Acceptance Criteria

- Exercises are generated asynchronously.
- Exercises include deterministic answer specs.
- Exercises include instant explanations.
- Exercises are not exact repeats.
- Queue refills without blocking practice.

## 14. Phase 11: AI Verification Pipeline

### 14.1 Goals

Protect exercise trust with a conservative verifier.

### 14.2 Verification Checks

The verifier should evaluate:

- Is the exercise relevant to the skill?
- Is there one objective answer?
- Does the answer spec match the prompt?
- Is the explanation correct?
- Is the problem appropriately scoped?
- Is it too easy or too hard for the requested difficulty?
- Does it match source style?
- Is it a duplicate or near-duplicate?
- Is it safe and academic?

### 14.3 Verification Outcomes

Possible outcomes:

- Verified.
- Rejected.
- Needs regeneration.
- Flagged for manual review later.

### 14.4 Rejection Policy

Use conservative defaults. Reject uncertain exercises.

### 14.5 Acceptance Criteria

- Only verified exercises enter the ready queue.
- Rejected exercises are logged with reasons.
- Generation retries are bounded.
- The app can explain why generation failed at a high level.

## 15. Phase 12: Background Jobs

### 15.1 Goals

Move AI and long-running work off the request path.

### 15.2 Inngest Jobs

Implement jobs for:

- Source extraction requested.
- Skill drafting requested.
- Exercise generation requested.
- Exercise verification requested.
- Queue refill requested.
- Bad exercise flagged.
- Due reminder requested.
- Temporary object cleanup.

### 15.3 Job Records

Persist `GenerationJob` records with:

- Type.
- Status.
- Attempts.
- Input.
- Output.
- Error.

### 15.4 Retry Policy

Define retries per job type:

- Upload extraction can retry a few times.
- Exercise generation can retry with adjusted prompts.
- Verification failures should not retry unless caused by system errors.
- Email jobs can retry on transient provider errors.

### 15.5 Acceptance Criteria

- Practice never waits on AI.
- Queue refill runs after skill activation.
- Failed jobs are visible in logs.
- Jobs are idempotent enough to survive retries.

## 16. Phase 13: Exercise Queue Management

### 16.1 Goals

Keep active skills ready for instant practice.

### 16.2 Queue Target

Maintain 3-5 verified ready exercises per active skill.

### 16.3 Refill Triggers

Refill when:

- A skill is activated.
- A skill falls below target ready count.
- An exercise is flagged.
- A batch of exercises expires or becomes stale.
- The user practices heavily and burns through the queue.

### 16.4 Freshness

Track:

- Freshness key.
- Prompt hash.
- Answer hash.
- Similar source pattern.
- Generation batch.

### 16.5 Acceptance Criteria

- Due skills usually have at least one verified exercise ready.
- Exact repeats are avoided.
- Similar-but-useful repetitions are allowed.
- Flagging a bad exercise triggers replacement generation.

## 17. Phase 14: User Data Controls

### 17.1 Goals

Give users basic control over their data.

### 17.2 V1 Controls

Implement:

- Delete skill.
- Archive skill.
- Delete upload.
- Delete collection if empty or with confirmation.
- Export basic data as JSON.
- Account deletion flow coordinated with Clerk.

### 17.3 Privacy

Do not log full private study material unnecessarily. For AI calls, log:

- Model.
- Latency.
- Token/cost estimate if available.
- Job status.
- Error reason.

Avoid logging:

- Full uploaded text.
- Full user answers unless needed for product functionality.
- Full source material in application logs.

### 17.4 Acceptance Criteria

- User can remove sensitive source material.
- User can export core study data.
- App logs are useful but privacy-conscious.

## 18. Phase 15: Email Reminders

### 18.1 Goals

Help users return when practice is due without adding mobile push complexity.

### 18.2 Reminder Preferences

Allow:

- Email enabled/disabled.
- Reminder email.
- Local hour.
- Timezone.
- Minimum due count.

### 18.3 Resend

Use Resend for reminders. Clerk remains responsible for authentication email.

### 18.4 Reminder Job

Daily job:

1. Find users with reminders enabled.
2. Compute due count.
3. Skip if below threshold.
4. Send email.
5. Record send status.

### 18.5 Acceptance Criteria

- User can opt in/out.
- Email sends only when due count threshold is met.
- Emails link directly to practice.
- Bounces/failures are logged.

## 19. Phase 16: UX Polish For V1

### 19.1 Goals

Make the product feel usable every day.

### 19.2 Practice Polish

Improve:

- Keyboard shortcuts.
- Mobile tap targets.
- Loading states.
- Empty states.
- All-caught-up state.
- Flag confirmation.
- Input focus management.
- Math rendering.
- Accessibility labels.

### 19.3 Skill Creation Polish

Improve:

- Upload progress.
- Source preview.
- Draft review interactions.
- Add/remove rules.
- Add/remove examples.
- Suggested tags.
- Draft rejection and regeneration.

### 19.4 Dashboard Polish

Improve:

- Filtering by collection/tag.
- Search.
- Due-only view.
- Recently practiced.
- Weak skills.

### 19.5 Acceptance Criteria

- User can complete a full practice session on mobile web.
- Text does not overlap at common viewport sizes.
- The app feels calm and focused.
- The user always knows what is happening during AI jobs.

## 20. Phase 17: Closed Alpha

### 20.1 Goals

Use the product personally and with a tiny number of trusted testers.

### 20.2 Alpha Constraints

Keep signups restricted:

- Founder account.
- Invite-only users.
- Allowlist.

### 20.3 Instrumentation

Track:

- Skills created.
- Uploads processed.
- Drafts accepted/edited/rejected.
- Exercise generation success rate.
- Verification rejection rate.
- Exercise flag rate.
- Practice sessions.
- Accuracy.
- Retention/return usage.

### 20.4 Qualitative Feedback

Ask testers:

- Did the app understand the skill?
- Did the exercises feel fair?
- Did the wording match your class/source material?
- Did grading feel trustworthy?
- Did you want to come back?
- What kinds of source material failed?

### 20.5 Acceptance Criteria

- Founder uses the app for real study.
- At least a few external testers complete real sessions.
- Exercise trust problems are categorized.
- Major ingestion/generation failures are known.

## 21. Phase 18: AI Quality Evaluation System

### 21.1 Goals

Create a repeatable eval suite for AI-generated skills and exercises.

### 21.2 Eval Domains

Use:

- Spanish grammar.
- Basic derivatives.
- Fractions/decimals.
- Biology classification.
- History concept checks.

### 21.3 Eval Criteria

Rate:

- Skill splitting quality.
- Source fidelity.
- Exercise relevance.
- Answer objectivity.
- Explanation correctness.
- Difficulty appropriateness.
- Duplicate rate.
- Style match.

### 21.4 Golden Sets

Create manually reviewed examples of:

- Good skill drafts.
- Bad skill drafts.
- Good exercises.
- Bad exercises.
- Correct verifier decisions.

### 21.5 Acceptance Criteria

- Prompt changes can be evaluated before deploy.
- Exercise quality can be measured over time.
- Regressions are visible.

## 22. Phase 19: Private Beta

### 22.1 Goals

Open to a controlled group beyond close testers.

### 22.2 Product Requirements

Add:

- Better onboarding.
- Invite flow.
- Usage limits.
- Account settings.
- Data deletion.
- Error reporting.
- Feedback capture.
- Help/contact link.

### 22.3 Reliability Requirements

Improve:

- Job retries.
- AI failure handling.
- R2 cleanup.
- Database indexes.
- Rate limits.
- Cost controls.
- Monitoring.

### 22.4 Acceptance Criteria

- Users can onboard without founder help.
- Failed uploads/generation are recoverable.
- Costs remain predictable.
- The app is stable enough for real daily use.

## 23. Phase 20: Richer Subject Support

### 23.1 Goals

Make the "anything academic" promise more real.

### 23.2 Language Learning Improvements

Add:

- Accent-sensitive/insensitive controls.
- Conjugation-specific exercise templates.
- Cloze sentence inputs.
- Translation direction controls.
- Listening/audio later.

### 23.3 Math Improvements

Add:

- Better LaTeX input/rendering.
- Math keyboard or math input component.
- More robust symbolic equivalence.
- Step-free but expression-aware grading.
- Domain constraints for acceptable forms.

### 23.4 Science Improvements

Add:

- Classification questions.
- Diagram references later.
- Labeling later.
- Process ordering later.

### 23.5 Humanities Improvements

Add:

- Objective distinction prompts.
- Date/event matching.
- Cause/effect selection.
- Term-to-definition exact checks.

### 23.6 Acceptance Criteria

- Multiple subjects work without hard-coded one-off hacks.
- Subject-specific normalization exists where necessary.
- The core schema still remains general.

## 24. Phase 21: Exercise Templates And Pattern Control

### 24.1 Goals

Improve generation reliability by introducing reusable exercise pattern abstractions.

### 24.2 Template Types

Possible templates:

- Choose correct option.
- Fill one blank.
- Exact short answer.
- Numeric answer.
- Math expression.
- Identify category.
- Apply rule to example.
- Compare two concepts.

### 24.3 AI Role

AI can choose or instantiate templates, but templates constrain output into known answer-checkable shapes.

### 24.4 Acceptance Criteria

- Generation becomes more reliable.
- Exercise style becomes more consistent.
- Verification rejection rate decreases.
- New subjects can add template families.

## 25. Phase 22: Sharing And Reuse

### 25.1 Goals

Let users reuse skills and collections without introducing full collaboration.

### 25.2 Share Links

Add read-only share links:

- Skill template link.
- Collection template link.
- Copy into my account.

### 25.3 Permissions

Do not expose user attempts, source uploads, or private notes through share links by default.

### 25.4 Acceptance Criteria

- User can share a clean skill/collection template.
- Recipient can copy and practice independently.
- Private source files remain private unless explicitly included.

## 26. Phase 23: Public/Community Content

### 26.1 Goals

Explore whether public collections can help growth.

### 26.2 Features

Potential features:

- Public gallery.
- Searchable templates.
- Ratings or quality signals.
- Report content.
- Featured collections.

### 26.3 Risks

Community content adds:

- Moderation burden.
- Copyright concerns.
- Quality variance.
- Spam.

### 26.4 Acceptance Criteria

- Public content does not undermine trust.
- Reporting/moderation exists before broad launch.
- User-generated content is clearly separate from private study material.

## 27. Phase 24: Team And Classroom Foundations

### 27.1 Goals

Prepare for the long-term school/institution vision.

### 27.2 Ownership Model

Introduce:

- Workspace/organization.
- Roles.
- Membership.
- Personal workspace migration.

### 27.3 Roles

Potential roles:

- Owner.
- Instructor.
- Student.
- Admin.

### 27.4 Data Migration

Move personal ownership toward workspace-aware ownership carefully. Avoid breaking personal users.

### 27.5 Acceptance Criteria

- Personal users still work.
- Workspace users can own shared collections.
- Role-based permissions are clear.

## 28. Phase 25: Instructor Workflows

### 28.1 Goals

Allow instructors to create and assign practice material.

### 28.2 Instructor Features

Add:

- Create class.
- Invite students.
- Create collection for class.
- Upload/source skill creation.
- Review AI-generated skills.
- Assign skills.
- Set due windows.
- View class progress.

### 28.3 Student Features

Add:

- Join class.
- See assigned practice.
- Practice personal and assigned skills.
- Track progress.

### 28.4 Acceptance Criteria

- Instructor can create a class and assign skills.
- Student can practice assigned skills.
- Instructor can see aggregate progress without micromanaging.

## 29. Phase 26: Analytics For Schools

### 29.1 Goals

Provide useful analytics to instructors and administrators.

### 29.2 Instructor Analytics

Show:

- Completion.
- Accuracy.
- Due/backlog.
- Weak skills.
- Improvement over time.
- Flagged exercises.

### 29.3 Administrator Analytics

Show:

- Usage by class.
- Usage by grade/course.
- Student engagement.
- Skill mastery trends.
- License utilization.

### 29.4 Privacy

School analytics must be privacy-aware and compliant with institutional requirements.

### 29.5 Acceptance Criteria

- Analytics help instructors act.
- Analytics do not overwhelm.
- Student privacy is respected.

## 30. Phase 27: Compliance And Institutional Readiness

### 30.1 Goals

Prepare the product for K-12 and higher-ed procurement.

### 30.2 Requirements To Investigate

Potential requirements:

- FERPA.
- COPPA if serving children.
- Student data privacy agreements.
- Data retention policies.
- Role-based access.
- Audit logs.
- Data export/deletion.
- Security review docs.
- Accessibility compliance.

### 30.3 Security

Add:

- Audit logs.
- Admin controls.
- Least-privilege access.
- Secrets rotation process.
- Incident response plan.
- Vendor documentation.

### 30.4 Acceptance Criteria

- Schools can evaluate the product seriously.
- Required policies and controls are documented.
- Procurement blockers are known or addressed.

## 31. Phase 28: Billing And Packaging

### 31.1 Goals

Monetize without disrupting learning.

### 31.2 Personal Plans

Possible:

- Free tier with limited AI generation.
- Paid individual plan.
- Student discount.

### 31.3 School Plans

Possible:

- Annual per-student pricing.
- Department license.
- School license.
- District license.

### 31.4 Billing Infrastructure

Add:

- Stripe or equivalent.
- Usage metering.
- Plan limits.
- Admin billing page.
- Invoice support for schools.

### 31.5 Acceptance Criteria

- Costs map cleanly to pricing.
- Users understand limits.
- School procurement can pay annually.

## 32. Phase 29: Mobile And App-Like Experience

### 32.1 Goals

Make daily practice easy on phones.

### 32.2 Responsive Web First

Before native apps:

- Improve mobile layout.
- Improve touch targets.
- Improve keyboard behavior.
- Improve session speed.

### 32.3 PWA Later

Potential:

- Installable PWA.
- Offline cached due queue.
- Background sync.
- Push notifications.

### 32.4 Native Apps Later

Potential:

- React Native or native app.
- Better notifications.
- Offline-first practice.
- Camera-first upload.

### 32.5 Acceptance Criteria

- Mobile web is excellent before native investment.
- Native app is justified by usage, not vibes.

## 33. Phase 30: Advanced Learning Features

### 33.1 Goals

Add helpful learning-adjacent features without turning the product into a bloated tutor.

### 33.2 Possible Features

- Show source snippet after wrong answer.
- "Explain this skill" from pre-generated skill summary.
- Similar follow-up exercise after a miss.
- Weak subskill detection.
- Adaptive difficulty ramp.
- Personal generation preferences.
- Mistake notebook.
- Review history replay.

### 33.3 Guardrails

These features should support practice, not replace it. The main flow remains one exercise at a time.

### 33.4 Acceptance Criteria

- Added features improve retention and trust.
- Practice remains fast.
- The product does not become a chat tutor by accident.

## 34. Phase 31: Operational Maturity

### 34.1 Goals

Make the product reliable and maintainable.

### 34.2 Observability

Track:

- App errors.
- API latency.
- AI latency.
- AI cost.
- Queue depth.
- Job failures.
- Upload failures.
- Email failures.
- Database performance.

### 34.3 Admin Tools

Add internal tools for:

- Viewing generation jobs.
- Viewing flagged exercises.
- Retiring bad exercises.
- Reprocessing sources.
- Inspecting user support issues.

### 34.4 Cost Controls

Add:

- Per-user generation limits.
- Per-day AI caps.
- File size limits.
- Retry limits.
- Alerts.

### 34.5 Acceptance Criteria

- Failures are visible.
- Costs cannot silently explode.
- Support issues can be diagnosed.

## 35. Phase 32: Polish Criteria For A Feature-Rich Product

A polished LearnRecur should have:

- Fast skill creation from text or upload.
- High-quality skill splitting.
- Strong source-style preservation.
- Verified objective exercises.
- Instant feedback.
- Reliable FSRS scheduling.
- Trustworthy answer checking.
- Smooth desktop and mobile web UX.
- Clear progress.
- Basic reminders.
- Deletion/export controls.
- Flagging and regeneration.
- Strong eval suite.
- Low generation failure rate.
- Good onboarding.
- Strong documentation.
- Cost and rate controls.
- Private beta readiness.
- Sharing/templates when appropriate.
- Workspace/classroom features when personal product quality is proven.

## 36. Suggested Build Order Summary

1. Foundation: Next.js, TypeScript, Mantine, Prisma, envs, tests.
2. Domain: collections, skills, exercises, attempts, FSRS state.
3. Deterministic grading: choice, text, numeric, math.
4. Practice UI: due queue, feedback, rating override, flagging.
5. Dashboard: due count, skills, collections, mastery labels.
6. Manual skill creation: structured drafts and activation.
7. Auth and persistence: Clerk plus Postgres.
8. Uploads: R2 source storage.
9. AI extraction: source to skill drafts.
10. AI generation: skill to exercises.
11. AI verification: conservative quality gate.
12. Background jobs: Inngest for async workflows.
13. Queue management: verified buffers and refill triggers.
14. Data controls: delete, archive, export.
15. Reminders: Resend email.
16. V1 polish: mobile, loading, accessibility, QA.
17. Closed alpha: real use and trust feedback.
18. Eval system: measure AI quality.
19. Private beta: onboarding, reliability, cost controls.
20. Expansion: richer subjects, templates, sharing, schools, billing, mobile.

## 37. Product Risks To Watch

### 37.1 Exercise Trust Risk

If generated exercises are bad, the product fails. This is the top risk.

Mitigation:

- Conservative verification.
- Flagging.
- Evals.
- Source-style constraints.
- Deterministic answer specs.

### 37.2 Overgeneralization Risk

Trying to support every subject immediately can make every subject mediocre.

Mitigation:

- Keep core schema general.
- Use Spanish and math as serious proving grounds.
- Add subject-specific normalization only where needed.

### 37.3 Latency Risk

AI generation can be slow.

Mitigation:

- Hybrid queue.
- Background jobs.
- Small ready buffers.
- No post-submit AI calls.

### 37.4 Scope Creep Risk

School features, tutoring, sharing, analytics, and native apps can bloat the product before the core loop works.

Mitigation:

- Solo learner first.
- Practice screen first.
- Exercise trust first.

### 37.5 Cost Risk

AI generation and verification can become expensive.

Mitigation:

- Queue targets.
- Rate limits.
- Reuse verified exercises when appropriate.
- Reject/regen caps.
- Cost logging.

## 38. Guiding Principle For Future Work

Whenever a future decision is unclear, choose the option that makes this loop better:

1. The user captures a skill from real material.
2. The app turns it into a narrow, editable practice target.
3. The app creates trustworthy objective exercises.
4. The user practices quickly.
5. The app schedules the skill intelligently.
6. The user returns and remembers more.

