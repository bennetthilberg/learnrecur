import { auth, currentUser } from "@clerk/nextjs/server";
import {
  ArrowLeft,
  CheckCircle,
  PencilSimple,
  WarningCircle,
} from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { notFound } from "next/navigation";

import { UserStatusPanel } from "@/components/app/user-status-panel";
import { formatDisplayLabel } from "@/lib/formatters";
import { getMaterialDraftBatch } from "@/lib/materials/batches";
import {
  materialScopePlanSchema,
  materialScopeResolutionSchema,
  skillSourceLocatorSchema,
  type MaterialScopeResolution,
} from "@/lib/materials/contracts";
import { ensureDatabaseUser } from "@/lib/users";

import { MaterialStatusPoller } from "../../materials/material-status-poller";
import { SkillsTopbar } from "../../skills-topbar";
import {
  activateMaterialBatchAction,
  confirmMaterialPlanAction,
  excludeMaterialDraftItemAction,
  replanMaterialSkillsAction,
  retryMaterialBatchActivationItemAction,
  retryMaterialDraftItemAction,
} from "../actions";
import { BatchStageRail } from "../batch-stage-rail";
import { BatchSubmitButton } from "../batch-submit-button";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

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
  const planning = !batch.confirmedAt && (batch.status === "PLANNED" || batch.status === "NEEDS_SCOPE");
  const generating = batch.status === "GENERATING" || batch.items.some((item) => item.status === "GENERATING" || item.status === "PLANNED");
  const activating = batch.status === "ACTIVATING" || batch.items.some((item) => item.status === "ACTIVATING");
  const stage = planning ? "scope" : generating ? "generate" : "review";
  const pageTitle = planning
    ? "Confirm the exact scope"
    : generating
      ? "Generating skills"
      : activating
        ? "Adding skills"
      : "Review generated skills";
  const rawError = (await searchParams)?.error;
  const error = Array.isArray(rawError) ? rawError[0] : rawError;

  return (
    <main className="skillShell materialShell batchShell">
      <SkillsTopbar current="new" />
      <MaterialStatusPoller active={generating || activating} />
      <header className="skillHeader materialHeader batchHeader">
        <div>
          <p className="materialBreadcrumb">
            <Link href={`/skills/materials/${batch.materialRevision.material.id}`}>Materials</Link> / Skill batch
          </p>
          <h1>{pageTitle}</h1>
          <p>{batch.materialRevision.material.title} · Revision {batch.materialRevision.revisionNumber}</p>
        </div>
        <Link className="secondaryButton" href={`/skills/materials/${batch.materialRevision.material.id}`}>
          <ArrowLeft size={17} weight="bold" aria-hidden="true" /> Material
        </Link>
      </header>

      <BatchStageRail current={stage} />
      {error ? <p className="skillFormMessage batchTopMessage" data-tone="error">{error}</p> : null}

      {planning && scope ? (
        <ScopeReview batchId={batch.id} instruction={batch.instruction} plan={scope} />
      ) : (
        <DraftBatchReview batch={batch} generating={generating} activating={activating} scope={scope} />
      )}
    </main>
  );
}

function ScopeReview({
  batchId,
  instruction,
  plan,
}: {
  batchId: string;
  instruction: string;
  plan: MaterialScopeResolution;
}) {
  const ambiguous = plan.resolutionStatus === "ambiguous";
  const generationCount = plan.items.filter((item) => !item.overlapSkillId).length;
  const duplicateCount = plan.items.length - generationCount;
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
          <div className="batchAmbiguity">
            <WarningCircle size={21} weight="bold" aria-hidden="true" />
            <div>
              <h3>The request is not safe to generate yet</h3>
              <p>{plan.clarification}</p>
            </div>
          </div>
        ) : (
          <ol className="batchScopeItems">
            {plan.items.map((item, index) => (
              <li key={item.key}>
                <span className="batchScopeOrdinal">{index + 1}</span>
                <div>
                  <h3>{item.title}</h3>
                  <p>{item.objective}</p>
                  <small>{formatLocator(item.locator)}</small>
                  {item.overlapWarning ? (
                    <p className="batchOverlapWarning">
                      <WarningCircle size={15} weight="bold" aria-hidden="true" /> {item.overlapWarning}
                    </p>
                  ) : null}
                </div>
              </li>
            ))}
          </ol>
        )}
        {plan.warnings.length > 0 ? (
          <div className="batchPlanWarnings">
            {plan.warnings.map((warning) => <p key={warning}>{warning}</p>)}
          </div>
        ) : null}
        {!ambiguous ? (
          <form action={confirmMaterialPlanAction} className="batchConfirmBar">
            <input name="batchId" type="hidden" value={batchId} />
            <input name="planJson" type="hidden" value={JSON.stringify(plan)} />
            <span>
              Only these source excerpts will be used
              {duplicateCount > 0
                ? `; ${duplicateCount} exact duplicate${duplicateCount === 1 ? "" : "s"} will be excluded`
                : ""}.
            </span>
            <BatchSubmitButton pendingLabel="Starting the batch…">
              {generationCount > 0 ? `Generate ${generationCount} new skills` : "Confirm exclusions"}
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
            <textarea defaultValue={instruction} maxLength={4_000} name="instruction" required rows={7} />
          </label>
          <BatchSubmitButton className="secondaryButton" pendingLabel="Resolving again…">
            Resolve again
          </BatchSubmitButton>
        </form>
      </aside>
    </div>
  );
}

