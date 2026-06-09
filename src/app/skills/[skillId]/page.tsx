import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";
import { notFound } from "next/navigation";

import {
  GenerationJobKind,
  GenerationJobStatus,
  SkillStatus,
  type Prisma,
} from "@/generated/prisma/client";
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

  const [sourceSummariesResult, recentReviewsResult] = await Promise.all([
    getSkillSourceSummaries({ userId, skillId }),
    getSkillPracticeHistory({ userId, skillId, now: new Date(), limit: 5 }),
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
    const reviewProgressLabel = `${formatCount(skill.repetitions)} of ${formatCount(
      EXACT_INPUT_UNLOCK_REPETITIONS,
    )} reviews`;
    const exactInputRefillButtonLabel = canRefillExactInput
      ? "Queue exact input"
      : exactInputUnlocked
        ? hasActiveExactInputRefillJob
          ? "Exact input queued"
          : "Exact input full"
        : `After ${formatCount(EXACT_INPUT_UNLOCK_REPETITIONS)} reviews`;
    const choiceRefillButtonLabel = canRefill
      ? "Queue more exercises"
      : hasActiveChoiceRefillJob
        ? "Refill queued"
        : "Queue full";
    const mathRefillButtonLabel = canRefillMath
      ? "Queue math"
      : exactInputUnlocked
        ? hasActiveMathRefillJob
          ? "Math queued"
          : "Math full"
        : `After ${formatCount(EXACT_INPUT_UNLOCK_REPETITIONS)} reviews`;
    const choiceRefillStatus =
      latestChoiceGenerationJob && hasActiveGenerationJob(latestChoiceGenerationJob)
        ? `Choice refill ${formatJobStatus(latestChoiceGenerationJob.status)}. Counts update after the job finishes.`
        : null;
    const exactInputRefillStatus =
      latestExactInputGenerationJob && hasActiveGenerationJob(latestExactInputGenerationJob)
        ? `Exact-input refill ${formatJobStatus(latestExactInputGenerationJob.status)}. Counts update after the job finishes.`
        : null;
    const mathRefillStatus =
      latestMathGenerationJob && hasActiveGenerationJob(latestMathGenerationJob)
        ? `Math refill ${formatJobStatus(latestMathGenerationJob.status)}. Counts update after the job finishes.`
        : null;

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
          <dl className="skillStatusSummary">
            <SkillStatusSummaryItem
              label="Due"
              priority="primary"
              value={skill.dueAt ? formatReviewDate(skill.dueAt) : "Not scheduled"}
            />
            <SkillStatusSummaryItem
              label="Collection"
              value={skill.collection?.name ?? "Uncollected"}
            />
            <SkillStatusSummaryItem label="Schedule state" value={formatHistoryLabel(skill.fsrsState)} />
            <SkillStatusSummaryItem label="Reviews" value={formatCount(skill.repetitions)} />
            <SkillStatusSummaryItem label="Exercises" value={formatCount(skill._count.exercises)} />
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

        <section className="skillPanel skillQueuePanel" aria-labelledby="skill-queue-title">
          <div className="skillPanelHeader">
            <div>
              <p className="eyebrow">Generation</p>
              <h2 id="skill-queue-title">Exercise queues</h2>
            </div>
          </div>
          <div className="skillQueueBlock">
            <div>
              <p className="eyebrow">Exercise queue</p>
              <h2>Ready choice exercises.</h2>
              <SkillQueueStateStrip
                readyCount={inventory.readyExerciseCount}
                stateLabel={
                  hasActiveChoiceRefillJob ? "Refill running" : canRefill ? "Below target" : "Full"
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
                  label="Latest choice generation"
                />
              ) : null}
              {choiceRefillStatus ? <p className="skillQueueStatus">{choiceRefillStatus}</p> : null}
              {latestChoiceGenerationJob?.errorMessage ? (
                <p className="skillFormMessage" data-tone="error">
                  {latestChoiceGenerationJob.errorMessage}
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
              <p className="eyebrow">Recall step</p>
              <h2>Ready exact-input exercises.</h2>
              <SkillQueueStateStrip
                readyCount={exactInputInventory.readyExerciseCount}
                stateLabel={
                  exactInputUnlocked
                    ? hasActiveExactInputRefillJob
                      ? "Refill running"
                      : canRefillExactInput
                        ? "Below target"
                        : "Full"
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
                Exact input begins after {EXACT_INPUT_UNLOCK_REPETITIONS} saved reviews, once the
                skill has a short multiple-choice history.
              </p>
              {latestExactInputGenerationJob ? (
                <SkillQueueJobStatus
                  job={latestExactInputGenerationJob}
                  label="Latest exact-input generation"
                />
              ) : null}
              {exactInputRefillStatus ? (
                <p className="skillQueueStatus">{exactInputRefillStatus}</p>
              ) : null}
              {latestExactInputGenerationJob?.errorMessage ? (
                <p className="skillFormMessage" data-tone="error">
                  {latestExactInputGenerationJob.errorMessage}
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
              <p className="eyebrow">Math recall</p>
              <h2>Ready math exercises.</h2>
              <SkillQueueStateStrip
                readyCount={mathInventory.readyExerciseCount}
                stateLabel={
                  exactInputUnlocked
                    ? hasActiveMathRefillJob
                      ? "Refill running"
                      : canRefillMath
                        ? "Below target"
                        : "Full"
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
                Math practice begins after a few scheduled reviews and accepts
                single-expression answers.
              </p>
              {latestMathGenerationJob ? (
                <SkillQueueJobStatus
                  job={latestMathGenerationJob}
                  label="Latest math generation"
                />
              ) : null}
              {mathRefillStatus ? <p className="skillQueueStatus">{mathRefillStatus}</p> : null}
              {latestMathGenerationJob?.errorMessage ? (
                <p className="skillFormMessage" data-tone="error">
                  {latestMathGenerationJob.errorMessage}
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
        </section>
        <SkillLifecyclePanel skillId={skill.id} skillTitle={skill.title} status={skill.status} />
        <SkillSourcePanel skillId={skill.id} sources={sourceSummaries} />
        <SkillRecentReviewsPanel reviews={recentReviews} />
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
            eyebrow: "Paused skill",
            heading: "Paused outside practice.",
            body: "This skill keeps its schedule and history, but it will not appear in practice until resumed.",
          }
        : {
            eyebrow: "Archived skill",
            heading: "Archived for recovery.",
            body: "This skill is hidden from practice and normal dashboard counts. Restore it when you want to review or reactivate it.",
          };

    return (
      <main className="skillShell">
        <SkillsTopbar current="skill" />
        <header className="skillHeader">
          <div>
            <p className="eyebrow">{statusCopy.eyebrow}</p>
            <h1>{skill.title}</h1>
            <p>{skill.objective ?? statusCopy.body}</p>
          </div>
        </header>

        <section className="skillPanel skillActivatedPanel" aria-labelledby="inactive-skill-title">
          <div>
            <p className="eyebrow">Status</p>
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
            <SkillStatusSummaryItem label="Schedule state" value={formatHistoryLabel(skill.fsrsState)} />
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
        <section className="skillMessage" data-tone="error" aria-label="Latest generation error">
          <p className="eyebrow">Latest activation attempt</p>
          <p>{skill.generationJobs[0].errorMessage}</p>
        </section>
      ) : null}

      <SkillSourcePanel skillId={skill.id} sources={sourceSummaries} />
      <SkillRecentReviewsPanel reviews={recentReviews} />

      <SkillDraftForm initialValues={draftValues} mode="edit" skillId={skill.id} />
      <SkillLifecyclePanel skillId={skill.id} skillTitle={skill.title} status={skill.status} />
    </main>
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
        <dt>State</dt>
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
        <dt>Accepted</dt>
        <dd>{formatCount(job.acceptedCount)}</dd>
      </div>
      <div>
        <dt>Rejected</dt>
        <dd>{formatCount(job.rejectedCount)}</dd>
      </div>
    </dl>
  );
}

function SkillLifecyclePanel({
  skillId,
  skillTitle,
  status,
}: {
  skillId: string;
  skillTitle: string;
  status: SkillStatus;
}) {
  const showPracticeStateControls =
    status === SkillStatus.ACTIVE ||
    status === SkillStatus.PAUSED ||
    status === SkillStatus.ARCHIVED;

  return (
    <section className="skillPanel skillLifecyclePanel" aria-labelledby="skill-lifecycle-title">
      <div className="skillPanelHeader">
        <div>
          <p className="eyebrow">Lifecycle</p>
          <h2 id="skill-lifecycle-title">Control this skill.</h2>
        </div>
      </div>
      <div
        className="skillLifecycleActions"
        data-layout={showPracticeStateControls ? "split" : "single"}
      >
        {showPracticeStateControls ? (
          <div className="skillLifecycleGroup">
            <h3>Practice state</h3>
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
                description="Restored scheduled skills return to practice. Unscheduled skills return as drafts."
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
              summaryLabel={status === SkillStatus.DRAFT ? "Archive draft" : "Archive skill"}
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

function SkillRecentReviewsPanel({ reviews }: { reviews: PracticeHistoryReview[] }) {
  if (reviews.length === 0) {
    return null;
  }

  return (
    <section className="skillPanel skillRecentReviewsPanel" aria-labelledby="skill-reviews-title">
      <div className="skillPanelHeader">
        <div>
          <p className="eyebrow">History</p>
          <h2 id="skill-reviews-title">Recent reviews</h2>
        </div>
        <Link className="dashboardPanelLink" href="/history">
          Full history
        </Link>
      </div>

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
    </section>
  );
}

function SkillReviewStateTransition({ review }: { review: PracticeHistoryReview }) {
  const previousState = formatNullableHistoryLabel(review.previousState);
  const nextState = formatNullableHistoryLabel(review.nextState);

  return (
    <span
      className="historyTransitionText"
      aria-label={`State changed from ${previousState} to ${nextState}`}
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
