import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

import { PanelHeaderCount } from "@/components/app/panel-header-count";
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
        <section className="dashboardSetupPanel" aria-labelledby="skills-setup-title">
          <h1 id="skills-setup-title">Database setup needs attention.</h1>
          <p>{databaseUser.message}</p>
        </section>
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
          <h1>Recover and schedule skills</h1>
          <p>Resume draft review, check activation issues, and scan active practice targets.</p>
        </div>
        <Link className="primaryButton" href="/skills/new">
          Add skill
        </Link>
      </header>

      {createdDraftCount ? (
        <p className="skillFormMessage" data-tone="saved" role="status">
          Created {formatCount(createdDraftCount)} draft
          {createdDraftCount === 1 ? "" : "s"}. Review each one before activation.
        </p>
      ) : null}

      {sourceQueued ? (
        <p className="skillFormMessage" data-tone="saved" role="status">
          File received. Drafts will appear under Needs review after preparation.
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
      ) : null}

      <div className="skillLibraryGrid">
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
          <span className="dashboardChip">Draft</span>
          <SkillRowActions skillId={skill.id} skillTitle={skill.title} status="DRAFT" />
        </div>
      </div>

      <div className="skillMetaLine">
        <span>{skill.collectionName ?? "Uncollected"}</span>
        <span>{formatSourceCount(skill.sourceRefCount)}</span>
        <span>Updated {formatDate(skill.updatedAt)}</span>
        {skill.tags.slice(0, 3).map((tag) => (
          <span className="dashboardTag" key={tag}>
            {tag}
          </span>
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
          <span className="dashboardChip" data-tone={skill.isReadyNow ? "ready" : "neutral"}>
            {skill.dueLabel}
          </span>
          <SkillRowActions skillId={skill.id} skillTitle={skill.title} status="ACTIVE" />
        </div>
      </div>

      <div className="skillMetaLine skillMetaLineSchedule">
        <span>{skill.collectionName ?? "Uncollected"}</span>
        <span>{formatFsrsState(skill.fsrsState)}</span>
        <span>{formatCount(skill.repetitions)} reps</span>
        <span>{formatCount(skill.lapses)} lapses</span>
      </div>
      <SkillLibraryInventoryFacts skill={skill} />
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
        <span>{formatCount(skill.repetitions)} reps</span>
        {skill.tags.slice(0, 3).map((tag) => (
          <span className="dashboardTag" key={tag}>
            {tag}
          </span>
        ))}
      </div>
      <SkillLibraryInventoryFacts skill={skill} />
    </article>
  );
}

type SkillLibraryInventoryFactSource = {
  readyExerciseCount: number;
  retiredExerciseCount: number;
  sourceRefCount: number;
  title: string;
  verifiedExerciseCount: number;
};

function SkillLibraryInventoryFacts({ skill }: { skill: SkillLibraryInventoryFactSource }) {
  return (
    <dl className="skillLibraryFacts" aria-label={`${skill.title} exercise inventory`}>
      <div data-priority="primary">
        <dt>Ready</dt>
        <dd>{formatCount(skill.readyExerciseCount)}</dd>
      </div>
      <div>
        <dt>Verified</dt>
        <dd>{formatCount(skill.verifiedExerciseCount)}</dd>
      </div>
      <div>
        <dt>Retired</dt>
        <dd>{formatCount(skill.retiredExerciseCount)}</dd>
      </div>
      <div>
        <dt>Sources</dt>
        <dd>{formatSourceCount(skill.sourceRefCount)}</dd>
      </div>
    </dl>
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
        <span className="dashboardChip" data-tone={getSourceProcessingStatusTone(sourceFile)}>
          {formatSourceFileStatus(sourceFile.status)}
        </span>
      </div>
      <dl className="sourceProcessingFacts" aria-label={`${sourceFile.originalName} draft preparation details`}>
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
      {failed && sourceFile.errorMessage ? (
        <div className="skillLibraryStatus" data-tone="error">
          <p>{sourceFile.errorMessage}</p>
        </div>
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
    <div className="skillLibraryStatus" data-tone={failed ? "error" : "neutral"}>
      <dl className="skillLibraryStatusFacts" aria-label="Latest preparation result">
        <div>
          <dt>Latest preparation</dt>
          <dd>{formatJobStatus(job.status)}</dd>
        </div>
        <div>
          <dt>Kept</dt>
          <dd>{formatCount(job.acceptedCount)}</dd>
        </div>
        <div>
          <dt>Skipped</dt>
          <dd>{formatCount(job.rejectedCount)}</dd>
        </div>
      </dl>
      {failed && job.errorMessage ? <p>{job.errorMessage}</p> : null}
    </div>
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

  return sourceFile.status === "PROCESSING" ? "attention" : "neutral";
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
