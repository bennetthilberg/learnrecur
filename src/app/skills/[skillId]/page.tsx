import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  AnswerKind,
  ExerciseAttemptResult,
  GenerationJobKind,
  GenerationJobStatus,
  SkillStatus,
  type Prisma,
} from "@/generated/prisma/client";
import { UserStatusPanel } from "@/components/app/user-status-panel";
import { formatJobStatus } from "@/lib/formatters";
import {
  getSkillPracticeHistory,
  type PracticeHistoryReview,
} from "@/lib/practice/history";
import {
  formatDueLabel,
  formatHistoryLabel,
  formatNullableHistoryLabel,
  formatResponseTime,
  formatReviewDate,
  formatReviewResult,
} from "@/lib/practice/history-formatters";
import { getPrisma } from "@/lib/prisma";
import {
  countChoiceExerciseInventory,
  countExactInputExerciseInventory,
  countMathExerciseInventory,
  DEFAULT_READY_MATH_TARGET,
  DEFAULT_READY_EXACT_INPUT_TARGET,
  DEFAULT_READY_EXERCISE_TARGET,
  EXACT_INPUT_UNLOCK_REPETITIONS,
  isExactInputUnlocked,
} from "@/lib/skills";
import { getSkillSourceSummaries } from "@/lib/skills/sources";
import { ensureDatabaseUser } from "@/lib/users";

