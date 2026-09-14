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

### Skill detail density checkpoint

- Item 18 implemented: missing guidance becomes one compact message with Edit retained. Partially populated guidance shows only saved sections. Practice results omit answer types without completed reviews. Empty recent-review and source panels are omitted, avoiding duplicated empty messaging.
- Moved results and recent reviews directly below Schedule in the document order. Removed named grid rows that otherwise reserve gaps for omitted content; visual and keyboard reading order now agree. Empty cards omit unnecessary descriptive copy/dividers.
- Verification: the new authenticated test failed on the original three-empty-section UI, then passed after implementation. A subsequent populated-guidance assertion exposed an incorrectly shaped test fixture (array instead of stored `{ items: [...] }`); corrected the fixture and reran. Final browser scenario checks empty/partial guidance, one empty review summary, an actual saved choice review with no unused result rows, and no overflow at 390/1280. Setup/scenario/cleanup all passed. Inspected final narrow screenshot and earlier desktop screenshot; long fixture title/collection wrap. All 1,114 unit tests passed; final TypeScript and focused ESLint passed.
- Design critique/fixes: removed three repeated missing-guidance messages, removed zero-data answer-type rows, removed duplicated no-review panels, removed decorative dividers in empty cards, and removed layout gaps/reading-order mismatches caused by fixed grid areas.
- Remaining implementation: 7, 9–12, 14, 19/20. All full-release checks listed above remain open; this is a verified checkpoint, not release completion. No push or PR.

### Settings defaults and timezones checkpoint

- Item 19 implemented: unlimited new skills displays a read-only Unlimited summary instead of a disabled 20. Default retention displays Using default: 90%; unchecking the option reveals the editable numeric value. Existing limits, fractional retention and save semantics are preserved.
- Reminder settings receive the saved practice timezone, explain its daily-allowance role separately from email delivery, and offer Use practice timezone. The shortcut changes only the form until Save changes; it includes timezones outside the short reminder preset list. Successful saves display the server-returned timezone. No reminder opt-in occurs from the shortcut.
- Verification: new timezone test failed before implementation, then passed: copies Asia/Kolkata, discards an unsaved copy on reload, persists after Save changes, and keeps reminders off. Existing retention reset/fractional-value cases passed. Daily-limit cases initially failed on an older assertion expecting one prompt text node; corrected it to compare both rendered prompt paragraphs. Both desktop/mobile daily-limit cases then passed, including practice gating. Across the runs all 5 relevant scenarios passed with setup/cleanup. All 1,114 unit tests, final TypeScript and focused ESLint passed. Inspected desktop settings and mobile reminder screenshots, with no overflow at 390/1280.
- Design critique/fixes: removed a misleading disabled 20, replaced a faint default percentage with an explicit summary, explained the two timezone purposes, avoided forcing users to search for the same timezone twice, and kept the shortcut secondary to Save changes. Existing visual language retained.
- Remaining implementation: 7, 9–12, 14, 20. Full release verification remains required. Next substantial workflow: protect unsaved settings and creation inputs, including refresh/navigation and file-input limitations. No push or PR.

### Settings draft recovery checkpoint

- Item 7 partially implemented for practice preferences (account/collection/skill scopes) and reminder settings. Explicit typed draft fields persist to account/scope-keyed sessionStorage synchronously when edited. The shared helper validates envelopes, rejects oversized/malformed values, and discards stale drafts when saved server values change. No account email, credentials or file bytes are stored. Closing the tab is outside this tab-local guarantee.
- Inputs remain disabled until restoration completes. A persistent notice distinguishes unfinished changes from saved preferences and offers Discard changes. It sits near Save so the first keystroke does not move the input. Confirmed saves clear the stored draft; failed saves retain it. Reminder drafts include time/hour/threshold but do not opt into email without the existing toggle/save action. Removed a separate reminder copy of saved props so refreshed server values remain authoritative.
- Storage failures show explicit save-before-leaving guidance and protect normal app-link/full-document navigation with a leave warning. Client-side browser Back while storage is unavailable remains an interruption edge case for the release audit; do not treat that fallback as fully verified.
- Verification: storage/hook tests cover account/scope isolation, stale baseline, malformed/oversized payloads, acknowledgement/discard, and denied-storage leave warnings. All 1,119 unit tests passed. Initial full unit run exposed missing Clerk context in two existing server-render tests; added an authenticated hook mock and reran. Final TypeScript and focused lint passed. Combined authenticated run passed all 7 scenarios plus setup/cleanup (9 total): navigation/Back/refresh recovery, failed save, discard, successful persistence, reminder draft retention, daily-limit gating at 390/1280, retention reset and fractional retention preservation. After the last reminder props correction, both reminder scenarios were rerun and passed (4 including setup/cleanup). Inspected narrow draft notices and settings screenshots; final reminder notice is below inputs.
- Design critique/fixes: avoided automatic saving disguised as draft recovery, avoided a generic serializer capturing account fields, removed a first-keystroke layout jump, retained readable pending-save copy, and kept a clear secondary discard action near Save.
- Item 7 remains open for creation inputs, file selections and draft-review forms. Next: source-creation-workspace MaterialSnapshot currently uses uncontrolled fields and only captures the form during transitions/submission; integrate typed text drafts without breaking submitted-source restoration or pretending browser file bytes survive refresh. Other remaining implementation: 9–12, 14, 20. Full-release verification still required. No push or PR.

