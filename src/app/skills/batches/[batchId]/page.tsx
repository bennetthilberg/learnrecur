import { auth, currentUser } from "@clerk/nextjs/server";
import {
  ArrowLeft,
  CheckCircle,
  CopySimple,
  PencilSimple,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionNotification } from "@/components/app/action-notification";
import { UserStatusPanel } from "@/components/app/user-status-panel";
import { formatDisplayLabel } from "@/lib/formatters";
import {
  getMaterialDraftBatch,
  getMaterialDuplicateSkillPreviews,
} from "@/lib/materials/batches";
import {
  materialScopePlanSchema,
  materialScopeResolutionSchema,
  skillSourceLocatorSchema,
  type MaterialScopeResolution,
} from "@/lib/materials/contracts";
import {
  buildSkillDuplicateCandidateFingerprint,
  buildSkillSimilarityFingerprint,
} from "@/lib/skills/similarity";
import {
  getMaterialActivationRetryCopy,
  getMaterialBatchActivationCopy,
  getMaterialDraftAdjustmentCopy,
  getMaterialDraftItemErrorMessage,
  getPublicMaterialActionErrorMessage,
} from "@/lib/materials/presentation";
import { ensureDatabaseUser } from "@/lib/users";

import { MaterialStatusPoller } from "../../materials/material-status-poller";
import { SkillsTopbar } from "../../skills-topbar";
import {
  activateMaterialBatchAction,
  confirmMaterialPlanAction,
  replanMaterialSkillsAction,
  retryMaterialBatchActivationItemAction,
  retryMaterialDraftItemAction,
} from "../actions";
import { BatchAutomaticRecovery } from "../batch-automatic-recovery";
import { BatchCreateMoreControl } from "../batch-create-more-control";
import { BatchDraftEditDialog } from "../batch-draft-edit-dialog";
import { BatchExcludeControl } from "../batch-exclude-control";
import { BatchStageRail } from "../batch-stage-rail";
import { BatchRequestTextarea } from "../batch-request-textarea";
import { BatchSubmitButton } from "../batch-submit-button";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type MaterialDuplicateSkillPreview = Awaited<
  ReturnType<typeof getMaterialDuplicateSkillPreviews>
>[number];

