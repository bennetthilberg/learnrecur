# UI polish review

This branch makes the existing interface easier to read and operate without changing its fonts, colors, or design language. The current settings page supplied the reference for comfortable spacing and control sizes.

## Changes to review

- **Skills and collections:** larger titles and descriptions, aligned content widths, roomier rows, and mobile layouts that leave space for the title and action menu. Archive and permanent-delete confirmations now open directly from the skill list. Archive feedback survives the row moving between sections. Delete stays disabled until the title matches.
- **Practice:** larger prompts, inputs, answer explanations, and rating controls. Navigation occupies a stable position. Practice conceals skill and collection names while keeping navigation available.
- **Settings:** readable preference controls and explanations, less cramped spacing, and a clearer advanced section. Timezone options are deduplicated to prevent a settings crash when the runtime already includes UTC.
- **Loading:** settings reserves space for practice preferences before reminders; practice uses one continuous loading layout with a reserved answer area; custom-session setup has its own loading layout.
- **Creation, materials, and history:** more usable field sizes and textarea heights, readable helper text, better mobile history spacing, and compact review-detail facts. Needs attention no longer repeats navigation in its empty state.

## Design critique and fixes

1. **Tiny secondary text made useful information look incidental.** Raised descriptions, metadata, field help, and review details to readable sizes with appropriate line spacing.
2. **Uniformly compressed controls made simple tasks feel fiddly.** Enlarged primary controls and menu targets, and separated labels, explanations, fields, and actions.
3. **Loading placeholders implied the wrong screen.** Replaced the fake answer choices and missing settings section with placeholders that follow the actual page structure.
4. **Skill management hid the consequence of an action behind navigation.** Added local confirmations that name the skill, explain archive versus deletion, and provide a clear cancel path.
5. **Desktop rows collapsed awkwardly on phones.** Let descriptions wrap, moved status below the text, reserved space for row actions, and restored spacing between mobile history facts.

## Verification

- Lint, 1,078 unit tests, Prisma validation and generation, and production build passed.
- Signed-out browser suite passed (15 tests).
- Authenticated browser checks passed (28 tests, including setup and cleanup). Coverage includes desktop/mobile navigation, settings, skill confirmations, practice grading and persistence, mixed review, custom sessions, needs attention, history/export, and ownership guards.
- Manually inspected the core screens at 390px, 768px, and 1280px. Used the development test account and sample practice for populated views. Automated fixtures were cleaned up.

This pass does not claim exhaustive visual coverage of every uploaded-material or AI-generation state. No production deployment, push, or pull request was made. Unrelated product-discovery files were left untouched.

## Inspection follow-up: loading and action placement

- Dashboard placeholders now use the loaded hero, statistic, review, and collection structure, including the actual Active label and number line height.
- Practice reserves its toolbar, metadata, prompt, answer area, and primary-action position. Visible loading text is removed. All route skeletons use the same moving shimmer, with animation disabled for reduced motion.
- The three practice navigation items stay together on desktop and phones.
- Custom Session uses nearly balanced columns, separates the Selected skills explanation from its legend, and places Cancel before Start session on the right.
- Primary/secondary pairs in dashboard, practice completion, needs attention, and creation were reordered in the markup. Form submits align right, including settings and collection creation.
- Practice always varies related skills when available and hides their names, including after answer checking. The former Mixed Review control and help are removed from Practice, Settings, and Custom Session.

Follow-up design critique: mismatched placeholder geometry, static loading boxes, split navigation, an undersized filter column, and inconsistent action order each introduced avoidable visual or cognitive work. The changes address those five issues using existing components and styling.

Browser checks compare loading and loaded positions and stable container heights at 390px and 1280px, verify moving shimmer and reduced motion, and check navigation alignment, column proportions, action order, and the absence of the removed controls. Variable content such as long skill names, prompt length, and answer format can still require different space when loaded; placeholders do not truncate real exercise content to force an exact match.

Follow-up verification passed: lint, 1,078 unit tests, Prisma validation/generation, production build, 18 authenticated browser checks, and the final focused alignment checks. Generated Prisma formatting changes were discarded. This remains a local commit on `a/ui-polish`, with no push or PR.

## Standard practice behavior

