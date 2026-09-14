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