export default async function MaterialBatchPage({
  params,
  searchParams,
}: {
  params: Promise<{ batchId: string }>;
  searchParams?: Promise<{ error?: string | string[] }>;
}) {
  const { batchId } = await params;
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();
  if (!clerkUser) {
    throw new Error(`Clerk returned no user for authenticated user ${userId}.`);
  }
  const databaseUser = await ensureDatabaseUser(clerkUser);
  if (databaseUser.status !== "ready") {
    return (
      <main className="skillShell">
        <SkillsTopbar current="new" />
        <UserStatusPanel id="batch-setup-title" status={databaseUser} />
      </main>
    );
  }
  const batch = await getMaterialDraftBatch({ userId, batchId });
  if (!batch) {
    notFound();
  }
  const proposed = materialScopeResolutionSchema.safeParse(batch.proposedPlan);
  const confirmed = materialScopePlanSchema.safeParse(batch.confirmedPlan);
  const scope = confirmed.success ? confirmed.data : proposed.success ? proposed.data : null;
  const duplicateSkills = await getMaterialDuplicateSkillPreviews({
    userId,
    skillIds: [
      ...(scope?.items.flatMap((item) =>
        item.overlapSkillId ? [item.overlapSkillId] : [],
      ) ?? []),
      ...batch.items.flatMap((item) =>
        item.overlapSkillId ? [item.overlapSkillId] : [],
      ),
    ],
  });
  const planning = !batch.confirmedAt && (batch.status === "PLANNED" || batch.status === "NEEDS_SCOPE");
  const automaticRepairItemIds = batch.items
    .filter(
      (item) =>
        item.status === "FAILED" &&
        getMaterialDraftAdjustmentCopy({
          status: item.status,
          errorCode: item.errorCode,
          generationMetadata: item.generationMetadata,
        }),
    )
    .map((item) => item.id);
  const generating =
    batch.status === "GENERATING" ||
    automaticRepairItemIds.length > 0 ||
    batch.items.some((item) => item.status === "GENERATING" || item.status === "PLANNED");
  const activating = batch.status === "ACTIVATING" || batch.items.some((item) => item.status === "ACTIVATING");
  const unfinishedItemCount = batch.items.filter(
    (item) => item.status !== "ACTIVE" && item.status !== "EXCLUDED",
  ).length;
  const stage = planning ? "scope" : generating ? "generate" : "review";
  const pageTitle = planning
    ? "Confirm the exact scope"
    : generating
      ? "Generating skills"
      : activating
        ? "Adding skills"
      : "Review generated skills";
  const rawError = (await searchParams)?.error;
  const error = getPublicMaterialActionErrorMessage(
    Array.isArray(rawError) ? rawError[0] : rawError,
    "LearnRecur could not update this batch. Try again.",
  );

  return (
    <main className="skillShell materialShell batchShell">
      <SkillsTopbar current="new" />
      <MaterialStatusPoller active={generating || activating} />
      {automaticRepairItemIds.length > 0 ? (
        <BatchAutomaticRecovery batchId={batch.id} itemIds={automaticRepairItemIds} />
      ) : null}
      <header className="skillHeader materialHeader batchHeader">
        <div>
          <p className="materialBreadcrumb">
            <Link href={`/skills/materials/${batch.materialRevision.material.id}`}>Materials</Link> / Skill batch
          </p>
          <h1>{pageTitle}</h1>
          <p>{batch.materialRevision.material.title} · Revision {batch.materialRevision.revisionNumber}</p>
        </div>
        <div className="materialHeaderActions batchHeaderActions">
          <Link className="secondaryButton" href={`/skills/materials/${batch.materialRevision.material.id}`}>
            <ArrowLeft size={17} weight="bold" aria-hidden="true" /> Material
          </Link>
          {!planning ? (
            <BatchCreateMoreControl
              readyCount={batch.readyCount}
              unfinishedCount={unfinishedItemCount}
            />
          ) : null}
        </div>
      </header>

      <BatchStageRail current={stage} />
      <ActionNotification
        id="batch-action-error"
        message={error}
        title="Could not update this batch"
        tone="error"
      />

      {planning && scope ? (
        <ScopeReview
          batchId={batch.id}
          duplicateSkills={duplicateSkills}
          instruction={batch.instruction}
          plan={scope}
        />
      ) : (
        <DraftBatchReview
          activating={activating}
          batch={batch}
          duplicateSkills={duplicateSkills}
          generating={generating}
          scope={scope}
        />
      )}
    </main>
  );
}

