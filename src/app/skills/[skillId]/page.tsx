import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SkillStatus, type Prisma } from "@/generated/prisma/client";
import { formatJobStatus } from "@/lib/formatters";
import { getPrisma } from "@/lib/prisma";
import {
  countChoiceExerciseInventory,
  countExactInputExerciseInventory,
  DEFAULT_READY_EXACT_INPUT_TARGET,
  DEFAULT_READY_EXERCISE_TARGET,
  EXACT_INPUT_UNLOCK_REPETITIONS,
  isExactInputUnlocked,
} from "@/lib/skills";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillDraftForm, type SkillDraftFormValues } from "../skill-draft-form";
import { SkillExactInputRefillForm } from "../skill-exact-input-refill-form";
import { SkillRefillForm } from "../skill-refill-form";
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
      _count: {
        select: {
          exercises: true,
        },
      },
      generationJobs: {
        orderBy: {
          createdAt: "desc",
        },
        take: 1,
      },
      exercises: {
        select: {
          answerKind: true,
          verificationStatus: true,
          retiredAt: true,
          choices: true,
          answerSpec: true,
        },
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
    const inventory = countChoiceExerciseInventory(skill.exercises);
    const exactInputInventory = countExactInputExerciseInventory(skill.exercises);
    const canRefill = inventory.readyExerciseCount < DEFAULT_READY_EXERCISE_TARGET;
    const exactInputUnlocked = isExactInputUnlocked(skill.repetitions);
    const canRefillExactInput =
      exactInputUnlocked &&
      exactInputInventory.readyExerciseCount < DEFAULT_READY_EXACT_INPUT_TARGET;
    const exactInputRefillButtonLabel = canRefillExactInput
      ? "Generate exact input"
      : exactInputUnlocked
        ? "Exact input full"
        : "Exact input locked";
    const latestGenerationJob = skill.generationJobs[0] ?? null;

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
              <dd>{skill._count.exercises}</dd>
            </div>
            <div>
              <dt>Ready choices</dt>
              <dd>
                {inventory.readyExerciseCount} / {DEFAULT_READY_EXERCISE_TARGET}
              </dd>
            </div>
            <div>
              <dt>Ready exact input</dt>
              <dd>
                {exactInputInventory.readyExerciseCount} / {DEFAULT_READY_EXACT_INPUT_TARGET}
              </dd>
            </div>
            <div>
              <dt>Verified choices</dt>
              <dd>{inventory.verifiedExerciseCount}</dd>
            </div>
            <div>
              <dt>Verified exact input</dt>
              <dd>{exactInputInventory.verifiedExerciseCount}</dd>
            </div>
            <div>
              <dt>Retired choices</dt>
              <dd>{inventory.retiredExerciseCount}</dd>
            </div>
            <div>
              <dt>Retired exact input</dt>
              <dd>{exactInputInventory.retiredExerciseCount}</dd>
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
          <div className="skillQueueBlock">
            <div>
              <p className="eyebrow">Exercise queue</p>
              <h2>Ready choice exercises.</h2>
              <p>
                Keep a small set of verified exercises available so practice can stay fast and
                deterministic.
              </p>
              {latestGenerationJob ? (
                <p className="skillQueueStatus">
                  Latest generation: {formatJobStatus(latestGenerationJob.status)} ·{" "}
                  {latestGenerationJob.acceptedCount} accepted /{" "}
                  {latestGenerationJob.rejectedCount} rejected
                </p>
              ) : null}
              {latestGenerationJob?.errorMessage ? (
                <p className="skillFormMessage" data-tone="error">
                  {latestGenerationJob.errorMessage}
                </p>
              ) : null}
            </div>
            <SkillRefillForm canRefill={canRefill} skillId={skill.id} />
          </div>
          <div className="skillQueueBlock">
            <div>
              <p className="eyebrow">Recall step</p>
              <h2>Ready exact-input exercises.</h2>
              <p>
                Exact input starts after {EXACT_INPUT_UNLOCK_REPETITIONS} saved reviews, once the
                learner has practiced the skill with multiple choice first.
              </p>
              <p className="skillQueueStatus">
                {exactInputUnlocked
                  ? `${exactInputInventory.readyExerciseCount} ready / ${DEFAULT_READY_EXACT_INPUT_TARGET} target`
                  : `${skill.repetitions} / ${EXACT_INPUT_UNLOCK_REPETITIONS} reviews completed`}
              </p>
            </div>
            <SkillExactInputRefillForm
              buttonLabel={exactInputRefillButtonLabel}
              canRefill={canRefillExactInput}
              skillId={skill.id}
            />
          </div>
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
