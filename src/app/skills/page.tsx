import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

import { PanelHeaderCount } from "@/components/app/panel-header-count";
import { UserStatusPanel } from "@/components/app/user-status-panel";
import {
  getSkillsLibrary,
  type SkillsLibraryActiveSkill,
  type SkillsLibraryRecoverySkill,
  type SkillsLibrarySourceProcessingSummary,
} from "@/lib/skills/library";
import { formatDisplayLabel, formatFsrsState } from "@/lib/formatters";
import { ensureDatabaseUser } from "@/lib/users";

import { SourceProcessingControls } from "./source-processing-controls";
import { SourceProcessingNotifications } from "./source-processing-notifications";
import { SkillRowActions } from "./skill-row-actions";
import { SkillsTopbar } from "./skills-topbar";

export const dynamic = "force-dynamic";

type SkillsPageProps = {
  searchParams?: Promise<{
    deletedSkill?: string | string[];
    sourceQueued?: string | string[];
  }>;
};

export default async function SkillsPage({ searchParams }: SkillsPageProps) {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();
  const resolvedSearchParams = searchParams ? await searchParams : {};
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
      <SourceProcessingNotifications
        failures={library.sourceProcessing
          .filter((sourceFile) => sourceFile.status === "FAILED")
          .map((sourceFile) => ({
            id: sourceFile.id,
            message: sourceFile.errorMessage ?? "LearnRecur could not turn this material into a skill.",
            name: sourceFile.originalName,
            noticeKey: `${sourceFile.id}:${sourceFile.updatedAt.toISOString()}:${sourceFile.errorMessage ?? ""}`,
            retryable: sourceFile.canRequeue,
          }))}
      />

      <header className="skillHeader">
        <div>
          <h1>Skills</h1>
          <p>Manage the skills in your practice schedule.</p>
        </div>
        <Link className="primaryButton" href="/skills/new">
          Add skill
        </Link>
      </header>

      {sourceQueued ? (
        <p className="skillFormMessage" data-tone="saved" role="status">
          File received. Skills will appear after preparation finishes.
        </p>
      ) : null}

      {deletedSkill ? (
        <p className="skillFormMessage" data-tone="saved" role="status">
          Skill permanently deleted.
        </p>
      ) : null}

      {library.sourceProcessing.length > 0 ? (
        <section className="skillPanel skillRecoveryPanel" aria-labelledby="source-processing-title">
          <div className="skillPanelHeader">
            <div>
              <h2 id="source-processing-title">Learning material</h2>
            </div>
            <PanelHeaderCount
              ariaLabel="Learning material rows shown"
              label="Items"
              value={formatCount(library.sourceProcessing.length)}
            />
          </div>
          <div className="skillLibraryList">
            {library.sourceProcessing.map((sourceFile) => (
              <SourceProcessingRow key={sourceFile.id} sourceFile={sourceFile} />
            ))}
          </div>
        </section>
      ) : null}

      <div className="skillLibraryGrid" data-layout="single">
        <section className="skillPanel skillLibraryActivePanel" aria-labelledby="active-skills-title">
          <div className="skillPanelHeader">
            <div>
              <h2 id="active-skills-title">Skills</h2>
            </div>
            <PanelHeaderCount
              ariaLabel="Skills shown"
              label="Skills"
              value={formatCount(library.activeSkills.length)}
            />
          </div>

          {library.activeSkills.length === 0 ? (
            <SkillLibraryEmptyState
              title="No active skills"
              detail={
                library.recoverySkills.length > 0
                  ? "Restore a paused or archived skill below, or add a new one."
                  : "Add a skill to put it into practice."
              }
            />
          ) : (
            <div className="skillLibraryList">
              {library.activeSkills.map((skill) => (
                <ActiveSkillRow key={skill.id} skill={skill} />
              ))}
            </div>
          )}
        </section>
      </div>

      {library.recoverySkills.length > 0 ? (
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
      ) : null}
    </main>
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
          <span className="dashboardChip" data-tone={skill.isReadyNow ? "ready" : "neutral"}>
            {skill.dueLabel}
          </span>
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
          <span className="dashboardChip">{formatSkillStatus(skill.status)}</span>
          <SkillRowActions skillId={skill.id} skillTitle={skill.title} status={skill.status} />
        </div>
      </div>

      <div className="skillMetaLine">
        <span>{skill.collectionName ?? "Uncollected"}</span>
        <span>{skill.dueLabel}</span>
        {skill.tags.slice(0, 3).map((tag) => (
          <span className="dashboardTag" key={tag}>
            {tag}
          </span>
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
  const statusCopy = getSourceProcessingStatusCopy(sourceFile);

  return (
    <article className="skillLibraryRow sourceProcessingRow">
      <div className="skillLibraryRowMain">
        <div>
          <strong>{sourceFile.originalName}</strong>
          <p>{statusCopy}</p>
        </div>
        <span className="dashboardChip" data-tone={getSourceProcessingStatusTone(sourceFile)}>
          {formatSourceFileStatus(sourceFile.status)}
        </span>
      </div>
      <dl className="sourceProcessingFacts" aria-label={`${sourceFile.originalName} preparation details`}>
        <div>
          <dt>Type</dt>
          <dd>{formatSourceKind(sourceFile.kind)}</dd>
        </div>
        <div>
          <dt>Size</dt>
          <dd>{formatByteSize(sourceFile.byteSize)}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatDate(sourceFile.updatedAt)}</dd>
        </div>
        <div>
          <dt>Retries</dt>
          <dd>{sourceFile.retryCount > 0 ? formatRetryCount(sourceFile.retryCount) : "None"}</dd>
        </div>
      </dl>
      <SourceProcessingControls
        sourceFileId={sourceFile.id}
        sourceFileName={sourceFile.originalName}
        canRequeue={sourceFile.canRequeue}
      />
    </article>
  );
}

function SkillLibraryEmptyState({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="dashboardEmptyState">
      <h3>{title}</h3>
      <p>{detail}</p>
      <Link className="secondaryButton" href="/skills/new">
        Add skill
      </Link>
    </div>
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
      return "Preparing";
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
    if (sourceFile.canRequeue) {
      return "Skill preparation failed, but the material was saved. Try again when you are ready.";
    }

    return "Skill preparation failed. The material was saved, but this item cannot be restarted from here.";
  }

  if (sourceFile.status === "UPLOADED") {
    return "File received. Skills will appear when preparation finishes.";
  }

  if (sourceFile.isStaleProcessing) {
    return "Skill preparation appears stuck. Try again when you are ready.";
  }

  return "Skill preparation is in progress.";
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

function parseSourceQueued(value: string | string[] | undefined) {
  const rawValue = Array.isArray(value) ? value[0] : value;
  return rawValue === "1" || rawValue === "true";
}

function parseDeletedSkill(value: string | string[] | undefined) {
  const rawValue = Array.isArray(value) ? value[0] : value;
  return rawValue === "1" || rawValue === "true";
}