function ScopeReview({
  batchId,
  duplicateSkills,
  instruction,
  plan,
}: {
  batchId: string;
  duplicateSkills: MaterialDuplicateSkillPreview[];
  instruction: string;
  plan: MaterialScopeResolution;
}) {
  const ambiguous = plan.resolutionStatus === "ambiguous";
  const generationCount = plan.items.filter((item) => !item.overlapSkillId).length;
  const duplicateCount = plan.items.length - generationCount;
  const duplicateSkillById = new Map(
    duplicateSkills.map((skill) => [skill.id, skill]),
  );
  const confirmFormId = `batch-confirm-${batchId}`;
  return (
    <div className={`batchScopeLayout${ambiguous ? " isAmbiguous" : ""}`}>
      <section className="skillPanel batchScopePanel" aria-labelledby="batch-scope-title">
        <div className="batchScopeHeader">
          <div>
            <span>{ambiguous ? "Clarification needed" : "Resolved source scope"}</span>
            <h2 id="batch-scope-title">{plan.resolvedScopeLabel}</h2>
          </div>
          <strong>{plan.items.length} proposed</strong>
        </div>
        {ambiguous ? (
          <>
            <ActionNotification
              id={`batch-scope-clarification-${batchId}`}
              message={plan.clarification}
              title="Clarify this skill request"
              tone="warning"
            />
            <p className="batchClarificationReason">{plan.clarification}</p>
            {plan.clarificationOptions?.length ? (
              <div className="batchClarificationOptions" aria-label="Suggested clarifications">
                {plan.clarificationOptions.map((option) => (
                  <form action={replanMaterialSkillsAction} key={option.instruction}>
                    <input name="batchId" type="hidden" value={batchId} />
                    <input name="instruction" type="hidden" value={option.instruction} />
                    <BatchSubmitButton className="secondaryButton">
                      {option.label}
                    </BatchSubmitButton>
                    {option.description ? <small>{option.description}</small> : null}
                  </form>
                ))}
              </div>
            ) : null}
          </>
        ) : (
          <ol className="batchScopeItems">
            {plan.items.map((item, index) => {
              const duplicateCandidate = item.overlapSkillId
                ? duplicateSkillById.get(item.overlapSkillId)
                : undefined;
              const duplicateSkill =
                duplicateCandidate &&
                item.overlapSkillFingerprint &&
                buildSkillSimilarityFingerprint(duplicateCandidate) ===
                  item.overlapSkillFingerprint
                  ? duplicateCandidate
                  : undefined;
              return (
                <li key={item.key}>
                <span className="batchScopeOrdinal">{index + 1}</span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.objective}</p>
                  {item.excludeConcepts?.length ? (
                    <p className="batchScopeBoundary">
                      <strong>Kept separate:</strong> {item.excludeConcepts.join(", ")}
                    </p>
                  ) : null}
                  <small>{formatLocator(item.locator)}</small>
                  {item.overlapSkillId ? (
                    <BatchDuplicateDecision
                      checkboxFormId={confirmFormId}
                      confidence={item.overlapConfidence}
                      defaultCreateSeparately={!duplicateSkill}
                      itemKey={item.key}
                      skill={duplicateSkill}
                      warning={item.overlapWarning}
                    />
                  ) : item.overlapWarning ? (
                    <p className="batchOverlapWarning">
                      <WarningCircle size={15} weight="bold" aria-hidden="true" />
                      {item.overlapWarning}
                    </p>
                  ) : null}
                </div>
                </li>
              );
            })}
          </ol>
        )}
        {plan.warnings.length > 0 ? (
          <div className="batchPlanWarnings">
            {plan.warnings.map((warning) => <p key={warning}>{warning}</p>)}
          </div>
        ) : null}
        {!ambiguous ? (
          <form
            action={confirmMaterialPlanAction}
            className="batchConfirmBar"
            id={confirmFormId}
          >
            <input name="batchId" type="hidden" value={batchId} />
            <input name="planJson" type="hidden" value={JSON.stringify(plan)} />
            <span>
              Only these source excerpts will be used.
              {duplicateCount > 0
                ? " Similar items will skip a second skill unless you choose otherwise. The existing skill’s status will not change."
                : ""}
            </span>
            <BatchSubmitButton>
              {generationCount > 0 ? "Continue with this plan" : "Confirm this plan"}
            </BatchSubmitButton>
          </form>
        ) : null}
      </section>

      <aside className="skillPanel batchScopeCorrection">
        <div>
          <PencilSimple size={19} weight="bold" aria-hidden="true" />
          <h2>{ambiguous ? "Clarify the request" : "Change the request"}</h2>
        </div>
        <form action={replanMaterialSkillsAction}>
          <input name="batchId" type="hidden" value={batchId} />
          <label className="skillField">
            <span>Skill request</span>
            <BatchRequestTextarea
              defaultValue={instruction}
              maxLength={4_000}
              name="instruction"
              required
              rows={7}
            />
          </label>
          <BatchSubmitButton className="secondaryButton">
            Try again
          </BatchSubmitButton>
        </form>
      </aside>
    </div>
  );
}

