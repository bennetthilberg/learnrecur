import { randomUUID } from "node:crypto";

import { auth, currentUser } from "@clerk/nextjs/server";
import { ArrowLeft, BookOpenText } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ActionNotification } from "@/components/app/action-notification";
import { UserStatusPanel } from "@/components/app/user-status-panel";
import { getMaterialDetail } from "@/lib/materials/library";
import { getPublicMaterialActionErrorMessage } from "@/lib/materials/presentation";
import { ensureDatabaseUser } from "@/lib/users";

import { BatchRequestTextarea } from "../../../batches/batch-request-textarea";
import { BatchSubmitButton } from "../../../batches/batch-submit-button";
import { BatchStageRail } from "../../../batches/batch-stage-rail";
import { planMaterialSkillsAction } from "../../../batches/actions";
import { SkillsTopbar } from "../../../skills-topbar";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export default async function CreateMaterialSkillsPage({
  params,
  searchParams,
}: {
  params: Promise<{ materialId: string }>;
  searchParams?: Promise<{ error?: string | string[] }>;
}) {
  const { materialId } = await params;
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
        <UserStatusPanel id="material-create-setup-title" status={databaseUser} />
      </main>
    );
  }
  const material = await getMaterialDetail({ userId, materialId });
  if (!material) {
    notFound();
  }
  const revision = material.activeRevision;
  if (!revision || revision.status !== "READY") {
    return (
      <main className="skillShell materialShell">
        <SkillsTopbar current="new" />
        <header className="skillHeader materialHeader">
          <div>
            <p className="materialBreadcrumb"><Link href={`/skills/materials/${material.id}`}>Material</Link> / Create skills</p>
            <h1>{material.title}</h1>
            <p>This material must finish indexing before it can plan a skill batch.</p>
          </div>
        </header>
      </main>
    );
  }
  const rawError = (await searchParams)?.error;
  const error = getPublicMaterialActionErrorMessage(
    Array.isArray(rawError) ? rawError[0] : rawError,
    "LearnRecur could not review that scope. Check the request and try again.",
  );

  return (
    <main className="skillShell materialShell batchShell">
      <SkillsTopbar current="new" />
      <header className="skillHeader materialHeader batchCreateHeader">
        <div>
          <p className="materialBreadcrumb"><Link href={`/skills/materials/${material.id}`}>Materials</Link> / Describe</p>
          <h1>What should this book become?</h1>
          <p>Describe the exact chapters, sections, or concepts. You will confirm the resolved scope before anything is generated.</p>
        </div>
        <Link className="secondaryButton" href={`/skills/materials/${material.id}`}>
          <ArrowLeft size={17} weight="bold" aria-hidden="true" /> Material
        </Link>
      </header>

      <BatchStageRail current="describe" />
      <ActionNotification
        id="scope-planning-error"
        message={error}
        title="Could not review scope"
        tone="error"
      />

      <section className="skillPanel batchDescribePanel" aria-labelledby="batch-describe-title">
        <div className="batchMaterialIdentity">
          <BookOpenText size={21} weight="bold" aria-hidden="true" />
          <div>
            <span>Using revision {revision.revisionNumber}</span>
            <strong>{material.title}</strong>
            <small>{revision.sections.length} outline sections · {revision.pageCount ?? revision.fetchedPageCount ?? "—"} pages</small>
          </div>
        </div>
        <form action={planMaterialSkillsAction} className="batchDescribeForm">
          <input name="materialId" type="hidden" value={material.id} />
          <input name="materialRevisionId" type="hidden" value={revision.id} />
          <input name="idempotencyKey" type="hidden" value={randomUUID()} />
          <label className="skillField">
            <span>Skill request</span>
            <BatchRequestTextarea
              autoFocus
              maxLength={4_000}
              name="instruction"
              placeholder="Make skills for the three concepts in chapter four and the first concept in chapter six."
              required
              rows={6}
            />
          </label>
          <div className="batchRequestExamples" aria-label="Example requests">
            <span>Try:</span>
            <p>“The first two concepts in chapter 4”</p>
            <p>“One skill for each section under 6.2”</p>
          </div>
          <div className="skillFormActions batchPrimaryAction">
            <small>You can make up to 10 skills in one batch.</small>
            <BatchSubmitButton>Review scope</BatchSubmitButton>
          </div>
        </form>
      </section>
    </main>
  );
}