function DraftBatchReview({
  batch,
  generating,
  activating,
  scope,
}: {
  batch: NonNullable<Awaited<ReturnType<typeof getMaterialDraftBatch>>>;
  generating: boolean;
  activating: boolean;
  scope: MaterialScopeResolution | null;
}) {
  const readyItems = batch.items.filter((item) => item.status === "READY" && item.skill);
  const activationFailureCount = batch.items.filter(
    (item) => item.status === "FAILED" && item.errorCode?.startsWith("ACTIVATION_"),
  ).length;
  return (
    <>
      <section className="batchProgressSummary" aria-label="Batch progress">
        <div><span>Status</span><strong>{formatDisplayLabel(batch.status)}</strong></div>
        <div><span>Ready</span><strong>{batch.readyCount}</strong></div>
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
            <p>Ready skills stay available even if another item needs a retry. This page refreshes automatically.</p>
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
            <span>{readyItems.length} ready to add</span>
            <strong>Start practice without opening every draft</strong>
            <p>Excluded drafts stay out. Each ready skill activates on its own in the background.</p>
          </div>
          <input name="batchId" type="hidden" value={batch.id} />
          {readyItems.map((item) => (
            <input key={item.id} name="itemId" type="hidden" value={item.id} />
          ))}
          <BatchSubmitButton pendingLabel="Adding skills…">
            Add all {readyItems.length}
          </BatchSubmitButton>
        </form>
      ) : null}

      <section className="batchDraftList" aria-labelledby="batch-drafts-title">
        <div className="batchDraftListHeader">
          <div><h2 id="batch-drafts-title">Draft skills</h2><p>Expand any draft to inspect it, or edit it in the full skill form.</p></div>
          {scope ? <small>{scope.resolvedScopeLabel}</small> : null}
        </div>
        {batch.items.map((item) => (
          <article className="skillPanel batchDraftCard" data-status={item.status.toLowerCase()} key={item.id}>
            <div className="batchDraftCardHeader">
              <div>
                <span>{formatDisplayLabel(item.status)}</span>
                <h3>{item.skill?.title ?? item.proposedTitle}</h3>
                <p>{item.skill?.objective ?? item.proposedObjective}</p>
              </div>
              {item.status === "READY" || item.status === "ACTIVE" ? <CheckCircle size={22} weight="fill" aria-label={item.status === "ACTIVE" ? "Added" : "Ready"} /> : null}
              {item.status === "ACTIVATING" ? <span className="materialProcessingPulse batchCardPulse" aria-label="Adding" /> : null}
              {item.status === "FAILED" ? <WarningCircle size={22} weight="bold" aria-label="Failed" /> : null}
            </div>
            {item.errorMessage ? (
              <p className="batchDraftError" data-tone={item.status === "EXCLUDED" ? "neutral" : "warning"}>
                {item.errorMessage}
              </p>
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
                {item.skill && item.status !== "ACTIVATING" ? (
                  <Link className="secondaryButton" href={`/skills/${item.skill.id}`}>
                    {item.status === "ACTIVE" ? "Open skill" : "Edit draft"}
                  </Link>
                ) : null}
                {item.status === "FAILED" ? (
                  <form action={item.errorCode?.startsWith("ACTIVATION_") ? retryMaterialBatchActivationItemAction : retryMaterialDraftItemAction}>
                    <input name="batchId" type="hidden" value={batch.id} />
                    <input name="itemId" type="hidden" value={item.id} />
                    <button className="secondaryButton" type="submit">Retry</button>
                  </form>
                ) : null}
                {item.status === "READY" || item.status === "FAILED" ? (
                  <form action={excludeMaterialDraftItemAction}>
                    <input name="batchId" type="hidden" value={batch.id} />
                    <input name="itemId" type="hidden" value={item.id} />
                    <button className="batchTextButton" type="submit">Exclude</button>
                  </form>
                ) : null}
              </div>
            </div>
          </article>
        ))}
      </section>
    </>
  );
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

function formatLocator(locator: MaterialScopeResolution["items"][number]["locator"]) {
  return locator.source.kind === "pdf"
    ? locator.source.pageRanges.map((range) => range.start === range.end ? `page ${range.start}` : `pages ${range.start}–${range.end}`).join(", ")
    : locator.source.anchors.map((anchor) => anchor.heading ?? new URL(anchor.url).pathname).join(", ");
}

function formatLocatorValue(value: unknown) {
  const locator = skillSourceLocatorSchema.safeParse(value);
  return locator.success ? formatLocator(locator.data) : "Source locator unavailable";
}