function BatchDuplicateDecision({
  checkboxFormId,
  confidence,
  defaultCreateSeparately,
  itemKey,
  skill,
  warning,
}: {
  checkboxFormId: string;
  confidence?: "exact" | "likely" | "possible";
  defaultCreateSeparately: boolean;
  itemKey: string;
  skill?: MaterialDuplicateSkillPreview;
  warning?: string;
}) {
  const headingId = `batch-plan-duplicate-${itemKey}`;
  const choice = skill ? getExistingSkillChoiceCopy(skill.status) : null;
  return (
    <section
      aria-labelledby={headingId}
      className="batchDuplicateDecision"
      data-confidence={confidence ?? "exact"}
    >
      <div className="batchDuplicateLead">
        <CopySimple aria-hidden="true" size={18} weight="fill" />
        <div>
          <h4 id={headingId}>You may already have this skill</h4>
          <p>
            {warning ??
              "Compare the existing skill before creating another review schedule."}
          </p>
        </div>
      </div>
      {skill ? (
        <>
          <BatchDuplicatePreview skill={skill} />
          <p className="batchDuplicateOutcome">{choice?.planningOutcome}</p>
        </>
      ) : (
        <p className="batchDuplicateUnavailable">
          The matched skill changed or is no longer available. This draft will
          be created separately.
        </p>
      )}
      {skill ? (
        <label className="batchDuplicateOverride">
          <input
            defaultChecked={defaultCreateSeparately}
            form={checkboxFormId}
            name="createSeparatelyTargetKey"
            type="checkbox"
            value={itemKey}
          />
          <span>
            <strong>Create a separate skill anyway</strong>
            <small>This adds another review schedule for substantially similar material.</small>
          </span>
        </label>
      ) : null}
    </section>
  );
}

function BatchDuplicatePreview({
  actionClassName = "primaryButton",
  skill,
}: {
  actionClassName?: string;
  skill: MaterialDuplicateSkillPreview;
}) {
  return (
    <div className="batchDuplicatePreview">
      <div>
        <span>Existing skill</span>
        <h4>{skill.title}</h4>
        <p>{skill.objective?.trim() || "No objective has been saved."}</p>
      </div>
      <dl>
        <div>
          <dt>Status</dt>
          <dd>{formatDisplayLabel(skill.status)}</dd>
        </div>
        <div>
          <dt>Collection</dt>
          <dd>{skill.collection?.name ?? "No collection"}</dd>
        </div>
        <div>
          <dt>Tags</dt>
          <dd>{skill.tags.length > 0 ? skill.tags.join(", ") : "No tags"}</dd>
        </div>
      </dl>
      <Link className={actionClassName} href={`/skills/${skill.id}`}>
        Open existing skill
      </Link>
    </div>
  );
}

