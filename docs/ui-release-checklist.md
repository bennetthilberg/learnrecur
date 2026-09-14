# UI release improvements

Branch: `a/ui-polish`. Commit locally; do not push or open a PR.

All items below remain required. An implementation is not verified until its relevant automated and rendered checks pass.

## Requested scope

carefully, beautifully, delightfully implement all of those updates and do all of those checks, fixing anything the checks identify as needed. the list is pasted below:
Fix before the next release
1\. Protect checked answers when users leave Practice.
&#x20;  Checking shows feedback, but the review is only recorded after Continue. Leaving after seeing “Correct” silently abandons it. Preserve the pending review or offer a clear save/discard choice. Users should not need to know this implementation detail.
2\. Make slow-save navigation understandable.
&#x20;  While a review saves, app links are silently blocked. A user clicking Dashboard can reasonably think navigation is broken. Remember the requested destination and navigate after saving; show a clear recovery action if confirmation takes unusually long.
3\. Add consistent page-level error recovery.
&#x20;  I found a dedicated error boundary for Needs Attention, but not the other main routes. Add a branded error state with Retry and a useful escape route while retaining navigation. This is a source-backed gap; I did not deliberately crash the running app.
4\. Make “Start practice” on a skill page target that skill.
&#x20;  It currently opens the general practice queue. Link to Custom Session with that skill selected, or explicitly label the action “Open all practice.” The current placement promises more context than the destination delivers.
5\. Allow reporting a problem before answering—and in custom practice.
&#x20;  Normal practice exposes Report issue only after checking an answer; custom practice lacks the equivalent control. An unanswerable or broken question should not force a guess. Offer reporting before Check, with a clear explanation of whether the attempt affects the schedule.
6\. Correct the dashboard’s “Retention” metric.
&#x20;  It displays recent answer accuracy, not estimated memory retention. Rename it Recent accuracy, and provide the sample size/time window. Otherwise it appears directly comparable to the separate “Desired retention” setting when it isn’t.
7\. Protect unsaved form work.
&#x20;  Settings and creation inputs lack a general dirty-state/navigation safeguard. Preserve draft text and selections, or warn before discarding meaningful edits. Existing recovery for submitted sources does not protect notes that have not yet been submitted.
8\. Fix history’s essential content and truncated results.
&#x20;  I observed “Incorrect” shortened to “Incorr…” in the table. Review details showed “Correct answer: está” without the original sentence or the learner’s answer. Show question, your answer, correct answer, explanation together, and never truncate the correctness result.
Next improvements with the biggest everyday benefit
9\. Add search and filtering to Skills.
&#x20;  The current list works for two skills but has no search or collection/status filters. Add title search, collection filtering, and clear Active/Paused/Archived views. Test with a realistically large library rather than only sample content.
10\. Make skill organization editable.
&#x20;   The current detail-page Edit action changes practice guidance, not the skill’s title or collection. Provide obvious Rename and Move to collection actions. Users should be able to correct organization without recreating a skill.
11\. Make custom-session filters explain their result.
&#x20;   Collection, tags, recently missed, and explicitly selected skills can interact, but the screen does not preview the matching set. Show an eligible-skill count, update the list as filters change, and explain an empty match before Start session. Rename “Selected skills” to “Choose skills” when nothing is selected.
12\. Make mobile navigation discoverable and stable.
&#x20;   Some destinations disappear beyond the horizontal edge without an obvious overflow cue. The active destination also moves toward the front, changing the learned order. Keep a stable order and provide an unmistakable way to reach the remaining destinations.
13\. Make History useful beyond the latest reviews.
&#x20;   The page loads the latest 50 reviews with no pagination or filtering. Add Load more and filters for skill, collection, and incorrect answers. Otherwise users cannot reliably find an older mistake.
14\. Give completion states a useful next step.
&#x20;   “You’re all caught up” should ideally show the next scheduled review time and offer optional custom practice. Clearly distinguish:
&#x20;   \- Nothing due.
&#x20;   \- Daily new-skill allowance reached.
&#x20;   \- Exercises still being prepared.
&#x20;   These situations require different actions and should not feel like interchangeable dead ends.
15\. Simplify the first material-import experience.
&#x20;   With no saved materials, an empty “Reuse a material” panel takes almost half the page while the actual import form becomes cramped. Give importing the main space until reusable materials exist; stack title and collection fields before they become narrow.
16\. Use one vocabulary for the product’s objects.
&#x20;   Collections are also called “study areas,” and the Collections page is titled “Organize practice.” Standardize the visible names. Briefly explain the relationship once: materials provide source content, skills are practiced, collections organize skills.
Polish after those workflow fixes
17\. Bring Dashboard into line with the revised practice UI.
&#x20;   Its preview still renders instructions and exercise text together in bold, with raw-looking underscores. Reuse the practice prompt renderer. Remove promotional/mechanical copy such as “Instant check” and “update the memory schedule.” Also replace “+ New skill” under Collections with an action that matches that section.
18\. Reduce empty detail-page sections.
&#x20;   A skill with no saved guidance gets separate Rules, Examples, and Exercise focus blocks explaining that each is empty, followed by result sections with no reviews. Collapse these into compact empty states and prioritize schedule, useful results, and actions.
19\. Make defaults and timezones easier to understand.
&#x20;   Practice uses UTC in the inspected account while reminders use America/New\_York. Separate timezones can be valid, but make the difference explicit and offer “Use practice timezone” for reminders. Replace disabled placeholder-looking values with clearer summaries such as “Unlimited” or “Using default: 90%.”
20\. Replace instruction detection with structured prompt content over time.
&#x20;   The lighter instruction treatment currently recognizes certain English prefixes and punctuation. Other wording or languages can retain the old hierarchy. Store instruction and exercise content separately for new exercises, keeping a safe fallback for existing ones.
Release checks still needed
These are verification tasks, not confirmed defects:
\- Accessibility: screen-reader labels for modal close buttons, keyboard focus after navigation/feedback/errors, and announcements when the next question appears.
\- Interruption testing: offline saves, expired sessions, browser Back during saving, refresh during creation, and reopening an unfinished custom session.
\- Long-running imports: large files, partial generation failures, retry without duplication, and clear guidance on whether it is safe to leave.
\- Real-device layouts: mobile keyboards, long skill names, long answer choices, math expressions, and increased text size.