### Source entry draft recovery checkpoint

- Item 7 now covers unfinished single-skill source text, source name, collection, focus and tags. Typed account-scoped tab drafts restore after navigation/Back/refresh; discard clears them and successful activation clears the source draft. No file bytes are persisted.
- File names survive refresh as explicit reselection reminders. Create stays disabled while any file is missing; users can deliberately continue without missing files. Partial reselection retains the remaining names, including duplicate filenames. Actual browser File objects remain the only upload source.
- Verification: new partial-reselection browser assertion failed before the fix, then passed. Both authenticated scenarios plus setup/cleanup passed (4 total), covering text/context navigation, refresh, discard, missing-file gate and partial reselection. A test initially matched both a hidden loading label and the real More options label; scoped it to the actual form and reran. All 1,121 unit tests passed; TypeScript and focused lint passed. Inspected final desktop 1280 and mobile 390 screenshots with no overflow.
- Design critique/fixes: removed ambiguous Save wording from creation recovery, avoided pretending files survived refresh, prevented partial reselection from silently dropping files, retained a persistent secondary discard action, and kept the primary Create action at the right without changing the brand.
- Item 7 remains open for material import inputs, website page selections, collection forms and draft-review editors, plus refresh during generation. Remaining feature implementation: 9–12, 14, 20. Full release verification remains open. The read-only audit also identified nested loading mismatch, skill-history context loss, inconsistent reminder saving and custom-practice focus handling for the remaining checks. No push or PR.

### Material import draft recovery checkpoint

- Item 7 now covers reusable PDF title/collection and website URL/title/collection/discovered page selections. PDF and Website panels stay mounted when switching tabs, preserving browser file selections as well as typed values. Refresh restores typed metadata and names any PDF that must be reselected; Import PDF is disabled without an actual file.
- Website drafts contain validated metadata and HTTPS links, not fetched page bodies. Server import validation remains authoritative. Successful import acknowledgement clears the stored draft; a failed website request shows a retryable error and retains the selection. Discard remains explicit. Recovery copy distinguishes an undiscovered URL from a page selection.
- Verification: the new browser test first failed on the original PDF title reset after changing tabs. Final authenticated run passed 4 scenarios plus setup/cleanup (6 total): tab/file retention, navigation/refresh/discard, seeded website page selection restoration and edits, aborted import recovery, and existing first-import layout checks at 390/820/1000/1280. The seeded website test verifies frontend recovery, not live discovery or successful server import. All 1,125 unit tests passed, including unsafe restored-link rejection and exclusion of page bodies; TypeScript and focused lint passed. Inspected 390/1280 restored-import screenshots, then corrected the notice for URLs without discovered pages.
- Design critique/fixes: stopped clearing files on source-tab changes, separated restored text from missing file bytes, avoided implying undiscovered pages were already selected, retained explicit discard near the task, and replaced silent network rejection with a recoverable error. Preserved the established layouts and visual language.
- Item 7 remains open for collection forms, source/draft review editors, and refresh during generation. Remaining feature implementation: 9–12, 14, 20; full release verification remains required. No push or PR.

### Collection and skill-editor draft checkpoint

- Item 7 now covers collection creation/editing and the shared skill-draft editor used on draft detail pages, single-source review and batch edit dialogs. Account/scope-keyed typed drafts preserve editable fields across unmount/navigation/refresh; Discard restores the last acknowledged values. Collection creation clears after acknowledgement, edit saves clear their recovery notice, and collection request failures retain the form with a retryable error.
- Skill drafts use controlled fields, including familiarity for manual creation. Server submission and activation behavior remain unchanged. A confirmed save-only batch edit persists the skill without activating it; unfinished edits do not mutate the saved database row. Recovery copy names the real next action (Save or Add), and hydration disables fields without pretending a save is running.
- Verification: collection and skill-detail recovery tests each failed on refresh before implementation. Final combined authenticated suite passed all 3 scenarios plus setup/cleanup (5 total): collection refresh/create/failure/discard/update, draft navigation/refresh/discard plus database non-mutation, and batch modal close/reopen/save plus database DRAFT status and no stale notice after reload. One initial batch run timed out at 30 seconds without a useful page snapshot; a traced rerun with a 90-second allowance passed in 10.1 seconds and the final combined run passed. No claim about the cause of that initial timeout.
- The first narrow skill-editor check found long fixture title overflow; added natural word breaking to draft headings and reran. Inspected collection 390 and skill-editor 390/1280 screenshots. The collection screenshot caught a toast mid-transition after resize; settled-toast bounds remain part of the accessibility/responsive release check. Full-page desktop captures also retain the viewport-fixed sidebar at the capture scroll position, so do not interpret that as a sidebar layout shift.
- All 1,125 unit tests passed; TypeScript and focused lint passed. An intermediate hydration-disable edit accidentally touched the separate duplicate-decision component; TypeScript and its unit test caught the out-of-scope variable reference, which was corrected before the final passing runs. No backend/domain implementation changed.
- Design critique/fixes: prevented silent loss of form edits, kept explicit Discard secondary, avoided misleading Save wording on Add flows, kept failed collection saves editable, and fixed long-title overflow without shrinking text or changing branding.
- Item 7 still needs active-skill guidance edits, batch request/scope input recovery, and generation-interruption verification. Other remaining feature implementation: 9–12, 14, 20. Full release baseline and previously listed interruption, accessibility, import and responsive checks remain required. No push or PR.