import { SkillDraftForm, type SkillDraftFormValues } from "../skill-draft-form";
import { SkillDeleteForm } from "../skill-delete-form";
import { SkillExactInputRefillForm } from "../skill-exact-input-refill-form";
import { SkillLifecycleForm } from "../skill-lifecycle-form";
import { SkillMathRefillForm } from "../skill-math-refill-form";
import { SkillPracticeGuidanceDialog } from "../skill-practice-guidance-dialog";
import { SkillRefillForm } from "../skill-refill-form";
import { SkillSourcePanel } from "../skill-source-panel";
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
        <UserStatusPanel id="skills-setup-title" status={databaseUser} />
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

  const now = new Date();
  const [sourceSummariesResult, recentReviewsResult, reviewOutcomeGroups] = await Promise.all([
    getSkillSourceSummaries({ userId, skillId }),
    getSkillPracticeHistory({ userId, skillId, now, limit: 5 }),
    getSkillReviewOutcomeGroups({ now, skillId, userId }),
  ]);
  const sourceSummaries =
    sourceSummariesResult.status === "ready" ? sourceSummariesResult.sources : [];
  const recentReviews =
    recentReviewsResult.status === "ready" ? recentReviewsResult.reviews : [];
  const [latestChoiceGenerationJob, latestExactInputGenerationJob, latestMathGenerationJob] =
    skill.status === SkillStatus.ACTIVE
      ? await Promise.all([
          prisma.generationJob.findFirst({
            where: {
              userId,
              skillId: skill.id,
              kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
            },
            orderBy: {
              createdAt: "desc",
            },
          }),
          prisma.generationJob.findFirst({
            where: {
              userId,
              skillId: skill.id,
              kind: GenerationJobKind.EXACT_INPUT_EXERCISE_GENERATION,
            },
            orderBy: {
              createdAt: "desc",
            },
          }),
          prisma.generationJob.findFirst({
            where: {
              userId,
              skillId: skill.id,
              kind: GenerationJobKind.MATH_EXERCISE_GENERATION,
            },
            orderBy: {
              createdAt: "desc",
            },
          }),
        ])
      : [null, null, null];

  const draftValues: SkillDraftFormValues = {
    title: skill.title,
    objective: skill.objective ?? "",
    collectionName: skill.collection?.name ?? "",
    rules: notesToText(skill.rules),
    examples: notesToText(skill.examples),
    exerciseConstraints: notesToText(skill.exerciseConstraints),
    tags: skill.tags.join(", "),
  };

  if (skill.status === SkillStatus.ACTIVE) {
    const inventory = countChoiceExerciseInventory(skill.exercises);
    const exactInputInventory = countExactInputExerciseInventory(skill.exercises);
    const mathInventory = countMathExerciseInventory(skill.exercises);
    const hasActiveChoiceRefillJob = hasActiveGenerationJob(latestChoiceGenerationJob);
    const hasActiveExactInputRefillJob = hasActiveGenerationJob(latestExactInputGenerationJob);
    const hasActiveMathRefillJob = hasActiveGenerationJob(latestMathGenerationJob);
    const canRefill =
      inventory.readyExerciseCount < DEFAULT_READY_EXERCISE_TARGET && !hasActiveChoiceRefillJob;
    const exactInputUnlocked = isExactInputUnlocked(skill.repetitions);
    const canRefillExactInput =
      exactInputUnlocked &&
      exactInputInventory.readyExerciseCount < DEFAULT_READY_EXACT_INPUT_TARGET &&
      !hasActiveExactInputRefillJob;
    const canRefillMath =
      exactInputUnlocked &&
      mathInventory.readyExerciseCount < DEFAULT_READY_MATH_TARGET &&
      !hasActiveMathRefillJob;
    const readyPracticeCount =
      inventory.readyExerciseCount +
      (exactInputUnlocked
        ? exactInputInventory.readyExerciseCount + mathInventory.readyExerciseCount
        : 0);
    const isReadyForPractice =
      skill.dueAt !== null && skill.dueAt <= now && readyPracticeCount > 0;
    const reviewProgressLabel = `${formatCount(skill.repetitions)} of ${formatCount(
      EXACT_INPUT_UNLOCK_REPETITIONS,
    )} reviews`;
    const exactInputRefillButtonLabel = canRefillExactInput
      ? "Prepare exact input"
      : exactInputUnlocked
        ? hasActiveExactInputRefillJob
          ? "Preparing exact input"
          : "Target met"
        : `After ${formatCount(EXACT_INPUT_UNLOCK_REPETITIONS)} reviews`;
    const choiceRefillButtonLabel = canRefill
      ? "Prepare more exercises"
      : hasActiveChoiceRefillJob
        ? "Preparing exercises"
        : "Target met";
    const mathRefillButtonLabel = canRefillMath
      ? "Prepare math"
      : exactInputUnlocked
        ? hasActiveMathRefillJob
          ? "Preparing math"
          : "Target met"
        : `After ${formatCount(EXACT_INPUT_UNLOCK_REPETITIONS)} reviews`;
    const choiceRefillStatus =
      latestChoiceGenerationJob && hasActiveGenerationJob(latestChoiceGenerationJob)
        ? "Choice exercises are being prepared. Counts update after the run finishes."
        : null;
    const exactInputRefillStatus =
      latestExactInputGenerationJob && hasActiveGenerationJob(latestExactInputGenerationJob)
        ? "Exact-input exercises are being prepared. Counts update after the run finishes."
        : null;
    const mathRefillStatus =
      latestMathGenerationJob && hasActiveGenerationJob(latestMathGenerationJob)
        ? "Math exercises are being prepared. Counts update after the run finishes."
        : null;

    return (
      <main className="skillShell skillDetailShell">
        <SkillsTopbar current="skill" />
        <div className="skillDetailOverview">
          <div className="skillDetailCanvas">
            <header className="skillDetailHero">
              <div>
                <h1>{skill.title}</h1>
                <p>{skill.objective ?? "This skill is active in the practice schedule."}</p>
                {skill.tags.length > 0 ? (
                  <div className="skillDetailTags" aria-label="Skill tags">
                    {skill.tags.map((tag) => (
                      <span className="dashboardTag" key={tag}>
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
              <Link
                className={isReadyForPractice ? "primaryButton" : "secondaryButton"}
                href="/practice"
              >
                {isReadyForPractice ? "Start practice" : "Open practice"}
              </Link>
            </header>

            <SkillDetailScheduleCard
              collectionName={skill.collection?.name ?? "Uncollected"}
              dueLabel={skill.dueAt ? formatReviewDate(skill.dueAt) : "Not scheduled"}
              memoryStage={formatHistoryLabel(skill.fsrsState)}
              reviewCount={skill.repetitions}
            />

            <SkillDetailGuidanceCard
              constraints={draftValues.exerciseConstraints}
              examples={draftValues.examples}
              rules={draftValues.rules}
              skillId={skill.id}
            />

            <SkillDetailReviewOutcomesCard groups={reviewOutcomeGroups} />

            <details className="skillDetailCard skillDetailPreparation skillFormDetails">
              <summary>
                <span>Exercise preparation</span>
                <small>Ready counts and generation status</small>
              </summary>
              <div className="skillDetailPreparationGrid">
                <div className="skillQueueBlock">
                  <div>
                    <h2>Choice exercises</h2>
                    <SkillQueueStateStrip
                      readyCount={inventory.readyExerciseCount}
                      stateLabel={
                        hasActiveChoiceRefillJob
                          ? "Preparing"
                          : canRefill
                            ? "Below target"
                            : "Target met"
                      }
                      stateTone={canRefill || hasActiveChoiceRefillJob ? "attention" : "ready"}
                      targetCount={DEFAULT_READY_EXERCISE_TARGET}
                    />
                    <p className="skillQueueCopy">
                      Keep verified choice exercises available for the next due review.
                    </p>
                    {latestChoiceGenerationJob ? (
                      <SkillQueueJobStatus
                        job={latestChoiceGenerationJob}
                        label="Latest choice preparation"
                      />
                    ) : null}
                    {choiceRefillStatus ? (
                      <p className="skillQueueStatus">{choiceRefillStatus}</p>
                    ) : null}
                    {latestChoiceGenerationJob?.errorMessage ? (
                      <p className="skillFormMessage" data-tone="error">
                        Choice exercise preparation failed. Try again when you are ready.
                      </p>
                    ) : null}
                  </div>
                  {canRefill ? (
                    <SkillRefillForm
                      buttonLabel={choiceRefillButtonLabel}
                      canRefill={canRefill}
                      skillId={skill.id}
                    />
                  ) : (
                    <SkillQueueActionStatus
                      label={choiceRefillButtonLabel}
                      tone={hasActiveChoiceRefillJob ? "attention" : "ready"}
                    />
                  )}
                </div>
                <div className="skillQueueBlock">
                  <div>
                    <h2>Exact-input exercises</h2>
                    <SkillQueueStateStrip
                      readyCount={exactInputInventory.readyExerciseCount}
                      stateLabel={
                        exactInputUnlocked
                          ? hasActiveExactInputRefillJob
                            ? "Preparing"
                            : canRefillExactInput
                              ? "Below target"
                              : "Target met"
                          : reviewProgressLabel
                      }
                      stateTone={
                        exactInputUnlocked
                          ? canRefillExactInput || hasActiveExactInputRefillJob
                            ? "attention"
                            : "ready"
                          : "locked"
                      }
                      targetCount={DEFAULT_READY_EXACT_INPUT_TARGET}
                    />
                    <p className="skillQueueCopy">
                      Exact input begins after {EXACT_INPUT_UNLOCK_REPETITIONS} saved reviews, once
                      the skill has a short multiple-choice history.
                    </p>
                    {latestExactInputGenerationJob ? (
                      <SkillQueueJobStatus
                        job={latestExactInputGenerationJob}
                        label="Latest exact-input preparation"
                      />
                    ) : null}
                    {exactInputRefillStatus ? (
                      <p className="skillQueueStatus">{exactInputRefillStatus}</p>
                    ) : null}
                    {latestExactInputGenerationJob?.errorMessage ? (
                      <p className="skillFormMessage" data-tone="error">
                        Exact-input exercise preparation failed. Try again when you are ready.
                      </p>
                    ) : null}
                  </div>
                  {canRefillExactInput ? (
                    <SkillExactInputRefillForm
                      buttonLabel={exactInputRefillButtonLabel}
                      canRefill={canRefillExactInput}
                      skillId={skill.id}
                    />
                  ) : (
                    <SkillQueueActionStatus
                      label={exactInputRefillButtonLabel}
                      tone={
                        !exactInputUnlocked
                          ? "locked"
                          : hasActiveExactInputRefillJob
                            ? "attention"
                            : "ready"
                      }
                    />
                  )}
                </div>
                <div className="skillQueueBlock">
                  <div>
                    <h2>Math exercises</h2>
                    <SkillQueueStateStrip
                      readyCount={mathInventory.readyExerciseCount}
                      stateLabel={
                        exactInputUnlocked
                          ? hasActiveMathRefillJob
                            ? "Preparing"
                            : canRefillMath
                              ? "Below target"
                              : "Target met"
                          : reviewProgressLabel
                      }
                      stateTone={
                        exactInputUnlocked
                          ? canRefillMath || hasActiveMathRefillJob
                            ? "attention"
                            : "ready"
                          : "locked"
                      }
                      targetCount={DEFAULT_READY_MATH_TARGET}
                    />
                    <p className="skillQueueCopy">
                      Math practice begins after {EXACT_INPUT_UNLOCK_REPETITIONS} saved reviews,
                      once the skill has a short multiple-choice history.
                    </p>
                    {latestMathGenerationJob ? (
                      <SkillQueueJobStatus job={latestMathGenerationJob} label="Latest math preparation" />
                    ) : null}
                    {mathRefillStatus ? <p className="skillQueueStatus">{mathRefillStatus}</p> : null}
                    {latestMathGenerationJob?.errorMessage ? (
                      <p className="skillFormMessage" data-tone="error">
                        Math exercise preparation failed. Try again when you are ready.
                      </p>
                    ) : null}
                  </div>
                  {canRefillMath ? (
                    <SkillMathRefillForm
                      buttonLabel={mathRefillButtonLabel}
                      canRefill={canRefillMath}
                      skillId={skill.id}
                    />
                  ) : (
                    <SkillQueueActionStatus
                      label={mathRefillButtonLabel}
                      tone={
                        !exactInputUnlocked ? "locked" : hasActiveMathRefillJob ? "attention" : "ready"
                      }
                    />
                  )}
                </div>
              </div>
            </details>
            <SkillLifecyclePanel
              className="skillDetailControls"
              skillId={skill.id}
              skillTitle={skill.title}
              status={skill.status}
            />
            <SkillSourcePanel
              className="skillDetailSources"
              showEmpty
              skillId={skill.id}
              sources={sourceSummaries}
            />
            <SkillRecentReviewsPanel
              className="skillDetailRecent"
              reviews={recentReviews}
              showEmpty
            />
          </div>
        </div>
      </main>
    );
  }

  if (skill.status === SkillStatus.PAUSED || skill.status === SkillStatus.ARCHIVED) {
    const inventory = countChoiceExerciseInventory(skill.exercises);
    const exactInputInventory = countExactInputExerciseInventory(skill.exercises);
    const mathInventory = countMathExerciseInventory(skill.exercises);
    const statusCopy =
      skill.status === SkillStatus.PAUSED
        ? {
            heading: "Paused outside practice",
            body: "This skill keeps its schedule and history, but it will not appear in practice until resumed.",
          }
        : {
            heading: "Archived for recovery",
            body: "This skill is hidden from practice and normal dashboard counts. Restore it when you want to review or reactivate it.",
          };

    return (
      <main className="skillShell">
        <SkillsTopbar current="skill" />
        <header className="skillHeader">
          <div>
            <h1>{skill.title}</h1>
            <p>{skill.objective ?? statusCopy.body}</p>
          </div>
        </header>

        <section className="skillPanel skillActivatedPanel" aria-labelledby="inactive-skill-title">
          <div>
            <h2 id="inactive-skill-title">{statusCopy.heading}</h2>
            <p className="skillQueueStatus">{statusCopy.body}</p>
          </div>
          <dl className="skillStatusSummary">
            <SkillStatusSummaryItem
              label="Status"
              priority="primary"
              value={formatHistoryLabel(skill.status)}
            />
            <SkillStatusSummaryItem
              label="Due"
              value={skill.dueAt ? formatReviewDate(skill.dueAt) : "Not scheduled"}
            />
            <SkillStatusSummaryItem
              label="Collection"
              value={skill.collection?.name ?? "Uncollected"}
            />
            <SkillStatusSummaryItem label="Memory stage" value={formatHistoryLabel(skill.fsrsState)} />
            <SkillStatusSummaryItem label="Reviews" value={formatCount(skill.repetitions)} />
          </dl>
          <div className="skillInventoryGrid" aria-label="Exercise inventory">
            <SkillInventoryGroup
              label="Choice"
              readyCount={inventory.readyExerciseCount}
              retiredCount={inventory.retiredExerciseCount}
              targetCount={DEFAULT_READY_EXERCISE_TARGET}
              verifiedCount={inventory.verifiedExerciseCount}
            />
            <SkillInventoryGroup
              label="Exact input"
              readyCount={exactInputInventory.readyExerciseCount}
              retiredCount={exactInputInventory.retiredExerciseCount}
              targetCount={DEFAULT_READY_EXACT_INPUT_TARGET}
              verifiedCount={exactInputInventory.verifiedExerciseCount}
            />
            <SkillInventoryGroup
              label="Math"
              readyCount={mathInventory.readyExerciseCount}
              retiredCount={mathInventory.retiredExerciseCount}
              targetCount={DEFAULT_READY_MATH_TARGET}
              verifiedCount={mathInventory.verifiedExerciseCount}
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
        <SkillLifecyclePanel skillId={skill.id} skillTitle={skill.title} status={skill.status} />
        <SkillSourcePanel
          canRemove={skill.status !== SkillStatus.ARCHIVED}
          skillId={skill.id}
          sources={sourceSummaries}
        />
        <SkillRecentReviewsPanel reviews={recentReviews} />
      </main>
    );
  }

  return (
    <main className="skillShell createSkillReviewShell">
      <SkillsTopbar current="skill" />
      <header className="skillHeader createSkillHeader">
        <div>
          <h1>{skill.title}</h1>
          <p>Check what LearnRecur made, make any edits, then add the skill.</p>
        </div>
      </header>

      {skill.generationJobs[0]?.errorMessage ? (
        <section className="skillMessage" data-tone="error" aria-label="Latest add issue">
          <p>Skill preparation failed. Review the details and try again when you are ready.</p>
        </section>
      ) : null}

      <SkillDraftForm initialValues={draftValues} mode="edit" skillId={skill.id} />
      <SkillSourcePanel skillId={skill.id} sources={sourceSummaries} />
      <SkillLifecyclePanel skillId={skill.id} skillTitle={skill.title} status={skill.status} />
    </main>
  );
}

type SkillReviewOutcomeGroupKey = "choice" | "exact-input" | "math";

type SkillReviewOutcomeGroup = {
  correctCount: number;
  description: string;
  incorrectCount: number;
  key: SkillReviewOutcomeGroupKey;
  label: string;
};

function SkillDetailScheduleCard({
  collectionName,
  dueLabel,
  memoryStage,
  reviewCount,
}: {
  collectionName: string;
  dueLabel: string;
  memoryStage: string;
  reviewCount: number;
}) {
  return (
    <section className="skillDetailCard skillDetailSchedule" aria-labelledby="skill-detail-schedule">
      <div className="skillDetailSectionHeader">
        <div>
          <h2 id="skill-detail-schedule">Schedule</h2>
          <p>Where this skill sits in your practice queue.</p>
        </div>
      </div>
      <dl className="skillDetailFactGrid">
        <SkillDetailFact label="Due" priority value={dueLabel} />
        <SkillDetailFact label="Collection" value={collectionName} />
        <SkillDetailFact label="Memory" value={memoryStage} />
        <SkillDetailFact label="Reviews" value={formatCount(reviewCount)} />
      </dl>
    </section>
  );
}

function SkillDetailFact({
  label,
  priority,
  value,
}: {
  label: string;
  priority?: boolean;
  value: string;
}) {
  return (
    <div data-priority={priority ? "primary" : undefined}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SkillDetailReviewOutcomesCard({ groups }: { groups: SkillReviewOutcomeGroup[] }) {
  const totalReviews = groups.reduce(
    (sum, group) => sum + group.correctCount + group.incorrectCount,
    0,
  );

  return (
    <section className="skillDetailCard skillDetailOutcomes" aria-labelledby="skill-detail-outcomes">
      <div className="skillDetailSectionHeader">
        <div>
          <h2 id="skill-detail-outcomes">Practice results</h2>
          <p>How completed reviews have gone for each answer type.</p>
        </div>
      </div>
      {totalReviews > 0 ? (
        <div className="skillDetailOutcomeList">
          {groups.map((group) => (
            <SkillDetailReviewOutcomeRow group={group} key={group.key} />
          ))}
        </div>
      ) : (
        <p className="skillDetailEmptyText">No completed reviews for this skill yet.</p>
      )}
    </section>
  );
}

function SkillDetailReviewOutcomeRow({ group }: { group: SkillReviewOutcomeGroup }) {
  const totalCount = group.correctCount + group.incorrectCount;
  const correctPercent = totalCount > 0 ? Math.round((group.correctCount / totalCount) * 100) : 0;
  const incorrectPercent = totalCount > 0 ? 100 - correctPercent : 0;

  return (
    <article className="skillDetailOutcomeRow">
      <div>
        <h3>{group.label}</h3>
        <p>{group.description}</p>
      </div>
      <dl>
        <div>
          <dt>Right</dt>
          <dd>{formatCount(group.correctCount)}</dd>
        </div>
        <div>
          <dt>Missed</dt>
          <dd>{formatCount(group.incorrectCount)}</dd>
        </div>
        <div>
          <dt>Accuracy</dt>
          <dd>{totalCount > 0 ? `${formatCount(correctPercent)}%` : "No reviews"}</dd>
        </div>
      </dl>
      <div className="skillDetailOutcomeTrack" aria-hidden="true">
        <span data-result="correct" style={{ width: `${correctPercent}%` }} />
        <span data-result="incorrect" style={{ width: `${incorrectPercent}%` }} />
      </div>
    </article>
  );
}

async function getSkillReviewOutcomeGroups({
  now,
  skillId,
  userId,
}: {
  now: Date;
  skillId: string;
  userId: string;
}): Promise<SkillReviewOutcomeGroup[]> {
  const groups = createEmptyReviewOutcomeGroups();
  const groupsByKey = new Map(groups.map((group) => [group.key, group]));
  const prisma = getPrisma();
  const rows = await prisma.reviewLog.findMany({
    where: {
      userId,
      skillId,
      reviewedAt: {
        lte: now,
      },
      exerciseAttempt: {
        finalRating: {
          not: null,
        },
        result: {
          in: [ExerciseAttemptResult.CORRECT, ExerciseAttemptResult.INCORRECT],
        },
      },
    },
    select: {
      exerciseAttempt: {
        select: {
          result: true,
          exercise: {
            select: {
              answerKind: true,
            },
          },
        },
      },
    },
  });

  for (const row of rows) {
    const group = groupsByKey.get(resolveReviewOutcomeGroupKey(row.exerciseAttempt.exercise.answerKind));

    if (!group) {
      continue;
    }

    if (row.exerciseAttempt.result === ExerciseAttemptResult.CORRECT) {
      group.correctCount += 1;
    } else {
      group.incorrectCount += 1;
    }
  }

  return groups;
}

function createEmptyReviewOutcomeGroups(): SkillReviewOutcomeGroup[] {
  return [
    {
      correctCount: 0,
      description: "Multiple-choice reviews",
      incorrectCount: 0,
      key: "choice",
      label: "Choice",
    },
    {
      correctCount: 0,
      description: "Typed text and numeric answers",
      incorrectCount: 0,
      key: "exact-input",
      label: "Exact input",
    },
    {
      correctCount: 0,
      description: "Math equivalence answers",
      incorrectCount: 0,
      key: "math",
      label: "Math",
    },
  ];
}

function resolveReviewOutcomeGroupKey(answerKind: AnswerKind): SkillReviewOutcomeGroupKey {
  if (answerKind === AnswerKind.CHOICE) {
    return "choice";
  }

  if (answerKind === AnswerKind.MATH) {
    return "math";
  }

  return "exact-input";
}

function SkillDetailGuidanceCard({
  constraints,
  examples,
  rules,
  skillId,
}: {
  constraints: string;
  examples: string;
  rules: string;
  skillId: string;
}) {
  return (
    <section className="skillDetailCard skillDetailGuidance" aria-labelledby="skill-detail-guidance">
      <div className="skillDetailSectionHeader">
        <div>
          <h2 id="skill-detail-guidance">Practice guidance</h2>
          <p>What LearnRecur uses when it prepares exercises for this skill.</p>
        </div>
        <SkillPracticeGuidanceDialog
          constraints={constraints}
          examples={examples}
          rules={rules}
          skillId={skillId}
        />
      </div>
      <div className="skillDetailGuidanceList">
        <SkillDetailTextBlock fallback="No rules are saved for this skill yet." title="Rules">
          {rules}
        </SkillDetailTextBlock>
        <SkillDetailTextBlock fallback="No examples are saved for this skill yet." title="Examples">
          {examples}
        </SkillDetailTextBlock>
        <SkillDetailTextBlock
          fallback="No extra exercise constraints are saved for this skill yet."
          title="Exercise focus"
        >
          {constraints}
        </SkillDetailTextBlock>
      </div>
    </section>
  );
}

function SkillDetailTextBlock({
  children,
  fallback,
  title,
}: {
  children: string;
  fallback: string;
  title: string;
}) {
  const body = children.trim();

  return (
    <section className="skillDetailTextBlock">
      <h3>{title}</h3>
      <p data-empty={body ? undefined : "true"}>{body || fallback}</p>
    </section>
  );
}

function hasActiveGenerationJob(job: { status: GenerationJobStatus } | null): boolean {
  return (
    job?.status === GenerationJobStatus.PENDING || job?.status === GenerationJobStatus.RUNNING
  );
}

function SkillStatusSummaryItem({
  label,
  priority,
  value,
}: {
  label: string;
  priority?: "primary";
  value: string;
}) {
  return (
    <div data-priority={priority}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function SkillInventoryGroup({
  label,
  readyCount,
  retiredCount,
  targetCount,
  verifiedCount,
}: {
  label: string;
  readyCount: number;
  retiredCount: number;
  targetCount: number;
  verifiedCount: number;
}) {
  return (
    <section className="skillInventoryGroup" aria-label={`${label} inventory`}>
      <div className="skillInventoryReady">
        <span>{label}</span>
        <strong>
          <span>{formatCount(readyCount)}</span>
          <small>of {formatCount(targetCount)} ready</small>
        </strong>
      </div>
      <dl>
        <div>
          <dt>Verified</dt>
          <dd>{formatCount(verifiedCount)}</dd>
        </div>
        <div>
          <dt>Retired</dt>
          <dd>{formatCount(retiredCount)}</dd>
        </div>
      </dl>
    </section>
  );
}

function SkillQueueStateStrip({
  readyCount,
  stateLabel,
  stateTone,
  targetCount,
}: {
  readyCount: number;
  stateLabel: string;
  stateTone: "attention" | "locked" | "ready";
  targetCount: number;
}) {
  return (
    <dl className="skillQueueStateStrip" data-tone={stateTone}>
      <div data-priority="primary">
        <dt>Ready</dt>
        <dd>
          {formatCount(readyCount)} of {formatCount(targetCount)}
        </dd>
      </div>
      <div data-role="state">
        <dt>Status</dt>
        <dd>{stateLabel}</dd>
      </div>
    </dl>
  );
}

function SkillQueueActionStatus({
  label,
  tone,
}: {
  label: string;
  tone: "attention" | "locked" | "ready";
}) {
  return (
    <div className="skillQueueActionStatus" data-tone={tone}>
      {label}
    </div>
  );
}

function SkillQueueJobStatus({
  job,
  label,
}: {
  job: {
    acceptedCount: number;
    rejectedCount: number;
    status: GenerationJobStatus;
  };
  label: string;
}) {
  return (
    <dl className="skillQueueJobStatus" aria-label={label}>
      <div>
        <dt>{label}</dt>
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
  );
}

function SkillLifecyclePanel({
  className,
  skillId,
  skillTitle,
  status,
}: {
  className?: string;
  skillId: string;
  skillTitle: string;
  status: SkillStatus;
}) {
  const showPracticeStateControls =
    status === SkillStatus.ACTIVE ||
    status === SkillStatus.PAUSED ||
    status === SkillStatus.ARCHIVED;

  return (
    <section
      className={["skillPanel skillLifecyclePanel", className].filter(Boolean).join(" ")}
      aria-labelledby="skill-lifecycle-title"
    >
      <div className="skillPanelHeader">
        <div>
          <h2 id="skill-lifecycle-title">Skill controls</h2>
        </div>
      </div>
      <div
        className="skillLifecycleActions"
        data-layout={showPracticeStateControls ? "split" : "single"}
      >
        {showPracticeStateControls ? (
          <div className="skillLifecycleGroup">
            <h3>Practice controls</h3>
            <p>Control whether this skill can appear in due practice.</p>
            {status === SkillStatus.ACTIVE ? (
              <SkillLifecycleForm
                actionType="pause"
                buttonLabel="Pause practice"
                description="Pause keeps the skill and schedule intact but removes it from practice."
                pendingLabel="Pausing"
                skillId={skillId}
              />
            ) : null}
            {status === SkillStatus.PAUSED ? (
              <SkillLifecycleForm
                actionType="resume"
                buttonLabel="Resume practice"
                description="Resume returns this skill to the active practice schedule."
                pendingLabel="Resuming"
                skillId={skillId}
              />
            ) : null}
            {status === SkillStatus.ARCHIVED ? (
              <SkillLifecycleForm
                actionType="restore"
                buttonLabel="Restore skill"
                description="Restored scheduled skills return to practice. Other restored skills reopen for review."
                pendingLabel="Restoring"
                skillId={skillId}
              />
            ) : null}
          </div>
        ) : null}
        <div className="skillLifecycleGroup" data-tone="danger">
          <h3>Archive and delete</h3>
          <p>Archive first when you may want this skill later. Permanent delete is final.</p>
          {status !== SkillStatus.ARCHIVED ? (
            <SkillLifecycleForm
              actionType="archive"
              buttonLabel="Archive skill"
              confirmationLabel="Archive this skill and keep its sources, exercises, and history."
              description="Archived skills leave the main library and practice flow, but can be restored later."
              pendingLabel="Archiving"
              skillId={skillId}
              summaryLabel="Archive skill"
              tone="danger"
            />
          ) : null}
          {status === SkillStatus.DRAFT || status === SkillStatus.ARCHIVED ? (
            <SkillDeleteForm skillId={skillId} skillTitle={skillTitle} />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function SkillRecentReviewsPanel({
  className,
  reviews,
  showEmpty = false,
}: {
  className?: string;
  reviews: PracticeHistoryReview[];
  showEmpty?: boolean;
}) {
  if (reviews.length === 0 && !showEmpty) {
    return null;
  }

  return (
    <section
      className={["skillPanel skillRecentReviewsPanel", className].filter(Boolean).join(" ")}
      aria-labelledby="skill-reviews-title"
    >
      <div className="skillPanelHeader">
        <div>
          <h2 id="skill-reviews-title">Recent reviews</h2>
        </div>
        <Link className="dashboardPanelLink" href="/history">
          Full history
        </Link>
      </div>

      {reviews.length > 0 ? (
        <div className="skillReviewList">
          {reviews.map((review) => (
            <article className="skillReviewRow" key={review.id}>
              <div>
                <strong>{formatReviewDate(review.reviewedAt)}</strong>
                <p className="skillReviewMeta">
                  <span>{formatReviewResult(review.result)}</span>
                  <span>{formatHistoryLabel(review.finalRating)}</span>
                  <span>{formatResponseTime(review.responseMs)}</span>
                </p>
              </div>
              <div className="skillReviewSchedule">
                <SkillReviewStateTransition review={review} />
                <span>Next: {formatDueLabel(review.nextDueAt)}</span>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="skillDetailEmptyText">No completed reviews for this skill yet.</p>
      )}
    </section>
  );
}

function SkillReviewStateTransition({ review }: { review: PracticeHistoryReview }) {
  const previousState = formatNullableHistoryLabel(review.previousState);
  const nextState = formatNullableHistoryLabel(review.nextState);

  return (
    <span
      className="historyTransitionText"
      aria-label={`Memory stage changed from ${previousState} to ${nextState}`}
    >
      <span>{previousState}</span>
      <span className="historyTransitionArrow" aria-hidden="true">
        &rarr;
      </span>
      <span>{nextState}</span>
    </span>
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

function formatCount(count: number) {
  return new Intl.NumberFormat("en-US").format(count);
}
