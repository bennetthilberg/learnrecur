import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../../src/app/open-water.css", import.meta.url),
  "utf8",
);
const batchPage = readFileSync(
  new URL("../../src/app/skills/batches/[batchId]/page.tsx", import.meta.url),
  "utf8",
);
const batchActions = readFileSync(
  new URL("../../src/app/skills/batches/actions.ts", import.meta.url),
  "utf8",
);
const batchExcludeControl = readFileSync(
  new URL(
    "../../src/app/skills/batches/batch-exclude-control.tsx",
    import.meta.url,
  ),
  "utf8",
);

describe("material batch presentation", () => {
  it("uses more of the wide-screen canvas for both scope cards", () => {
    expect(styles).toMatch(
      /\.batchStageRail,[\s\S]*?\.batchActivationBar,[\s\S]*?max-width:\s*1120px;/,
    );
    expect(styles).toMatch(
      /\.batchShell \.materialHeader\s*\{[^}]*max-width:\s*1120px;/s,
    );
    expect(styles).toMatch(
      /\.batchScopeLayout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s+420px;/s,
    );
    expect(styles).toMatch(
      /@media\s*\(min-width:\s*1120px\)\s*\{[\s\S]*?\.batchShell \.materialHeader,[\s\S]*?\.batchTopMessage\s*\{[^}]*width:\s*calc\(100%\s*-\s*68px\);/,
    );
  });

  it("removes inherited card margins inside batch-owned layouts", () => {
    expect(styles).toMatch(
      /\.batchScopeLayout\s*>\s*\.skillPanel,\s*\.batchDraftList\s*>\s*\.skillPanel\s*\{[^}]*width:\s*auto;[^}]*max-width:\s*none;[^}]*margin:\s*0;/s,
    );
  });

  it("does not override primary button label contrast inside the confirmation bar", () => {
    expect(styles).toContain(".batchConfirmBar > span {");
    expect(styles).not.toContain(".batchConfirmBar span {");
    expect(styles).toContain(".batchActivationBar > div > span {");
    expect(styles).not.toContain(".batchActivationBar span {");
  });

  it("aligns the generating spinner with the notice heading", () => {
    expect(styles).toMatch(
      /\.batchGeneratingNotice\s*>\s*\.materialProcessingPulse\s*\{[^}]*margin-top:\s*4px;/s,
    );
  });

  it("uses concise retry copy for scope changes", () => {
    expect(batchPage).toMatch(/<BatchSubmitButton className="secondaryButton">\s*Try again\s*</s);
    expect(batchPage).not.toContain("Resolve again");
  });

  it("automatically repairs rejected drafts and explains the extra wait inline", () => {
    expect(batchPage).toContain("<BatchAutomaticRecovery");
    expect(batchPage).toContain("getMaterialDraftAdjustmentCopy");
    expect(batchPage).toContain("batchDraftAdjustment");
    expect(batchPage).not.toContain('"Repair draft"');
  });

  it("keeps automatic activation retries in a still-working state", () => {
    expect(batchPage).toContain("getMaterialActivationRetryCopy");
    expect(batchPage).toContain('activationRetry ? "Still working"');
    expect(batchPage).toContain("activationRetry.description");
  });

  it("keeps polling while a superseded activation can still finish", () => {
    expect(batchPage).toContain('item.errorCode === "ACTIVATION_SUPERSEDED"');
    expect(batchPage).toContain("Boolean(item.skill?.generationJobs.length)");
    expect(batchPage).toContain(
      "The other activation attempt did not finish. Add this draft again when you’re ready.",
    );
    expect(batchPage).toContain('<span aria-live="polite">');
    expect(batchPage).toMatch(
      /<p\s+aria-live="polite"\s+className="batchDraftError"/,
    );
    expect(batchPage).toContain(
      "generating || activating || activationTakeoverPending",
    );
  });

  it("keeps draft editing and exclusion in confirmed modal flows", () => {
    expect(batchPage).toContain("<BatchDraftEditDialog");
    expect(batchPage).toContain("<BatchExcludeControl");
    expect(batchPage).not.toContain('href={`/skills/${item.skill.id}`}>\n                    Edit draft');
  });

  it("makes duplicate decisions explicit without inflating bulk activation", () => {
    expect(batchPage).toContain("<BatchDuplicateDecision");
    expect(batchPage).toContain("<BatchDraftDuplicateDecision");
    expect(batchPage).toContain('item.errorCode !== "DUPLICATE_REVIEW_REQUIRED"');
    expect(batchPage).toContain('name="createSeparatelyTargetKey"');
    expect(batchPage).toContain('name="createSeparatelyItemId"');
    expect(batchPage).toContain('name="createSeparatelySkillId"');
    expect(batchPage).toContain(
      'name="createSeparatelyCandidateFingerprint"',
    );
    expect(batchPage).toContain(
      'name="createSeparatelySkillFingerprint"',
    );
    expect(batchPage).toContain("Add as a separate skill anyway");
    expect(batchPage).toContain('"Use existing skill"');
    expect(batchPage).toContain('"Keep existing draft"');
    expect(batchPage).toContain('"Keep paused skill"');
    expect(batchPage).toContain('"Keep archived skill"');
    expect(batchPage).toContain("Check and add if distinct");
    expect(batchPage).toContain("Open existing skill");
    expect(batchPage).toContain("<span>Needs a choice</span>");
    expect(batchPage).toContain("<strong>{readyItems.length}</strong>");
    expect(batchPage).toContain("existingSkillStatus={skill.status}");
    expect(batchPage).toContain("expectedCandidateFingerprint");
    expect(batchPage).toContain("This draft changed after the duplicate check");
    expect(batchPage).toContain("aria-labelledby={headingId}");
    expect(styles).toMatch(
      /\.batchDuplicateOverride\s*\{[^}]*min-height:\s*44px;/s,
    );
    expect(styles).toMatch(
      /\.batchDuplicateOverride input:focus-visible\s*\{[^}]*outline:/s,
    );
    expect(styles).toMatch(
      /\.batchExcludeModalActions,[\s\S]*?\.batchLeaveModalActions\s*\{[^}]*flex-direction:\s*column;/s,
    );
  });

  it("explains a stopped add and anchors the learner at the duplicate decision", () => {
    expect(batchActions).toContain(
      'result.status === "review-required"',
    );
    expect(batchActions).toContain('"duplicate-review"');
    expect(batchActions).toContain('"duplicate-reviews"');
    expect(batchActions).toContain("?notice=${notice}");
    expect(batchActions).toContain("#batch-draft-review-");
    expect(batchPage).toContain('"Similar skill found"');
    expect(batchPage).toContain(
      "This draft wasn’t added because it looks similar to an existing skill.",
    );
    expect(batchPage).toContain('"Similar skills found"');
    expect(batchPage).toContain(
      "These drafts weren’t added because they look similar to existing skills.",
    );
    expect(batchPage).toContain('tone="warning"');
    expect(batchPage).toContain(
      'id={usedExisting ? undefined : `batch-draft-review-${itemId}`}',
    );
    expect(batchPage).toContain(
      "tabIndex={usedExisting ? undefined : -1}",
    );
    expect(styles).toMatch(
      /\.batchDraftDuplicateDecision\[data-mode="review"\]:focus,\s*\.batchDraftDuplicateDecision\[data-mode="review"\]:target\s*\{[^}]*box-shadow:\s*inset/s,
    );
    expect(styles).toMatch(
      /\.batchDraftDuplicateDecision\s*\{[^}]*scroll-margin-top:/s,
    );
    expect(batchActions).toContain(
      'result.status === "partial" && result.reviewItemIds.length > 0',
    );
    expect(batchExcludeControl).toContain('"refreshRequired" in result');
    expect(batchExcludeControl).toContain("setOpened(false)");
    expect(batchExcludeControl).toContain("router.refresh()");
    expect(batchExcludeControl).toContain(
      ".getElementById(`batch-draft-review-${itemId}`)",
    );
    expect(batchExcludeControl).toContain("?.focus()");
  });

  it("offers a guarded route back to the skill creation start from review", () => {
    expect(batchPage).toContain("<BatchCreateMoreControl");
    expect(batchPage).toContain("unfinishedCount={unfinishedItemCount}");
    expect(batchPage).toContain('className="materialHeaderActions batchHeaderActions"');
  });
});
