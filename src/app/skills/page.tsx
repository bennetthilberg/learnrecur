import { auth, currentUser } from "@clerk/nextjs/server";
import { Badge, Callout, Card, DataList } from "@radix-ui/themes";
import Link from "next/link";
import type { ReactNode } from "react";

import { PanelHeaderCount } from "@/components/app/panel-header-count";
import { PressLink } from "@/components/app/open-water";
import { UserStatusPanel } from "@/components/app/user-status-panel";
import {
  getSkillsLibrary,
  type SkillsLibraryActiveSkill,
  type SkillsLibraryDraftSkill,
  type SkillsLibraryGenerationJobSummary,
  type SkillsLibraryRecoverySkill,
  type SkillsLibrarySourceProcessingSummary,
} from "@/lib/skills/library";
import { formatDisplayLabel, formatFsrsState, formatJobStatus } from "@/lib/formatters";
import { ensureDatabaseUser } from "@/lib/users";

import { SourceProcessingControls } from "./source-processing-controls";
import { SkillRowActions } from "./skill-row-actions";
import { SkillsTopbar } from "./skills-topbar";

export const dynamic = "force-dynamic";

type SkillsPageProps = {
  searchParams?: Promise<{
    createdDrafts?: string | string[];
    deletedSkill?: string | string[];
    sourceQueued?: string | string[];
  }>;
};

export default async function SkillsPage({ searchParams }: SkillsPageProps) {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const createdDraftCount = parseCreatedDraftCount(resolvedSearchParams.createdDrafts);
  const deletedSkill = parseDeletedSkill(resolvedSearchParams.deletedSkill);
  const sourceQueued = parseSourceQueued(resolvedSearchParams.sourceQueued);

  if (!clerkUser) {
    throw new Error(`Clerk returned no user for authenticated user ${userId}.`);
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);

  if (databaseUser.status !== "ready") {
    return (
      <main className="skillShell">
        <SkillsTopbar current="skills" />
        <UserStatusPanel id="skills-setup-title" status={databaseUser} />
      </main>
    );
  }

  const library = await getSkillsLibrary({
    userId,
    now: new Date(),
  });

  return (
    <main className="skillShell">
      <SkillsTopbar current="skills" />

      <header className="skillHeader">
        <div>
          <h1>Skills</h1>
          <p>Review drafts and active practice targets.</p>
        </div>
        <PressLink className="primaryButton" href="/skills/new">
          Add skill
        </PressLink>
      </header>

      {createdDraftCount ? (
        <SkillLibraryNotice tone="saved">
          Created {formatCount(createdDraftCount)} draft
          {createdDraftCount === 1 ? "" : "s"}. Review each one before activation.
        </SkillLibraryNotice>
      ) : null}

      {sourceQueued ? (
        <SkillLibraryNotice tone="saved">
          File received. Drafts will appear under Needs review after preparation.
        </SkillLibraryNotice>
      ) : null}

      {deletedSkill ? (
        <SkillLibraryNotice tone="saved">
          Skill permanently deleted.
        </SkillLibraryNotice>
      ) : null}

      {library.sourceProcessing.length > 0 ? (
        <Card asChild size="3" variant="surface">
          <section className="skillPanel skillRecoveryPanel" aria-labelledby="source-processing-title">
            <div className="skillPanelHeader">
              <div>
                <h2 id="source-processing-title">Uploads being prepared</h2>
              </div>
              <PanelHeaderCount
                ariaLabel="Uploaded material rows shown"
                label="Files"
                value={formatCount(library.sourceProcessing.length)}
              />
            </div>
            <div className="skillLibraryList">
              {library.sourceProcessing.map((sourceFile) => (
                <SourceProcessingRow key={sourceFile.id} sourceFile={sourceFile} />
              ))}
            </div>
          </section>
        </Card>
      ) : null}

      <div className="skillLibraryGrid">
        <Card asChild size="3" variant="surface">
          <section className="skillPanel skillLibraryDraftPanel" aria-labelledby="draft-skills-title">
            <div className="skillPanelHeader">
              <div>
                <h2 id="draft-skills-title">Draft skills</h2>
              </div>
              <PanelHeaderCount
                ariaLabel="Draft skills shown"
                label="Drafts"
                value={formatCount(library.draftSkills.length)}
              />
            </div>

            {library.draftSkills.length === 0 ? (
              <SkillLibraryEmptyState
                title="No drafts waiting"
                detail="Create a source-backed draft or write a manual one when you are ready."
              />
            ) : (
              <div className="skillLibraryList">
                {library.draftSkills.map((skill) => (
                  <DraftSkillRow key={skill.id} skill={skill} />
                ))}
              </div>
            )}
          </section>
        </Card>

        <Card asChild size="3" variant="surface">
          <section className="skillPanel skillLibraryActivePanel" aria-labelledby="active-skills-title">
            <div className="skillPanelHeader">
              <div>
                <h2 id="active-skills-title">Practice targets</h2>
              </div>
              <PanelHeaderCount
                ariaLabel="Active skills shown"
                label="Active"
                value={formatCount(library.activeSkills.length)}
              />
            </div>

            {library.activeSkills.length === 0 ? (
              <SkillLibraryEmptyState
                title="No active skills yet"
                detail="Activate a reviewed draft to put it into the practice schedule."
              />
            ) : (
              <div className="skillLibraryList">
                {library.activeSkills.map((skill) => (
                  <ActiveSkillRow key={skill.id} skill={skill} />
                ))}
              </div>
            )}
          </section>
        </Card>
      </div>

      {library.recoverySkills.length > 0 ? (
        <Card asChild size="3" variant="surface">
          <section className="skillPanel skillRecoveryPanel" aria-labelledby="recovery-skills-title">
            <div className="skillPanelHeader">
              <div>
                <h2 id="recovery-skills-title">Paused and archived skills</h2>
              </div>
              <PanelHeaderCount
                ariaLabel="Paused and archived skills shown"
                label="Skills"
                value={formatCount(library.recoverySkills.length)}
              />
            </div>
            <div className="skillLibraryList">
              {library.recoverySkills.map((skill) => (
                <RecoverySkillRow key={skill.id} skill={skill} />
              ))}
            </div>
          </section>
        </Card>
      ) : null}
    </main>
  );
}

