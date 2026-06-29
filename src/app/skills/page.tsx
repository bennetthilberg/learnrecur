import { auth, currentUser } from "@clerk/nextjs/server";
import { PlusCircle } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";

import { PanelHeaderCount } from "@/components/app/panel-header-count";
import { UserStatusPanel } from "@/components/app/user-status-panel";
import {
  getSkillsLibrary,
  type SkillsLibraryActiveSkill,
  type SkillsLibraryRecoverySkill,
} from "@/lib/skills/library";
import { formatDisplayLabel, formatFsrsState } from "@/lib/formatters";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillRowActions } from "./skill-row-actions";
import { SkillsTopbar } from "./skills-topbar";

export const dynamic = "force-dynamic";

type SkillsPageProps = {
  searchParams?: Promise<{
    deletedSkill?: string | string[];
  }>;
};

export default async function SkillsPage({ searchParams }: SkillsPageProps) {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();
  const resolvedSearchParams = searchParams ? await searchParams : {};
  const deletedSkill = parseDeletedSkill(resolvedSearchParams.deletedSkill);

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
          <p>Manage the skills in your practice schedule.</p>
        </div>
        <Link className="primaryButton" href="/skills/new">
          <PlusCircle size={18} weight="bold" aria-hidden="true" />
          Add skill
        </Link>
      </header>

      {deletedSkill ? (
        <p className="skillFormMessage" data-tone="saved" role="status">
          Skill permanently deleted.
        </p>
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

function formatSkillStatus(status: SkillsLibraryRecoverySkill["status"]) {
  return formatDisplayLabel(status);
}

function parseDeletedSkill(value: string | string[] | undefined) {
  const rawValue = Array.isArray(value) ? value[0] : value;
  return rawValue === "1" || rawValue === "true";
}