## Evidence ledger

- Work started September 14, 2026. No items marked complete yet.

### First implementation checkpoint

- Item 6: dashboard now says Recent accuracy and displays answer count plus the shared 14-day query window. Existing query semantics unchanged.
- Item 17: dashboard uses PracticePrompt (including lighter instructions and formatted blanks), removes mechanical promotional copy, and links Manage collections to Collections.
- Item 4: skill detail now links Practice this skill to `/practice/custom?skillId=...`. Existing setup resolves only active owned skills. End-to-end preselection verification still required.
- Item 3: shared PageError wired to Dashboard, Practice (including Needs Attention), History, Skills, Collections, and Settings. Retains topbar, focuses heading, offers Retry and a different route. Unit interaction test passed; deliberately induced route failures and rendered error screenshots still required.
- Checks: TypeScript passed; targeted ESLint passed; all 1,100 unit tests passed; dashboard clarity authenticated Playwright passed (plus setup/cleanup), checking overflow at 390/1000/1280. Dashboard inspected in browser at compact and narrow widths. Full build, database and release-wide browser checks remain outstanding.
- Design review: removed inaccurate metric naming, overly bold preview instructions, raw underscores, mechanical explanatory copy, and the mismatched Collections CTA. Retained existing type, colors, card and button styles.

Next: implement checked-answer preservation and save-aware navigation together, including custom practice. Preserve idempotent attempt identities, server-authoritative next-item selection and the single-outstanding-save invariant. Current `use-review-save-guard.ts` only silently blocks links while saving; both clients reset to a preview before save acknowledgement. A recovery solution must retain the original checked review as well as any new answer typed into the preview, and must cover Back/refresh/expired auth/offline behavior.

Items 1, 2, 5, 7–16, 18–20 and the full release verification matrix remain open. Do not interpret this checkpoint as completion of the goal.

### History checkpoint

- Items 8 and 13 implemented: owned review details include question, submitted answer (choice IDs resolved to labels), correct answer, and saved explanation. Supports both legacy scalar answers and current `{ raw: ... }` storage without exposing arbitrary JSON. Correctness badges do not truncate; modal has a named close button and returns focus on close. Modal primary action is right-aligned.
- History now has searchable skill/collection pickers, incorrect-only filtering, clear empty results, and Load more. Queries remain user-scoped on every page and use reviewedAt/id keyset pagination (50 rows), preserving tied timestamps. Failed loads retain current rows and permit retry; duplicate clicks/rows are guarded.
- Updated loading layout to reserve filter space. Inspected real correct/incorrect history and narrow-screen filters; corrected a missing mobile inset found in that inspection.
- Verification: history integration suite passed (5 tests, including 52 tied-timestamp reviews, cross-user cursor use, nonexistent scope filters). History answer/browser unit tests plus input tests passed (10). Authenticated browser tests passed for review detail/export isolation, skill-specific preselection, and 52-review pagination with combined filters. The pagination test checks 390/1000/1280 overflow and badge text width.
- A pre-existing lifecycle assertion assumed whitespace between instruction/content DOM nodes; updated it to compare paragraph text joined with whitespace. It failed on the first run, then passed with the actual rendering contract.
- Release-wide baseline and checks remain pending. The next core task remains items 1/2: checked-answer preservation and save-aware navigation. No changes to those clients yet. Other open items: 5, 7, 9–12, 14–16, 18–20 and full release verification.

### Practice recovery checkpoint