Mixed review is now standard for the web practice experience. Existing off preferences no longer affect exercise selection. Skill names and collection cues stay hidden throughout practice, and Dashboard no longer names the skill above its exercise preview. Custom Session still offers skill selection; skill management and history retain their names.

New custom sessions use the same ordering while preserving the selected skills, tags, collections, and session mode. Historical settings and review records remain compatible without a database migration. The web client records reduced cues; older clients that may have shown a name do not falsely receive that designation.

Removed the corresponding loading placeholders and unused switch styles. Long custom-study skill names now expand their rows instead of overlapping the next item.

Verification for standard practice: lint, 1,081 unit tests, all 14 custom-session database integration tests, Prisma validation/generation, and production build passed. The affected authenticated browser suite passed 23 checks, followed by four focused loading/layout checks (both counts include setup and cleanup). Inspected rendered desktop and mobile screenshots. The full database suite was stopped in favor of the affected custom-session suite; no full-database-suite result is claimed. No push or PR.

## Practice header cleanup

Removed the redundant Review label from normal and custom practice and its loading placeholder. The state/time or exercise count now sits above the question with spacing and no upper divider; the divider below the question remains. The exercise region retains an accessible name. This change does not alter Needs attention: it lists repeated misses and missing usable exercise inventory, while All practice follows the normal due/new-skill queue.

Header cleanup verification: lint and five focused authenticated browser checks passed (including setup/cleanup); inspected desktop/mobile practice screenshots. No domain logic changed, so the database and unit suites were not rerun for this markup/CSS slice.

## Instant answer feedback

Checking an answer previously made a server-action round trip through Clerk account setup, scope validation, and a database transaction with a user-row lock before running the deterministic checker. Practice now loads the checking specification and prepared explanation with the authorized exercise. Normal and custom practice run the existing checker locally and render feedback immediately; invalid input remains editable. The initial rating uses the same shared rating policy as the server.

Continue/Save still sends the raw answer to the authoritative server path, which independently checks eligibility and correctness before writing the attempt and schedule. Client feedback does not authorize a review, and no writes are presented as saved before server confirmation. Loading the next exercise still depends on that save. Checking data is available in the learner's browser, consistent with this solo study tool rather than a secure exam.

Browser regression checks disconnect the network after loading each exercise, require feedback within 500 ms after clicking Check, reconnect, and verify the saved review. They cover choice, text, numeric, math, and custom practice.

Instant-feedback verification: lint, 1,085 unit tests, TypeScript, Prisma validation/generation, and production build passed. The learner lifecycle and retention browser checks passed; the custom-session check passed after fixing its session-id reference. Offline feedback checks passed for all four answer formats and custom practice, followed by successful persisted reviews. Server grading, authorization, and transaction logic remain unchanged. No database migration or full database-suite rerun was needed.

## Fluid Continue transitions

Normal and custom practice now preload one upcoming exercise while the learner works on the current one. Continue/Save displays that exercise immediately and confirms the prior review in the background. The learner can type, select, and check the next answer during the save; its save waits for the previous acknowledgement. A compact saving status shares the metadata row without moving the question or answers.

Lookahead reads do not introduce skills, consume daily allowances, or mark custom-plan items as presented. Normal practice excludes the current skill and revalidates its preferred next exercise against ownership, scope, due state, retirement, and the daily allowance when advancing. Custom practice previews an existing eligible plan entry; the normal server commit/presentation path remains authoritative. If the queue changes, the confirmed result replaces the preview. Without a ready preload, the existing save/load path remains available.

Save failures restore the checked answer, rating, timing, and stable attempt identity for retry. The browser warns before unloading an outstanding save and temporarily holds app-link navigation. The next answer cannot be committed or flagged while its predecessor is pending. A retry after a lost acknowledgement uses the same attempt identity rather than creating a second review. This supersedes the earlier wait-before-advancing behavior described above.

Fluid-transition verification: lint, 1,087 unit tests, all 15 custom-session database tests, Prisma validation/generation, and production build passed. Browser checks passed for the learner lifecycle, daily-limit settings at desktop/mobile widths, delayed saves, failed-save restoration, and lost-acknowledgement retries in both modes. The final six-check transition/retry run and four-check desktop/mobile alignment run passed (including setup/cleanup). Inspected the next-exercise screen while saves were deliberately held. Tests require the question to advance within 500 ms without releasing the save response and verify that a retry creates only one attempt. A repeated-effect guard avoids duplicate preload requests.