function DraftSkillRow({ skill }: { skill: SkillsLibraryDraftSkill }) {
  return (
    <article className="skillLibraryRow">
      <div className="skillLibraryRowMain">
        <div>
          <Link aria-label={`Open ${skill.title}`} href={`/skills/${skill.id}`}>
            {skill.title}
            <span className="rowOpenCue" aria-hidden="true">
              Open
            </span>
          </Link>
          <p>{skill.objective ?? "Objective not set."}</p>
        </div>
        <div className="skillLibraryRowControls">
          <StatusBadge>Draft</StatusBadge>
          <SkillRowActions skillId={skill.id} skillTitle={skill.title} status="DRAFT" />
        </div>
      </div>

      <div className="skillMetaLine">
        <span>{skill.collectionName ?? "Uncollected"}</span>
        <span>{formatSourceCount(skill.sourceRefCount)}</span>
        <span>Updated {formatDate(skill.updatedAt)}</span>
        {skill.tags.slice(0, 3).map((tag) => (
          <Badge className="dashboardTag" color="gray" key={tag} radius="small" size="1" variant="surface">
            {tag}
          </Badge>
        ))}
      </div>

      {skill.latestGenerationJob ? (
        <GenerationJobStatusLine job={skill.latestGenerationJob} />
      ) : null}
    </article>
  );
}

function ActiveSkillRow({ skill }: { skill: SkillsLibraryActiveSkill }) {
  return (
    <article className="skillLibraryRow">
      <div className="skillLibraryRowMain">
        <div>
          <Link aria-label={`Open ${skill.title}`} href={`/skills/${skill.id}`}>
            {skill.title}
            <span className="rowOpenCue" aria-hidden="true">
              Open
            </span>
          </Link>
          <p>{skill.objective ?? "Objective not set."}</p>
        </div>
        <div className="skillLibraryRowControls">
          <StatusBadge tone={skill.isReadyNow ? "ready" : "neutral"}>
            {skill.dueLabel}
          </StatusBadge>
          <SkillRowActions skillId={skill.id} skillTitle={skill.title} status="ACTIVE" />
        </div>
      </div>

      <div className="skillMetaLine skillMetaLineSchedule">
        <span>{skill.collectionName ?? "Uncollected"}</span>
        <span>{formatFsrsState(skill.fsrsState)}</span>
      </div>
    </article>
  );
}