- Items 1/2 implemented for normal and custom practice: tab-local recovery is keyed by authenticated account and practice scope/session. Loaders restore unfinished answers before asking for a new question. Snapshots retain the original attempt identity, checked feedback inputs, rating and response time, with the in-flight review separate from the current preloaded answer. Malformed/oversized stored data is rejected; server checking and eligibility remain authoritative.
- If a save fails after the next answer has been entered, that next answer is retained separately. A retry restores it only if the authoritative next item matches. Lost acknowledgements remain idempotent. Storage failure enables a leave/discard warning instead of silently discarding the answer. Recovery is tab-local (not cross-device or permanent storage).
- App navigation during a save now remembers the clicked destination, explains the wait, and opens it after successful acknowledgement. Failed confirmation keeps the destination for a retry. A 15-second confirmation deadline restores the checked answer and enables retry; late responses cannot overwrite the recovered UI. Server operations still use the original identity on retry.
- Added a compact restored-answer notice and an explicit reload action to leave an obsolete answer. Inspected the notice at compact and narrow widths, and fixed the restored timer display to use the saved response time. Cleared the inspection-only answer without submitting a review.
- Verification: all 1,112 unit tests passed; targeted lint and TypeScript passed. The fluid-practice suite passed 11 scenarios plus setup/cleanup, including normal/custom fast advances, authoritative stale-buffer replacement, lost-ack retry, navigation/refresh recovery, queued destinations, and preservation of the next checked answer across failure plus reload. Additional interruption tests passed normal/custom Back during an in-flight save and a real 15-second confirmation timeout (3 scenarios plus setup/cleanup). Initial text assertions failed because innerText and textContent differ across the prompt's two paragraphs; fixed the assertions to compare the same DOM representation and reran successfully.
- Full release audit remains open, including actual offline/expired-auth scenarios and all outstanding feature items. Next implementation: reporting before Check and in custom practice (5), then unsaved form recovery (7), Skills search/editing (9/10), filter previews/navigation/completion/materials/copy/defaults/structured prompts (11/12/14/15/16/18/19/20). Main-route error rendering checks (3) and release-wide build/database/browser baseline also remain required.

### Reporting checkpoint

- Item 5: Report issue is available before Check and after feedback in normal and custom sessions. Both explain that reporting removes the exercise without recording an answer or changing the review schedule. Custom reports stay in the same session and use its current presented item; they do not call the normal queue or create a review. Pending saves disable reporting.
- Custom server action validates authenticated session ownership, active session status, and the presented item/exercise pair before calling the existing report/refill path. The next custom item is resolved from the existing session plan after retirement. Added rejection tests for foreign/missing sessions and mismatched exercises.
- Report submission errors retain reasons/notes and allow retry. Custom success uses the existing notification component. A successful report clears obsolete recovery drafts. Corrected a wrapping Close report button and restored focus to Report issue when closing the normal form.
- Verification: all 1,114 unit tests passed; targeted lint and TypeScript passed. Browser tests prove no attempt, no review log and unchanged due date/repetitions/lapses/state in normal, custom practice-only and custom scheduled review. First browser run failed on a test query that assumed exercise_flags contained skillId; corrected the query through exercises and reran. Inspected the real normal form without reporting the user's exercise, plus generated desktop/mobile screenshots of custom reporting. Focus-return browser assertions are included in the final focused rerun.
- Remaining implementation: 7, 9–12, 14–16, 18–20. Remaining verification includes main-route induced errors (3), offline/expired auth, form and import interruption cases, large/partial imports with idempotent retries, expanded accessibility/long-content/keyboard/zoom checks, and the full release baseline. Next: preserve unsaved settings and creation fields using account-scoped drafts or clear leave/discard protection; preserve submitted-source recovery and exclude credentials/files from generic text persistence.

### Material entry and terminology checkpoint

- Re-read the full goal objective after the read-only audit. The audit produced current rendered evidence of first-import crowding, mobile navigation ordering, confusing defaults, and remaining skill-management gaps; implementation resumes with the original 20-item scope unchanged.
- Items 15/16 implemented: the first import omits the empty reuse panel and gives Add a material the full working area. Existing materials still expose their reuse list. Title/collection fields use an intrinsic minimum width and stack before becoming cramped. The initial import skeleton matches the first-use form rather than inventing existing materials.
- Collections now uses Collections/Add a collection throughout its page, form placeholder and loading state. Add explains materials, skills and collections once in its introduction. Also corrected the Dashboard loading label from Retention to Recent accuracy.
- Verification: 24 focused loading/style unit tests passed; focused ESLint passed; TypeScript passed, including the final recheck. Authenticated Playwright passed both new scenarios plus setup/cleanup (4 total): first-use layout at 390/820/1000/1280, field widths, no page overflow, Website tab access, and consistent Collections/Add terminology. Inspected generated 390/1280 screenshots; mobile fields stack, desktop form fills its parent, primary action remains right-aligned on desktop.
- Design critique and fixes: removed the empty competing reuse card; widened the actual task area; replaced cramped equal fields with content-sensitive wrapping; removed competing names for Collections; replaced stale loading copy. Preserved existing fonts, colors and surface/button treatment.
- Remaining implementation: 7, 9–12, 14, 18–20. All previously listed release-wide error, interruption, import, accessibility and long-content checks remain required. No push or PR.