## Rolling practice buffer

Normal and custom practice now keep up to 10 upcoming questions and refill when fewer than three remain. A batch reads exercise inventory once instead of fetching each question separately. Successful advances retain the unused buffer. Returning to the browser tab refreshes it.

Normal practice buffers one question per eligible skill because answering a question changes that skill's schedule. Custom practice follows its existing session plan. Both respect the daily new-skill allowance without spending it during preloading; questions already buffered reserve space in the preview's allowance calculation. The cap limits stale predictions, rather than browser storage.

Each save still chooses and validates the next question on the server. Normal practice no longer asks the server to prefer the cached exercise, superseding the preferred-next behavior described above. If live scheduling or eligibility changes the next question, the app replaces the preview and clears the remaining predictions. The one-outstanding-save guard remains: learners can answer and check the next question while saving, but must wait for that save's acknowledgement before submitting another review.

Buffer verification covers retaining order, deduplication, capacity, read-only database behavior, reserved daily allowances, and custom-session counters. Browser tests require both the second and third questions to appear within 500 ms while save requests are deliberately held, at desktop and mobile widths. A separate test retires the buffered skill's exercises during a held save and verifies that the live queue replaces the preview without recording an attempt for it. Lost-acknowledgement retry and daily-limit browser checks also pass.

Final checks passed: lint, 1,088 unit tests, 15 custom-session database tests, Prisma validation/generation, and production build. The transition/retry/daily-limit browser run passed 10 checks, and the queue-invalidation run passed three (both counts include setup and cleanup). Generated formatting-only changes were discarded. Local branch only; no push or PR.

## Compact header alignment

The horizontal header now centers the wordmark, navigation labels, and avatar on the same line. The active underline uses an absolutely positioned marker so its border/padding no longer shifts the label. The account menu explicitly centers itself in the compact header. Phone navigation retains its separate row, and the desktop sidebar stays unchanged.

Design critique and checks: uneven label centers were corrected by removing underline space from layout; the raised avatar was corrected by overriding inherited top alignment; active/inactive links now share identical vertical geometry; navigation overflow stays inside its scrollable row; breakpoint-specific styling preserves the phone and sidebar layouts. No new font, color, control treatment, or exercise hierarchy was introduced.

A browser regression test reproduced the original three-pixel label offset, then passed at 390, 719, 720, 1000, 1119, and 1120 CSS pixels. Rendered phone, compact-header, and sidebar screenshots were inspected. Lint passed. This CSS-only slice did not rerun domain/database suites or the production build.

Instruction typography remains unchanged at the user's request. Recommendation: use the existing body-text size with regular weight for directions, retain the large bold sentence, and keep metadata at its current quieter size. This reuses three roles rather than adding another bespoke text style. Nielsen Norman Group's visual-hierarchy guidance supports limiting size/contrast variations and emphasizing the task; DWP's hint-text guidance warns that users pay less attention to supporting text, so essential conditions must stay readable. Implementation should separate instruction and question content explicitly rather than assume every first sentence is an instruction.

## Exercise instruction hierarchy

The user approved implementation. Both practice modes now render clearly marked directions at 18px/400 in the existing body font, with 12px before the bold exercise. This replaces source blank lines at the instruction boundary with controlled spacing. The 12px choice keeps directions closer to their exercise than the 24px surrounding prompt padding; it is a design judgment informed by [NN/G's proximity guidance](https://www.nngroup.com/articles/form-design-white-space/), not a research-prescribed pixel value.

Existing prompts are unstructured strings. A shared renderer splits only recognized directive prefixes followed by a colon or sentence-ending newline and nonempty content. Standalone questions, narrative opening lines, and ambiguous math prefixes retain their original rendering. Content and grading data are unchanged; a future structured instruction field would permit broader coverage without text inference.

Self-review addressed five risks: competing bold lines now have distinct weights; excessive blank-line separation becomes a 12px gap; another bespoke type tier is avoided by using body text; phone wrapping retains readable 18px directions; ambiguous prompts remain intact instead of styling every first line as an instruction. Browser checks passed in normal and custom practice at 390px and 1280px, including exact spacing, weights, blanks, and answer feedback. Desktop/mobile screenshots were inspected. Lint, TypeScript, and prompt-splitting unit tests passed. No database or grading behavior changed.