function RecoverySkillRow({ skill }: { skill: SkillsLibraryRecoverySkill }) {
  return (
    <article className="skillLibraryRow">
      <div className="skillLibraryRowMain">
        <div>
          <Link aria-label={`Open ${skill.title}`} href={`/skills/${skill.id}`}>
            {skill.title}
            <span className="rowOpenCue" aria-hidden="true">
              Open
            </span>
          </Link>
          <p>{skill.objective ?? "Objective not set."}</p>
        </div>
        <div className="skillLibraryRowControls">
          <StatusBadge>{formatSkillStatus(skill.status)}</StatusBadge>
          <SkillRowActions skillId={skill.id} skillTitle={skill.title} status={skill.status} />
        </div>
      </div>

      <div className="skillMetaLine">
        <span>{skill.collectionName ?? "Uncollected"}</span>
        <span>{skill.dueLabel}</span>
        {skill.tags.slice(0, 3).map((tag) => (
          <Badge className="dashboardTag" color="gray" key={tag} radius="small" size="1" variant="surface">
            {tag}
          </Badge>
        ))}
      </div>
    </article>
  );
}

function SourceProcessingRow({
  sourceFile,
}: {
  sourceFile: SkillsLibrarySourceProcessingSummary;
}) {
  const failed = sourceFile.status === "FAILED";
  const statusCopy = getSourceProcessingStatusCopy(sourceFile);

  return (
    <article className="skillLibraryRow sourceProcessingRow">
      <div className="skillLibraryRowMain">
        <div>
          <strong>{sourceFile.originalName}</strong>
          <p>{statusCopy}</p>
        </div>
        <StatusBadge tone={getSourceProcessingStatusTone(sourceFile)}>
          {formatSourceFileStatus(sourceFile.status)}
        </StatusBadge>
      </div>
      <DataList.Root className="sourceProcessingFacts" aria-label={`${sourceFile.originalName} draft preparation details`}>
        <DataList.Item>
          <DataList.Label>Type</DataList.Label>
          <DataList.Value>{formatSourceKind(sourceFile.kind)}</DataList.Value>
        </DataList.Item>
        <DataList.Item>
          <DataList.Label>Size</DataList.Label>
          <DataList.Value>{formatByteSize(sourceFile.byteSize)}</DataList.Value>
        </DataList.Item>
        <DataList.Item>
          <DataList.Label>Updated</DataList.Label>
          <DataList.Value>{formatDate(sourceFile.updatedAt)}</DataList.Value>
        </DataList.Item>
        <DataList.Item>
          <DataList.Label>Retries</DataList.Label>
          <DataList.Value>{sourceFile.retryCount > 0 ? formatRetryCount(sourceFile.retryCount) : "None"}</DataList.Value>
        </DataList.Item>
      </DataList.Root>
      {failed ? (
        <Callout.Root className="skillLibraryStatus" color="red" data-tone="error" variant="surface">
          <Callout.Text>Skill preparation failed. Try again, or upload a clearer excerpt.</Callout.Text>
        </Callout.Root>
      ) : null}
      <SourceProcessingControls
        sourceFileId={sourceFile.id}
        sourceFileName={sourceFile.originalName}
        canRequeue={sourceFile.canRequeue}
        canDismiss={sourceFile.canDismiss}
      />
    </article>
  );
}

function GenerationJobStatusLine({ job }: { job: SkillsLibraryGenerationJobSummary }) {
  const failed = job.status === "FAILED";

  return (
    <Callout.Root
      className="skillLibraryStatus"
      color={failed ? "red" : "gray"}
      data-tone={failed ? "error" : "neutral"}
      variant="surface"
    >
      <DataList.Root className="skillLibraryStatusFacts" aria-label="Latest preparation result">
        <DataList.Item>
          <DataList.Label>Latest preparation</DataList.Label>
          <DataList.Value>{formatJobStatus(job.status)}</DataList.Value>
        </DataList.Item>
        <DataList.Item>
          <DataList.Label>Kept</DataList.Label>
          <DataList.Value>{formatCount(job.acceptedCount)}</DataList.Value>
        </DataList.Item>
        <DataList.Item>
          <DataList.Label>Skipped</DataList.Label>
          <DataList.Value>{formatCount(job.rejectedCount)}</DataList.Value>
        </DataList.Item>
      </DataList.Root>
      {failed ? <p>Latest preparation failed. Try again when you are ready.</p> : null}
    </Callout.Root>
  );
}

function SkillLibraryEmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="dashboardEmptyState">
      <h3>{title}</h3>
      <p>{detail}</p>
      <PressLink className="secondaryButton" href="/skills/new" variant="white">
        Add skill
      </PressLink>
    </div>
  );
}

function SkillLibraryNotice({
  children,
  tone,
}: {
  children: ReactNode;
  tone: "saved";
}) {
  return (
    <Callout.Root className="skillFormMessage" color="green" data-tone={tone} role="status" variant="surface">
      <Callout.Text>{children}</Callout.Text>
    </Callout.Root>
  );
}

function StatusBadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "attention" | "danger" | "neutral" | "ready";
}) {
  const color = tone === "ready" ? "green" : tone === "danger" ? "red" : tone === "attention" ? "amber" : "gray";

  return (
    <Badge
      className="dashboardChip"
      color={color}
      data-tone={tone}
      highContrast={tone !== "neutral"}
      radius="small"
      size="1"
      variant={tone === "neutral" ? "surface" : "outline"}
    >
      {children}
    </Badge>
  );
}

function formatCount(count: number) {
  return new Intl.NumberFormat("en-US").format(count);
}

function formatDate(date: Date) {
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function formatSourceCount(count: number) {
  return count === 1 ? "1 source" : `${formatCount(count)} sources`;
}

function formatRetryCount(count: number) {
  return count === 1 ? "1 retry" : `${formatCount(count)} retries`;
}

function formatSkillStatus(status: SkillsLibraryRecoverySkill["status"]) {
  return formatDisplayLabel(status);
}

function formatSourceFileStatus(status: SkillsLibrarySourceProcessingSummary["status"]) {
  switch (status) {
    case "FAILED":
      return "Needs attention";
    case "PROCESSING":
      return "Preparing drafts";
    case "UPLOADED":
      return "File received";
  }
}

function formatSourceKind(kind: SkillsLibrarySourceProcessingSummary["kind"]) {
  return formatDisplayLabel(kind);
}

function formatByteSize(byteSize: number | null) {
  if (!byteSize) {
    return "Size unknown";
  }

  if (byteSize < 1024 * 1024) {
    return `${formatCount(Math.ceil(byteSize / 1024))} KB`;
  }

  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

function getSourceProcessingStatusCopy(sourceFile: SkillsLibrarySourceProcessingSummary) {
  if (sourceFile.status === "FAILED") {
    if (!sourceFile.canDismiss) {
      return "Draft preparation failed. This file is linked to a skill, so upload the material again if you need another draft.";
    }

    return "Draft preparation failed. Dismiss this row, then upload again when you are ready.";
  }

  if (sourceFile.status === "UPLOADED") {
    return "File received. Drafts will appear under Needs review when preparation finishes.";
  }

  if (sourceFile.isStaleProcessing) {
    return "Draft preparation appears stuck. Try again when you are ready.";
  }

  return "Draft preparation is in progress.";
}

function getSourceProcessingStatusTone(sourceFile: SkillsLibrarySourceProcessingSummary) {
  if (sourceFile.status === "FAILED") {
    return "danger";
  }

  if (sourceFile.isStaleProcessing) {
    return "attention";
  }

  return "neutral";
}

function parseCreatedDraftCount(value: string | string[] | undefined) {
  const rawValue = Array.isArray(value) ? value[0] : value;

  if (!rawValue) {
    return null;
  }

  const parsed = Number.parseInt(rawValue, 10);

  if (!Number.isInteger(parsed) || parsed < 2 || parsed > 3) {
    return null;
  }

  return parsed;
}

function parseSourceQueued(value: string | string[] | undefined) {
  const rawValue = Array.isArray(value) ? value[0] : value;
  return rawValue === "1" || rawValue === "true";
}

function parseDeletedSkill(value: string | string[] | undefined) {
  const rawValue = Array.isArray(value) ? value[0] : value;
  return rawValue === "1" || rawValue === "true";
}