function BatchDraftDuplicateDecision({
  batchId,
  candidateSkill,
  canCreateSeparately,
  draftTitle,
  itemId,
  reviewChanged,
  skill,
  usedExisting,
  warning,
}: {
  batchId: string;
  candidateSkill?: {
    id: string;
    title: string;
    objective: string | null;
    collectionId: string | null;
    rules: unknown;
    examples: unknown;
    exerciseConstraints: unknown;
    tags: readonly string[];
  };
  canCreateSeparately: boolean;
  draftTitle: string;
  itemId: string;
  reviewChanged: boolean;
  skill?: MaterialDuplicateSkillPreview;
  usedExisting: boolean;
  warning: string | null;
}) {
  const headingId = `batch-draft-duplicate-${itemId}`;
  const choice = skill ? getExistingSkillChoiceCopy(skill.status) : null;
  return (
    <section
      aria-labelledby={headingId}
      className="batchDraftDuplicateDecision"
      data-mode={usedExisting ? "existing" : "review"}
    >
      <div className="batchDuplicateLead">
        <CopySimple aria-hidden="true" size={19} weight="fill" />
        <div>
          <h4 id={headingId}>
            {usedExisting
              ? choice?.keptHeading ?? "Kept your existing skill"
              : "Compare before adding"}
          </h4>
          <p>
            {warning ??
              (usedExisting
                ? "LearnRecur skipped a second review schedule for this material."
                : "This draft may repeat a skill already in your library.")}
          </p>
        </div>
      </div>
      {skill ? (
        <BatchDuplicatePreview
          actionClassName={usedExisting ? "primaryButton" : "secondaryButton"}
          skill={skill}
        />
      ) : (
        <p className="batchDuplicateUnavailable">
          {canCreateSeparately
            ? reviewChanged
              ? "This draft changed after the duplicate check. Check it again before deciding whether to add it."
              : "The matched skill changed or is no longer available. Check and add this draft if it is distinct."
            : "The existing skill kept by this batch has since been removed."}
        </p>
      )}
      {canCreateSeparately ? (
        <div className="batchDraftDuplicateActions">
          {skill && candidateSkill ? (
            <BatchExcludeControl
              batchId={batchId}
              className="primaryButton batchExcludeTrigger"
              existingSkillStatus={skill.status}
              existingSkillTitle={skill.title}
              expectedCandidateFingerprint={
                buildSkillDuplicateCandidateFingerprint(candidateSkill)
              }
              expectedCandidateId={candidateSkill.id}
              expectedMatchFingerprint={buildSkillSimilarityFingerprint(skill)}
              expectedMatchId={skill.id}
              intent="use-existing"
              itemId={itemId}
              label={choice?.keepLabel}
              title={draftTitle}
            />
          ) : null}
          <form action={activateMaterialBatchAction}>
            <input name="batchId" type="hidden" value={batchId} />
            <input name="itemId" type="hidden" value={itemId} />
            <BatchSubmitButton
              className={skill ? "secondaryButton" : "primaryButton"}
            >
              Check and add if distinct
            </BatchSubmitButton>
          </form>
          {skill ? (
            <form action={activateMaterialBatchAction}>
              <input name="batchId" type="hidden" value={batchId} />
              <input name="itemId" type="hidden" value={itemId} />
              <input
                name="createSeparatelyItemId"
                type="hidden"
                value={itemId}
              />
              <input
                name="createSeparatelySkillId"
                type="hidden"
                value={skill.id}
              />
              <BatchSubmitButton className="secondaryButton batchDuplicateOverrideAction">
                Add as a separate skill anyway
              </BatchSubmitButton>
            </form>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function DraftBatchReview({
  batch,
  generating,
  activating,
  duplicateSkills,
  scope,
}: {
  batch: NonNullable<Awaited<ReturnType<typeof getMaterialDraftBatch>>>;
  generating: boolean;
  activating: boolean;
  duplicateSkills: MaterialDuplicateSkillPreview[];
  scope: MaterialScopeResolution | null;
}) {
  const readyItems = batch.items.filter(
    (item) =>
      item.status === "READY" &&
      item.skill?.status === "DRAFT" &&
      item.errorCode !== "DUPLICATE_REVIEW_REQUIRED",
  );
  const duplicateReviewCount = batch.items.filter(
    (item) =>
      item.status === "READY" &&
      item.errorCode === "DUPLICATE_REVIEW_REQUIRED",
  ).length;
  const duplicateSkillById = new Map(
    duplicateSkills.map((skill) => [skill.id, skill]),
  );
  const activationCopy = getMaterialBatchActivationCopy(readyItems.length);
  const activationFailureCount = batch.items.filter(
    (item) => item.status === "FAILED" && item.errorCode?.startsWith("ACTIVATION_"),
  ).length;
  return (
    <>
      <section className="batchProgressSummary" aria-label="Batch progress">
        <div><span>Status</span><strong>{formatDisplayLabel(batch.status)}</strong></div>
        <div><span>Ready</span><strong>{readyItems.length}</strong></div>
        <div><span>Needs a choice</span><strong>{duplicateReviewCount}</strong></div>
        <div><span>Failed</span><strong>{batch.failedCount}</strong></div>
        <div><span>Excluded</span><strong>{batch.excludedCount}</strong></div>
        <div><span>Added</span><strong>{batch.activatedCount}</strong></div>
      </section>

      {activating ? (
        <section className="skillPanel batchGeneratingNotice batchActivatingNotice" aria-live="polite">
          <span className="materialProcessingPulse" aria-hidden="true" />
          <div>
            <h2>Adding each skill independently</h2>
            <p>Practice activates as each skill finishes. A failure will not roll back skills that are already ready.</p>
          </div>
        </section>
      ) : generating ? (
        <section className="skillPanel batchGeneratingNotice" aria-live="polite">
          <span className="materialProcessingPulse" aria-hidden="true" />
          <div>
            <h2>Drafts are arriving independently</h2>
            <p>Ready skills stay available while LearnRecur checks and adjusts the others. This page refreshes automatically.</p>
          </div>
        </section>
      ) : batch.status === "PARTIAL" || batch.status === "FAILED" ? (
        <section className="skillPanel batchPartialNotice">
          <WarningCircle size={20} weight="bold" aria-hidden="true" />
          <div>
            <h2>
              {activationFailureCount > 0
                ? batch.status === "FAILED"
                  ? "Skills were not added"
                  : "Some skills were not added"
                : batch.status === "FAILED"
                  ? "Draft generation needs attention"
                  : "Some drafts need attention"}
            </h2>
            <p>
              {activationFailureCount > 0
                ? "Skills already added remain active. Retry or exclude each failed item below."
                : "Ready drafts were kept. Retry or exclude each failed item below."}
            </p>
          </div>
        </section>
      ) : null}

      {readyItems.length > 0 && !generating ? (
        <form action={activateMaterialBatchAction} className="batchActivationBar">
          <div>
            <span>{activationCopy.countLabel}</span>
            <strong>Start practice without opening every draft</strong>
            <p>Excluded drafts stay out. Each ready skill activates on its own in the background.</p>
          </div>
          <input name="batchId" type="hidden" value={batch.id} />
          {readyItems.map((item) => (
            <input key={item.id} name="itemId" type="hidden" value={item.id} />
          ))}
          <BatchSubmitButton>
            {activationCopy.actionLabel}
          </BatchSubmitButton>
        </form>
      ) : null}

      <section className="batchDraftList" aria-labelledby="batch-drafts-title">
        <div className="batchDraftListHeader">
          <div><h2 id="batch-drafts-title">Draft skills</h2><p>Expand any draft to inspect it, or edit it here without leaving the batch.</p></div>
          {scope ? <small>{scope.resolvedScopeLabel}</small> : null}
        </div>
        {batch.items.map((item) => {
          const duplicateNeedsReview =
            item.status === "READY" &&
            item.errorCode === "DUPLICATE_REVIEW_REQUIRED";
          const usedExisting =
            item.status === "EXCLUDED" &&
            (item.errorCode === "DUPLICATE_USE_EXISTING" ||
              item.errorCode === "EXACT_DUPLICATE");
          const duplicateCandidate = item.overlapSkillId
            ? duplicateSkillById.get(item.overlapSkillId)
            : undefined;
          const storedDuplicateMatch = readStoredDuplicateMatch(
            item.generationMetadata,
          );
          const candidateReviewIsCurrent =
            !duplicateNeedsReview ||
            Boolean(
              item.skill &&
                storedDuplicateMatch?.candidateSkillId === item.skill.id &&
                storedDuplicateMatch.candidateFingerprint ===
                  buildSkillDuplicateCandidateFingerprint(item.skill),
            );
          const duplicateSkill =
            duplicateCandidate &&
            (!duplicateNeedsReview ||
              (candidateReviewIsCurrent &&
                storedDuplicateMatch?.skillId === duplicateCandidate.id &&
                storedDuplicateMatch.skillFingerprint ===
                  buildSkillSimilarityFingerprint(duplicateCandidate)))
              ? duplicateCandidate
              : undefined;
          const adjustment = getMaterialDraftAdjustmentCopy({
            status: item.status,
            errorCode: item.errorCode,
            generationMetadata: item.generationMetadata,
          });
          const activationRetry = getMaterialActivationRetryCopy({
            status: item.status,
            errorCode: item.errorCode,
          });
          return (
            <article
              className="skillPanel batchDraftCard"
              data-status={
                duplicateNeedsReview
                  ? "review"
                  : adjustment || activationRetry
                    ? "generating"
                    : item.status.toLowerCase()
              }
              key={item.id}
            >
            <div className="batchDraftCardHeader">
              <div>
                <span>
                  {duplicateNeedsReview
                    ? "Needs a choice"
                    : usedExisting
                      ? "Kept existing"
                    : activationRetry
                      ? "Still working"
                      : adjustment
                        ? "Adjusting"
                        : formatDisplayLabel(item.status)}
                </span>
                <h3>{item.skill?.title ?? item.proposedTitle}</h3>
                <p>{item.skill?.objective ?? item.proposedObjective}</p>
              </div>
              {(item.status === "READY" && !duplicateNeedsReview) ||
              item.status === "ACTIVE" ? (
                <CheckCircle
                  size={22}
                  weight="fill"
                  aria-label={item.status === "ACTIVE" ? "Added" : "Ready"}
                />
              ) : null}
              {duplicateNeedsReview ? (
                <WarningCircle
                  size={22}
                  weight="fill"
                  aria-label="Similar skill needs review"
                />
              ) : null}
              {item.status === "ACTIVATING" || adjustment ? <span className="materialProcessingPulse batchCardPulse" aria-label={activationRetry ? "Still working" : item.status === "ACTIVATING" ? "Adding" : "Adjusting"} /> : null}
              {item.status === "FAILED" && !adjustment ? <WarningCircle size={22} weight="bold" aria-label="Failed" /> : null}
            </div>
            {adjustment ? (
              <p className="batchDraftAdjustment" aria-live="polite">
                <strong>{adjustment.title}</strong>
                <span>{adjustment.description}</span>
              </p>
            ) : activationRetry ? (
              <p className="batchDraftAdjustment" aria-live="polite">
                <strong>{activationRetry.title}</strong>
                <span>{activationRetry.description}</span>
              </p>
            ) : !duplicateNeedsReview &&
              !usedExisting &&
              getMaterialDraftItemErrorMessage(item.errorCode, item.errorMessage) ? (
              <p className="batchDraftError" data-tone={item.status === "EXCLUDED" ? "neutral" : "warning"}>
                {getMaterialDraftItemErrorMessage(item.errorCode, item.errorMessage)}
              </p>
            ) : null}
            {duplicateNeedsReview || usedExisting ? (
              <BatchDraftDuplicateDecision
                batchId={batch.id}
                candidateSkill={
                  duplicateNeedsReview && candidateReviewIsCurrent
                    ? item.skill ?? undefined
                    : undefined
                }
                canCreateSeparately={duplicateNeedsReview}
                draftTitle={item.skill?.title ?? item.proposedTitle}
                itemId={item.id}
                reviewChanged={
                  duplicateNeedsReview && !candidateReviewIsCurrent
                }
                skill={duplicateSkill}
                usedExisting={usedExisting}
                warning={item.errorMessage}
              />
            ) : null}
            {item.skill ? (
              <details className="batchDraftDetails">
                <summary>Review draft</summary>
                <div className="batchDraftContent">
                  <DraftField label="Rules" values={readNoteItems(item.skill.rules)} />
                  <DraftField label="Examples" values={readNoteItems(item.skill.examples)} />
                  <DraftField label="Practice guidance" values={readConstraintNotes(item.skill.exerciseConstraints)} />
                  <DraftTags values={item.skill.tags} />
                </div>
              </details>
            ) : null}
            <div className="batchDraftActions">
              <small>{formatLocatorValue(item.locator)}</small>
              <div>
                {item.skill && item.status === "ACTIVE" ? (
                  <Link className="secondaryButton" href={`/skills/${item.skill.id}`}>
                    Open skill
                  </Link>
                ) : null}
                {item.skill && item.status !== "ACTIVE" && item.status !== "ACTIVATING" ? (
                  <BatchDraftEditDialog
                    initialValues={{
                      title: item.skill.title,
                      objective: item.skill.objective ?? "",
                      collectionName: item.skill.collection?.name ?? "",
                      rules: readNotesText(item.skill.rules),
                      examples: readNotesText(item.skill.examples),
                      exerciseConstraints: readNotesText(item.skill.exerciseConstraints),
                      tags: item.skill.tags.join(", "),
                    }}
                    skillId={item.skill.id}
                  />
                ) : null}
                {item.status === "FAILED" && !adjustment ? (
                  <form action={item.errorCode?.startsWith("ACTIVATION_") ? retryMaterialBatchActivationItemAction : retryMaterialDraftItemAction}>
                    <input name="batchId" type="hidden" value={batch.id} />
                    <input name="itemId" type="hidden" value={item.id} />
                    <BatchSubmitButton className="secondaryButton">
                      Retry
                    </BatchSubmitButton>
                  </form>
                ) : null}
                {(item.status === "READY" && !duplicateNeedsReview) ||
                (item.status === "FAILED" && !adjustment) ? (
                  <BatchExcludeControl
                    batchId={batch.id}
                    itemId={item.id}
                    title={item.skill?.title ?? item.proposedTitle}
                  />
                ) : null}
              </div>
            </div>
            </article>
          );
        })}
      </section>
    </>
  );
}

function getExistingSkillChoiceCopy(
  status: MaterialDuplicateSkillPreview["status"],
) {
  switch (status) {
    case "ACTIVE":
      return {
        keepLabel: "Use existing skill",
        keptHeading: "Using your existing active skill",
        planningOutcome:
          "It is already in practice. Continuing skips a second review schedule.",
      };
    case "DRAFT":
      return {
        keepLabel: "Keep existing draft",
        keptHeading: "Kept your existing draft",
        planningOutcome:
          "It will stay a draft. Open it to add it to practice; continuing skips a second skill.",
      };
    case "PAUSED":
      return {
        keepLabel: "Keep paused skill",
        keptHeading: "Kept your existing paused skill",
        planningOutcome:
          "It will stay paused. Open it to resume practice; continuing skips a second skill.",
      };
    case "ARCHIVED":
      return {
        keepLabel: "Keep archived skill",
        keptHeading: "Kept your existing archived skill",
        planningOutcome:
          "It will stay archived. Open it to restore it; continuing skips a second skill.",
      };
  }
}

function DraftField({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) {
    return null;
  }
  return (
    <div>
      <strong>{label}</strong>
      <ul>{values.map((value) => <li key={value}>{value}</li>)}</ul>
    </div>
  );
}

function DraftTags({ values }: { values: string[] }) {
  if (values.length === 0) {
    return null;
  }
  return (
    <div className="batchDraftTags">
      <strong>Tags</strong>
      <p>{values.map((value) => <span key={value}>{value}</span>)}</p>
    </div>
  );
}

function readNoteItems(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const items = (value as { items?: unknown }).items;
  return Array.isArray(items) ? items.filter((item): item is string => typeof item === "string") : [];
}

function readConstraintNotes(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const notes = (value as { notes?: unknown }).notes;
  return typeof notes === "string" && notes.trim() ? [notes.trim()] : [];
}

function readNotesText(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }
  const notes = value as { items?: unknown; notes?: unknown };
  if (Array.isArray(notes.items)) {
    return notes.items.filter((item): item is string => typeof item === "string").join("\n");
  }
  return typeof notes.notes === "string" ? notes.notes : "";
}

function readStoredDuplicateMatch(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const duplicateMatch = (value as { duplicateMatch?: unknown })
    .duplicateMatch;
  if (
    !duplicateMatch ||
    typeof duplicateMatch !== "object" ||
    Array.isArray(duplicateMatch)
  ) {
    return null;
  }
  const stored = duplicateMatch as {
    candidateFingerprint?: unknown;
    candidateSkillId?: unknown;
    skillId?: unknown;
    skillFingerprint?: unknown;
  };
  return typeof stored.candidateSkillId === "string" &&
    typeof stored.candidateFingerprint === "string" &&
    typeof stored.skillId === "string" &&
    typeof stored.skillFingerprint === "string"
    ? {
        candidateSkillId: stored.candidateSkillId,
        candidateFingerprint: stored.candidateFingerprint,
        skillId: stored.skillId,
        skillFingerprint: stored.skillFingerprint,
      }
    : null;
}

function formatLocator(locator: MaterialScopeResolution["items"][number]["locator"]) {
  return locator.source.kind === "pdf"
    ? locator.source.pageRanges.map((range) => range.start === range.end ? `page ${range.start}` : `pages ${range.start}–${range.end}`).join(", ")
    : locator.source.anchors.map((anchor) => anchor.heading ?? new URL(anchor.url).pathname).join(", ");
}

function formatLocatorValue(value: unknown) {
  const locator = skillSourceLocatorSchema.safeParse(value);
  return locator.success ? formatLocator(locator.data) : "Source locator unavailable";
}
