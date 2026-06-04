import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SkillStatus, type Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillDraftForm, type SkillDraftFormValues } from "../skill-draft-form";
import { SkillsTopbar } from "../skills-topbar";

export const dynamic = "force-dynamic";

export default async function SkillPage({
  params,
}: {
  params: Promise<{ skillId: string }>;
}) {
  const { skillId } = await params;
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();

  if (!clerkUser) {
    throw new Error(`Clerk returned no user for authenticated user ${userId}.`);
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);

  if (databaseUser.status !== "ready") {
    return (
      <main className="skillShell">
        <SkillsTopbar current="skill" />
        <section className="dashboardSetupPanel" aria-labelledby="skills-setup-title">
          <p className="eyebrow">Skills</p>
          <h1 id="skills-setup-title">Database setup needs attention.</h1>
          <p>{databaseUser.message}</p>
        </section>
      </main>
    );
  }

  const prisma = getPrisma();
  const skill = await prisma.skill.findFirst({
    where: {
      id: skillId,
      userId,
    },
    include: {
      collection: {
        select: {
          name: true,
        },
      },
      exercises: {
        select: {
          id: true,
        },
      },
      generationJobs: {
        orderBy: {
          createdAt: "desc",
        },
        take: 1,
      },
    },
  });

  if (!skill) {
    notFound();
  }

  const draftValues: SkillDraftFormValues = {
    title: skill.title,
    objective: skill.objective ?? "",
    collectionName: skill.collection?.name ?? "",
    rules: notesToText(skill.rules),
    examples: notesToText(skill.examples),
    exerciseConstraints: notesToText(skill.exerciseConstraints),
    tags: skill.tags.join(", "),
  };

  if (skill.status !== SkillStatus.DRAFT) {
    return (
      <main className="skillShell">
        <SkillsTopbar current="skill" />
        <header className="skillHeader">
          <div>
            <p className="eyebrow">Skill</p>
            <h1>{skill.title}</h1>
            <p>{skill.objective ?? "This skill is active and ready for practice."}</p>
          </div>
          <Link className="primaryButton" href="/practice">
            Start practice
          </Link>
        </header>

        <section className="skillPanel skillActivatedPanel" aria-labelledby="active-skill-title">
          <div>
            <p className="eyebrow">Status</p>
            <h2 id="active-skill-title">Active in the schedule.</h2>
          </div>
          <dl className="skillStatusGrid">
            <div>
              <dt>Exercises</dt>
              <dd>{skill.exercises.length}</dd>
            </div>
            <div>
              <dt>Collection</dt>
              <dd>{skill.collection?.name ?? "Uncollected"}</dd>
            </div>
            <div>
              <dt>FSRS state</dt>
              <dd>{skill.fsrsState}</dd>
            </div>
            <div>
              <dt>Due</dt>
              <dd>{skill.dueAt ? skill.dueAt.toLocaleString("en-US") : "Not scheduled"}</dd>
            </div>
          </dl>
          {skill.tags.length > 0 ? (
            <div className="skillTagLine">
              {skill.tags.map((tag) => (
                <span className="dashboardTag" key={tag}>
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className="skillShell">
      <SkillsTopbar current="skill" />
      <header className="skillHeader">
        <div>
          <p className="eyebrow">Draft skill</p>
          <h1>{skill.title}</h1>
          <p>
            Review the definition, save any changes, then activate it to generate
            starter multiple-choice practice.
          </p>
        </div>
      </header>

      {skill.generationJobs[0]?.errorMessage ? (
        <section className="skillMessage" aria-label="Latest generation error">
          <p className="eyebrow">Latest activation attempt</p>
          <p>{skill.generationJobs[0].errorMessage}</p>
        </section>
      ) : null}

      <SkillDraftForm initialValues={draftValues} mode="edit" skillId={skill.id} />
    </main>
  );
}

function notesToText(value: Prisma.JsonValue | null): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  if ("items" in value && Array.isArray(value.items)) {
    return value.items.filter((item) => typeof item === "string").join("\n");
  }

  if ("notes" in value && typeof value.notes === "string") {
    return value.notes;
  }

  return "";
}
