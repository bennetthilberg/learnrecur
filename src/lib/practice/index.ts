import "server-only";

import {
  AnswerKind,
  ExerciseAttemptResult,
  ExerciseFlagReason,
  ExerciseFlagStatus,
  ExerciseRetirementReason,
  ExerciseVerificationStatus,
  FsrsRating,
  Prisma,
  SkillStatus,
  type ExerciseType,
  type SkillFsrsState,
} from "@/generated/prisma/client";
import {
  checkAnswer,
  isUsableMathAnswerSpec,
  numericAnswerSpecSchema,
  textAnswerSpecSchema,
  type AnswerCheckResult,
} from "@/lib/answer-checking";
import { formatEnvError } from "@/lib/env";
import type { ExerciseRefillEventSender } from "@/lib/inngest/events";
import { getPrisma } from "@/lib/prisma";
import {
  advanceSkillSchedule,
  mapAttemptToFsrsRating,
  type SkillScheduleFields,
} from "@/lib/scheduling";
import { isExactInputUnlocked } from "@/lib/skills";
import {
  queueChoiceExerciseRefillForSkill,
  queueExactInputExerciseRefillForSkill,
  queueMathExerciseRefillForSkill,
  type RefillQueueResult,
} from "@/lib/skills/refill-jobs";

const SUPPORTED_ANSWER_KINDS = [
  AnswerKind.CHOICE,
  AnswerKind.TEXT,
  AnswerKind.NUMERIC,
  AnswerKind.MATH,
] as const;

export type PracticeSubmittedAnswer = Prisma.InputJsonValue;

export type PracticeSkillSummary = {
  id: string;
  title: string;
  collectionId: string | null;
  dueAt: Date | null;
  stability: number | null;
  difficulty: number | null;
  fsrsState: SkillFsrsState;
  repetitions: number;
  lapses: number;
  lastReviewedAt: Date | null;
};

export type PracticeExerciseSummary = {
  id: string;
  skillId: string;
  type: ExerciseType;
  answerKind: AnswerKind;
  prompt: string;
  choices: Prisma.JsonValue | null;
  correctAnswerDisplay: string;
  explanation: string | null;
  difficulty: number | null;
  expectedSeconds: number | null;
};

export type PracticeAttemptSummary = {
  id: string;
  exerciseId: string;
  skillId: string;
  normalizedAnswer: string | null;
  isCorrect: boolean;
  result: ExerciseAttemptResult;
  responseMs: number | null;
  proposedRating: FsrsRating | null;
  finalRating: FsrsRating | null;
};

export type PracticeReviewLogSummary = {
  id: string;
  exerciseAttemptId: string;
  finalRating: FsrsRating;
  reviewedAt: Date;
  previousDueAt: Date | null;
  nextDueAt: Date | null;
  previousState: SkillFsrsState | null;
  nextState: SkillFsrsState | null;
  schedulerName: string;
  schedulerVersion: string;
};

export type NextPracticeItemResult =
  | {
      status: "ready";
      skill: PracticeSkillSummary;
      exercise: PracticeExerciseSummary;
    }
  | {
      status: "none-due";
      message: string;
    };

export type PracticeAnswerPreviewResult =
  | {
      status: "checked";
      answerCheck: AnswerCheckResult;
      proposedRating: FsrsRating | null;
      correctAnswerDisplay: string;
      explanation: string | null;
    }
  | {
      status: "not-found";
      reason: "exercise-not-found";
      message: string;
    };

export type PracticeReviewCommitResult =
  | {
      status: "committed";
      idempotent: boolean;
      answerCheck: AnswerCheckResult;
      proposedRating: FsrsRating;
      finalRating: FsrsRating;
      attempt: PracticeAttemptSummary;
      reviewLog: PracticeReviewLogSummary;
      skill: PracticeSkillSummary;
    }
  | {
      status: "not-committed";
      answerCheck: AnswerCheckResult;
      reason: "invalid-answer";
      message: string;
    }
  | {
      status: "not-found";
      reason: "exercise-not-found";
      message: string;
    }
  | {
      status: "conflict";
      reason: "attempt-id-conflict";
      message: string;
    };

export type PracticeExerciseFlagResult =
  | {
      status: "flagged";
      exerciseId: string;
      skillId: string;
      answerKind: AnswerKind;
      flagCount: number;
      retiredAt: Date;
      retirementReason: ExerciseRetirementReason;
      message: string;
    }
  | {
      status: "not-flagged";
      reason: "invalid-flag";
      message: string;
    }
  | {
      status: "not-found";
      reason: "exercise-not-found";
      message: string;
    };

export type PracticeFlagRefillResult =
  | {
      status: "queued";
      generationJobId: string;
      requestedCount: number;
      readyExerciseCount: number;
      targetReadyCount: number;
      message: string;
    }
  | {
      status: "not-queued";
      reason:
        | "already-at-target"
        | "event-send-failed"
        | "exact-input-locked"
        | "job-in-progress"
        | "missing-inngest-env"
        | "queue-error"
        | "skill-not-active"
        | "skill-not-found"
        | "unsupported-answer-kind";
      message: string;
      generationJobId?: string;
      readyExerciseCount?: number;
      targetReadyCount?: number;
    };

export type PracticeExerciseFlagWithRefillResult =
  | (Extract<PracticeExerciseFlagResult, { status: "flagged" }> & {
      refill: PracticeFlagRefillResult;
    })
  | Extract<PracticeExerciseFlagResult, { status: "not-flagged" | "not-found" }>;

export type GetNextPracticeItemInput = {
  userId: string;
  now: Date;
  answerKinds?: readonly AnswerKind[];
  collectionId?: string | null;
};

export type PreviewPracticeAnswerInput = {
  userId: string;
  exerciseId: string;
  submittedAnswer: PracticeSubmittedAnswer;
  responseMs?: number | null;
  now?: Date;
  answerKinds?: readonly AnswerKind[];
  collectionId?: string | null;
};

export type CommitPracticeReviewInput = PreviewPracticeAnswerInput & {
  attemptId: string;
  manualRating?: FsrsRating | null;
  reviewedAt: Date;
};

export type FlagPracticeExerciseInput = {
  userId: string;
  exerciseId: string;
  reasons: readonly ExerciseFlagReason[];
  otherNote?: string | null;
  flaggedAt: Date;
  collectionId?: string | null;
};

export type FlagPracticeExerciseAndQueueRefillInput = FlagPracticeExerciseInput & {
  refillSender?: ExerciseRefillEventSender;
  model?: string;
};

type PracticeSkillRecord = SkillScheduleFields & {
  id: string;
  title: string;
  collectionId: string | null;
};

type PracticeExerciseRecord = PracticeExerciseSummary & {
  userId: string;
  answerSpec: Prisma.JsonValue;
  createdAt: Date;
  skill: PracticeSkillRecord;
};

type ExerciseAttemptRotationStats = {
  attemptCount: number;
  lastAttemptedAt: Date | null;
};

type ExistingAttemptRecord = {
  id: string;
  userId: string;
  exerciseId: string;
  skillId: string;
  normalizedAnswer: string | null;
  isCorrect: boolean;
  result: ExerciseAttemptResult;
  responseMs: number | null;
  proposedRating: FsrsRating | null;
  finalRating: FsrsRating | null;
  skill: NullableSkillScheduleRecord & {
    id: string;
    title: string;
    collectionId: string | null;
  };
  reviewLog: {
    id: string;
    exerciseAttemptId: string;
    finalRating: FsrsRating;
    reviewedAt: Date;
    previousDueAt: Date | null;
    nextDueAt: Date | null;
    nextStability: number | null;
    nextDifficulty: number | null;
    nextElapsedDays: number | null;
    nextScheduledDays: number | null;
    nextLearningSteps: number | null;
    nextRepetitions: number | null;
    nextLapses: number | null;
    previousState: SkillFsrsState | null;
    nextState: SkillFsrsState | null;
    schedulerName: string;
    schedulerVersion: string;
  } | null;
};

type ResolveFinalPracticeRatingInput = {
  isCorrect: boolean;
  proposedRating: FsrsRating;
  manualRating?: FsrsRating | null;
};

const RETIREMENT_RESOLUTION_NOTE = "Retired from practice.";

export async function getNextPracticeItem(
  input: GetNextPracticeItemInput,
): Promise<NextPracticeItemResult> {
  const prisma = getPrisma();
  const exercise = await findEligibleExercise(prisma, {
    userId: input.userId,
    now: input.now,
    answerKinds: input.answerKinds,
    collectionId: input.collectionId,
  });

  if (!exercise) {
    return {
      status: "none-due",
      message: "No due practice item is ready.",
    };
  }

  return {
    status: "ready",
    skill: toPracticeSkillSummary(exercise.skill),
    exercise: toPracticeExerciseSummary(exercise),
  };
}

export async function previewPracticeAnswer(
  input: PreviewPracticeAnswerInput,
): Promise<PracticeAnswerPreviewResult> {
  const prisma = getPrisma();
  const exercise = await findEligibleExercise(prisma, {
    userId: input.userId,
    exerciseId: input.exerciseId,
    now: input.now ?? new Date(),
    answerKinds: input.answerKinds,
    collectionId: input.collectionId,
  });

  if (!exercise) {
    return exerciseNotFound();
  }

  const answerCheck = checkAnswer({
    answerSpec: exercise.answerSpec,
    choices: exercise.choices,
    submittedAnswer: input.submittedAnswer,
  });

  return {
    status: "checked",
    answerCheck,
    proposedRating: getProposedRating(answerCheck, exercise.expectedSeconds, input.responseMs),
    correctAnswerDisplay: exercise.correctAnswerDisplay,
    explanation: exercise.explanation,
  };
}

export async function commitPracticeReview(
  input: CommitPracticeReviewInput,
): Promise<PracticeReviewCommitResult> {
  const prisma = getPrisma();

  try {
    return await prisma.$transaction(async (tx) => commitPracticeReviewInTransaction(tx, input));
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      const existingAttempt = await findExistingAttempt(prisma, input.attemptId);

      if (existingAttempt) {
        return existingAttemptToResult(existingAttempt, input);
      }
    }

    throw error;
  }
}

export async function flagPracticeExercise(
  input: FlagPracticeExerciseInput,
): Promise<PracticeExerciseFlagResult> {
  const uniqueReasons = [...new Set(input.reasons)];

  if (uniqueReasons.length === 0) {
    return {
      status: "not-flagged",
      reason: "invalid-flag",
      message: "Choose at least one reason to report this exercise.",
    };
  }

  const otherNote = input.otherNote?.trim() ?? "";

  if (uniqueReasons.includes(ExerciseFlagReason.OTHER) && otherNote.length === 0) {
    return {
      status: "not-flagged",
      reason: "invalid-flag",
      message: "Add a short note for something else.",
    };
  }

  const retirementReason = toExerciseRetirementReason(uniqueReasons);
  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    const exercise = await tx.exercise.findFirst({
      where: {
        id: input.exerciseId,
        userId: input.userId,
        ...(input.collectionId
          ? {
              skill: {
                collectionId: input.collectionId,
              },
            }
          : {}),
      },
      select: {
        id: true,
        skillId: true,
        answerKind: true,
        retiredAt: true,
        retirementReason: true,
      },
    });

    if (!exercise) {
      return exerciseNotFound();
    }

    await tx.exercise.update({
      where: { id: exercise.id },
      data: {
        retiredAt: exercise.retiredAt ?? input.flaggedAt,
        retirementReason: exercise.retirementReason ?? retirementReason,
      },
    });

    const existingFlags = await tx.exerciseFlag.findMany({
      where: {
        userId: input.userId,
        exerciseId: exercise.id,
        reason: { in: uniqueReasons },
      },
      select: {
        id: true,
        reason: true,
      },
    });
    const existingReasons = new Set(existingFlags.map((flag) => flag.reason));

    if (existingFlags.length > 0) {
      await tx.exerciseFlag.updateMany({
        where: {
          id: { in: existingFlags.map((flag) => flag.id) },
        },
        data: {
          status: ExerciseFlagStatus.RESOLVED,
          resolvedAt: input.flaggedAt,
          resolutionNote: RETIREMENT_RESOLUTION_NOTE,
          retiredExerciseAt: exercise.retiredAt ?? input.flaggedAt,
          retirementReason: exercise.retirementReason ?? retirementReason,
        },
      });

      if (existingReasons.has(ExerciseFlagReason.OTHER)) {
        await tx.exerciseFlag.updateMany({
          where: {
            userId: input.userId,
            exerciseId: exercise.id,
            reason: ExerciseFlagReason.OTHER,
          },
          data: { note: otherNote },
        });
      }
    }

    const missingReasons = uniqueReasons.filter((reason) => !existingReasons.has(reason));

    if (missingReasons.length > 0) {
      await tx.exerciseFlag.createMany({
        data: missingReasons.map((reason) => ({
          userId: input.userId,
          exerciseId: exercise.id,
          reason,
          note: reason === ExerciseFlagReason.OTHER ? otherNote : null,
          status: ExerciseFlagStatus.RESOLVED,
          resolvedAt: input.flaggedAt,
          resolutionNote: RETIREMENT_RESOLUTION_NOTE,
          retiredExerciseAt: exercise.retiredAt ?? input.flaggedAt,
          retirementReason: exercise.retirementReason ?? retirementReason,
        })),
      });
    }

    return {
      status: "flagged",
      exerciseId: exercise.id,
      skillId: exercise.skillId,
      answerKind: exercise.answerKind,
      flagCount: uniqueReasons.length,
      retiredAt: exercise.retiredAt ?? input.flaggedAt,
      retirementReason: exercise.retirementReason ?? retirementReason,
      message: "Exercise reported and retired from practice.",
    };
  });
}

export async function flagPracticeExerciseAndQueueRefill(
  input: FlagPracticeExerciseAndQueueRefillInput,
): Promise<PracticeExerciseFlagWithRefillResult> {
  const flagResult = await flagPracticeExercise(input);

  if (flagResult.status !== "flagged") {
    return flagResult;
  }

  const refill = await queueRefillAfterPracticeFlag({
    userId: input.userId,
    skillId: flagResult.skillId,
    answerKind: flagResult.answerKind,
    now: input.flaggedAt,
    sender: input.refillSender,
    model: input.model,
  });

  return {
    ...flagResult,
    refill,
  };
}

async function queueRefillAfterPracticeFlag({
  userId,
  skillId,
  answerKind,
  now,
  sender,
  model,
}: {
  userId: string;
  skillId: string;
  answerKind: AnswerKind;
  now: Date;
  sender?: ExerciseRefillEventSender;
  model?: string;
}): Promise<PracticeFlagRefillResult> {
  try {
    switch (answerKind) {
      case AnswerKind.CHOICE:
        return toPracticeFlagRefillResult(
          await queueChoiceExerciseRefillForSkill({
            userId,
            skillId,
            now,
            sender,
            model,
          }),
        );
      case AnswerKind.TEXT:
      case AnswerKind.NUMERIC:
        return toPracticeFlagRefillResult(
          await queueExactInputExerciseRefillForSkill({
            userId,
            skillId,
            now,
            sender,
            model,
          }),
        );
      case AnswerKind.MATH:
        return toPracticeFlagRefillResult(
          await queueMathExerciseRefillForSkill({
            userId,
            skillId,
            now,
            sender,
            model,
          }),
        );
    }
  } catch (error) {
    return {
      status: "not-queued",
      reason: "queue-error",
      message: `Replacement preparation could not start: ${formatEnvError(error)}`,
    };
  }
}

function toPracticeFlagRefillResult(result: RefillQueueResult): PracticeFlagRefillResult {
  if (result.status === "queued") {
    return {
      status: "queued",
      generationJobId: result.generationJobId,
      requestedCount: result.requestedCount,
      readyExerciseCount: result.readyExerciseCount,
      targetReadyCount: result.targetReadyCount,
      message: result.message,
    };
  }

  if (result.status === "not-queued") {
    return {
      status: "not-queued",
      reason: result.reason,
      message: result.message,
      generationJobId: result.generationJobId,
      readyExerciseCount: result.readyExerciseCount,
      targetReadyCount: result.targetReadyCount,
    };
  }

  if (result.status === "missing-inngest-env") {
    return {
      status: "not-queued",
      reason: "missing-inngest-env",
      message: result.message,
    };
  }

  return {
    status: "not-queued",
    reason: "skill-not-found",
    message: result.message,
  };
}

async function commitPracticeReviewInTransaction(
  tx: PracticeQueryClient,
  input: CommitPracticeReviewInput,
): Promise<PracticeReviewCommitResult> {
  const existingAttempt = await tx.exerciseAttempt.findUnique({
    where: { id: input.attemptId },
    include: {
      skill: true,
      reviewLog: true,
    },
  });

  if (existingAttempt) {
    return existingAttemptToResult(existingAttempt, input);
  }

  const exercise = await findEligibleExercise(tx, {
    userId: input.userId,
    exerciseId: input.exerciseId,
    now: input.reviewedAt,
    answerKinds: input.answerKinds,
    collectionId: input.collectionId,
  });

  if (!exercise) {
    return exerciseNotFound();
  }

  const answerCheck = checkAnswer({
    answerSpec: exercise.answerSpec,
    choices: exercise.choices,
    submittedAnswer: input.submittedAnswer,
  });

  if (answerCheck.status !== "correct" && answerCheck.status !== "incorrect") {
    return {
      status: "not-committed",
      answerCheck,
      reason: "invalid-answer",
      message: "Answer was checked but is not commit-ready.",
    };
  }

  const proposedRating = mapAttemptToFsrsRating({
    isCorrect: answerCheck.isCorrect,
    responseMs: input.responseMs,
    expectedSeconds: exercise.expectedSeconds,
  });
  const finalRating = resolveFinalPracticeRating({
    isCorrect: answerCheck.isCorrect,
    proposedRating,
    manualRating: input.manualRating,
  });
  const advancement = advanceSkillSchedule({
    current: exercise.skill,
    rating: finalRating,
    reviewedAt: input.reviewedAt,
  });

  const attempt = await tx.exerciseAttempt.create({
    data: {
      id: input.attemptId,
      userId: input.userId,
      skillId: exercise.skillId,
      exerciseId: exercise.id,
      answer: toStoredAnswer(input.submittedAnswer),
      normalizedAnswer: answerCheck.normalizedAnswer,
      isCorrect: answerCheck.isCorrect,
      result: answerCheck.isCorrect
        ? ExerciseAttemptResult.CORRECT
        : ExerciseAttemptResult.INCORRECT,
      responseMs: input.responseMs ?? null,
      proposedRating,
      finalRating,
      feedbackShownAt: input.reviewedAt,
    },
  });

  const updatedSkill = await tx.skill.update({
    where: { id: exercise.skillId },
    data: {
      dueAt: advancement.skillUpdate.dueAt,
      stability: advancement.skillUpdate.stability,
      difficulty: advancement.skillUpdate.difficulty,
      elapsedDays: advancement.skillUpdate.elapsedDays,
      scheduledDays: advancement.skillUpdate.scheduledDays,
      learningSteps: advancement.skillUpdate.learningSteps,
      repetitions: advancement.skillUpdate.repetitions,
      lapses: advancement.skillUpdate.lapses,
      fsrsState: advancement.skillUpdate.fsrsState,
      lastReviewedAt: advancement.skillUpdate.lastReviewedAt,
    },
  });

  const reviewLog = await tx.reviewLog.create({
    data: {
      userId: input.userId,
      skillId: exercise.skillId,
      exerciseAttemptId: attempt.id,
      finalRating,
      reviewedAt: input.reviewedAt,
      previousDueAt: advancement.reviewLog.previousDueAt,
      nextDueAt: advancement.reviewLog.nextDueAt,
      previousStability: advancement.reviewLog.previousStability,
      nextStability: advancement.reviewLog.nextStability,
      previousDifficulty: advancement.reviewLog.previousDifficulty,
      nextDifficulty: advancement.reviewLog.nextDifficulty,
      previousElapsedDays: advancement.reviewLog.previousElapsedDays,
      nextElapsedDays: advancement.reviewLog.nextElapsedDays,
      previousScheduledDays: advancement.reviewLog.previousScheduledDays,
      nextScheduledDays: advancement.reviewLog.nextScheduledDays,
      previousLearningSteps: advancement.reviewLog.previousLearningSteps,
      nextLearningSteps: advancement.reviewLog.nextLearningSteps,
      previousRepetitions: advancement.reviewLog.previousRepetitions,
      nextRepetitions: advancement.reviewLog.nextRepetitions,
      previousLapses: advancement.reviewLog.previousLapses,
      nextLapses: advancement.reviewLog.nextLapses,
      previousState: advancement.reviewLog.previousState,
      nextState: advancement.reviewLog.nextState,
      schedulerName: advancement.reviewLog.schedulerName,
      schedulerVersion: advancement.reviewLog.schedulerVersion,
      desiredRetention: advancement.reviewLog.desiredRetention,
      schedulerParameters: advancement.reviewLog.schedulerParameters,
    },
  });

  return {
    status: "committed",
    idempotent: false,
    answerCheck,
    proposedRating,
    finalRating,
    attempt: toPracticeAttemptSummary(attempt),
    reviewLog: toPracticeReviewLogSummary(reviewLog),
    skill: toPracticeSkillSummary(toPracticeSkillRecordOrThrow(updatedSkill)),
  };
}

async function findExistingAttempt(
  prisma: PracticeQueryClient,
  attemptId: string,
): Promise<ExistingAttemptRecord | null> {
  return prisma.exerciseAttempt.findUnique({
    where: { id: attemptId },
    include: {
      skill: true,
      reviewLog: true,
    },
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

export function resolveFinalPracticeRating(input: ResolveFinalPracticeRatingInput): FsrsRating {
  if (!input.isCorrect) {
    return FsrsRating.AGAIN;
  }

  if (
    input.manualRating === FsrsRating.HARD ||
    input.manualRating === FsrsRating.GOOD ||
    input.manualRating === FsrsRating.EASY
  ) {
    return input.manualRating;
  }

  return input.proposedRating;
}

function toExerciseRetirementReason(
  reasons: readonly ExerciseFlagReason[],
): ExerciseRetirementReason {
  if (reasons.includes(ExerciseFlagReason.INCORRECT_ANSWER)) {
    return ExerciseRetirementReason.FLAGGED_INCORRECT;
  }

  if (reasons.includes(ExerciseFlagReason.UNCLEAR_PROMPT)) {
    return ExerciseRetirementReason.FLAGGED_UNCLEAR;
  }

  if (reasons.includes(ExerciseFlagReason.UNFAIR)) {
    return ExerciseRetirementReason.FLAGGED_UNFAIR;
  }

  if (reasons.includes(ExerciseFlagReason.STALE)) {
    return ExerciseRetirementReason.STALE;
  }

  return ExerciseRetirementReason.OTHER;
}

async function findEligibleExercise(
  prisma: PracticeQueryClient,
  input: {
    userId: string;
    exerciseId?: string;
    now: Date;
    answerKinds?: readonly AnswerKind[];
    collectionId?: string | null;
  },
): Promise<PracticeExerciseRecord | null> {
  const answerKinds = [...(input.answerKinds ?? SUPPORTED_ANSWER_KINDS)].filter(
    isSupportedAnswerKind,
  );

  if (answerKinds.length === 0) {
    return null;
  }

  const exercises = await prisma.exercise.findMany({
    where: {
      ...(input.exerciseId ? { id: input.exerciseId } : {}),
      userId: input.userId,
      verificationStatus: ExerciseVerificationStatus.VERIFIED,
      retiredAt: null,
      answerKind: { in: answerKinds },
      skill: {
        userId: input.userId,
        ...(input.collectionId ? { collectionId: input.collectionId } : {}),
        status: SkillStatus.ACTIVE,
        dueAt: { lte: input.now },
        stability: { not: null },
        difficulty: { not: null },
      },
    },
    include: {
      skill: true,
    },
  });
  const exerciseRecords = exercises
    .map(toPracticeExerciseRecord)
    .filter(hasCompatiblePracticeAnswerSpec)
    .filter(isPracticeExerciseUnlockedForSkill);
  const attemptStatsByExerciseId = await getExerciseAttemptRotationStats(prisma, {
    userId: input.userId,
    exerciseIds: exerciseRecords.map((exercise) => exercise.id),
  });

  return (
    exerciseRecords.toSorted((left, right) =>
      comparePracticeExercises(left, right, attemptStatsByExerciseId),
    )[0] ?? null
  );
}

async function getExerciseAttemptRotationStats(
  prisma: PracticeQueryClient,
  input: {
    userId: string;
    exerciseIds: readonly string[];
  },
): Promise<Map<string, ExerciseAttemptRotationStats>> {
  if (input.exerciseIds.length === 0) {
    return new Map();
  }

  const stats = await prisma.exerciseAttempt.groupBy({
    by: ["exerciseId"],
    where: {
      userId: input.userId,
      exerciseId: { in: [...input.exerciseIds] },
    },
    _count: {
      id: true,
    },
    _max: {
      createdAt: true,
    },
  });

  return new Map(
    stats.map((stat) => [
      stat.exerciseId,
      {
        attemptCount: stat._count.id,
        lastAttemptedAt: stat._max.createdAt,
      },
    ]),
  );
}

function isSupportedAnswerKind(
  answerKind: AnswerKind,
): answerKind is (typeof SUPPORTED_ANSWER_KINDS)[number] {
  return SUPPORTED_ANSWER_KINDS.includes(
    answerKind as (typeof SUPPORTED_ANSWER_KINDS)[number],
  );
}

function getProposedRating(
  answerCheck: AnswerCheckResult,
  expectedSeconds: number | null,
  responseMs?: number | null,
): FsrsRating | null {
  if (answerCheck.status !== "correct" && answerCheck.status !== "incorrect") {
    return null;
  }

  return mapAttemptToFsrsRating({
    isCorrect: answerCheck.isCorrect,
    responseMs,
    expectedSeconds,
  });
}

function existingAttemptToResult(
  attempt: ExistingAttemptRecord,
  input: CommitPracticeReviewInput,
): PracticeReviewCommitResult {
  if (attempt.userId !== input.userId || attempt.exerciseId !== input.exerciseId) {
    return {
      status: "conflict",
      reason: "attempt-id-conflict",
      message: "Attempt ID has already been used for a different practice review.",
    };
  }

  if (input.collectionId && attempt.skill.collectionId !== input.collectionId) {
    return exerciseNotFound();
  }

  if (!attempt.reviewLog || !attempt.finalRating || !attempt.proposedRating) {
    return {
      status: "conflict",
      reason: "attempt-id-conflict",
      message: "Attempt ID belongs to an incomplete practice review.",
    };
  }

  return {
    status: "committed",
    idempotent: true,
    answerCheck: {
      status: attempt.isCorrect ? "correct" : "incorrect",
      isCorrect: attempt.isCorrect,
      normalizedAnswer: attempt.normalizedAnswer,
    },
    proposedRating: attempt.proposedRating,
    finalRating: attempt.finalRating,
    attempt: toPracticeAttemptSummary(attempt),
    reviewLog: toPracticeReviewLogSummary(attempt.reviewLog),
    skill: toPracticeSkillSummary(
      toPracticeSkillRecordFromReviewLog(attempt) ?? toPracticeSkillRecordOrThrow(attempt.skill),
    ),
  };
}

function exerciseNotFound(): PracticeAnswerPreviewResult & PracticeReviewCommitResult {
  return {
    status: "not-found",
    reason: "exercise-not-found",
    message: "No eligible practice exercise was found for this user.",
  };
}

function comparePracticeExercises(
  left: PracticeExerciseRecord,
  right: PracticeExerciseRecord,
  attemptStatsByExerciseId: ReadonlyMap<string, ExerciseAttemptRotationStats> = new Map(),
) {
  const dueDifference = left.skill.dueAt.getTime() - right.skill.dueAt.getTime();

  if (dueDifference !== 0) {
    return dueDifference;
  }

  const skillDifference = left.skill.id.localeCompare(right.skill.id);

  if (skillDifference !== 0) {
    return skillDifference;
  }

  const leftAttemptStats = getExerciseAttemptStats(attemptStatsByExerciseId, left.id);
  const rightAttemptStats = getExerciseAttemptStats(attemptStatsByExerciseId, right.id);
  const leftWasAttempted = leftAttemptStats.attemptCount > 0;
  const rightWasAttempted = rightAttemptStats.attemptCount > 0;
  const attemptedDifference = Number(leftWasAttempted) - Number(rightWasAttempted);

  if (attemptedDifference !== 0) {
    return attemptedDifference;
  }

  if (leftWasAttempted && rightWasAttempted) {
    const lastAttemptDifference =
      (leftAttemptStats.lastAttemptedAt?.getTime() ?? 0) -
      (rightAttemptStats.lastAttemptedAt?.getTime() ?? 0);

    if (lastAttemptDifference !== 0) {
      return lastAttemptDifference;
    }
  }

  const attemptCountDifference = leftAttemptStats.attemptCount - rightAttemptStats.attemptCount;

  if (attemptCountDifference !== 0) {
    return attemptCountDifference;
  }

  const createdDifference = left.createdAt.getTime() - right.createdAt.getTime();

  if (createdDifference !== 0) {
    return createdDifference;
  }

  return left.id.localeCompare(right.id);
}

function getExerciseAttemptStats(
  attemptStatsByExerciseId: ReadonlyMap<string, ExerciseAttemptRotationStats>,
  exerciseId: string,
): ExerciseAttemptRotationStats {
  return (
    attemptStatsByExerciseId.get(exerciseId) ?? {
      attemptCount: 0,
      lastAttemptedAt: null,
    }
  );
}

function isPracticeExerciseUnlockedForSkill(exercise: PracticeExerciseRecord): boolean {
  if (
    exercise.answerKind === AnswerKind.TEXT ||
    exercise.answerKind === AnswerKind.NUMERIC ||
    exercise.answerKind === AnswerKind.MATH
  ) {
    return isExactInputUnlocked(exercise.skill.repetitions);
  }

  return true;
}

function hasCompatiblePracticeAnswerSpec(exercise: PracticeExerciseRecord): boolean {
  if (exercise.answerKind === AnswerKind.TEXT) {
    return textAnswerSpecSchema.safeParse(exercise.answerSpec).success;
  }

  if (exercise.answerKind === AnswerKind.NUMERIC) {
    return numericAnswerSpecSchema.safeParse(exercise.answerSpec).success;
  }

  if (exercise.answerKind === AnswerKind.MATH) {
    return isUsableMathAnswerSpec(exercise.answerSpec);
  }

  return true;
}

function toPracticeExerciseRecord(
  exercise: RawEligibleExerciseRecord,
): PracticeExerciseRecord {
  const skill = toPracticeSkillRecordOrThrow(exercise.skill);

  return {
    id: exercise.id,
    userId: exercise.userId,
    skillId: exercise.skillId,
    type: exercise.type,
    answerKind: exercise.answerKind,
    prompt: exercise.prompt,
    choices: exercise.choices,
    answerSpec: exercise.answerSpec,
    correctAnswerDisplay: exercise.correctAnswerDisplay,
    explanation: exercise.explanation,
    difficulty: exercise.difficulty,
    expectedSeconds: exercise.expectedSeconds,
    createdAt: exercise.createdAt,
    skill,
  };
}

function toPracticeSkillRecordOrThrow(
  skill: NullableSkillScheduleRecord & { id: string; title: string; collectionId: string | null },
): PracticeSkillRecord {
  const schedule = toSkillScheduleFields(skill);

  if (!schedule) {
    throw new Error(`Eligible practice skill ${skill.id} is missing FSRS fields.`);
  }

  return {
    id: skill.id,
    title: skill.title,
    collectionId: skill.collectionId,
    ...schedule,
  };
}

function toPracticeSkillSummary(skill: PracticeSkillRecord): PracticeSkillSummary {
  return {
    id: skill.id,
    title: skill.title,
    collectionId: skill.collectionId,
    dueAt: skill.dueAt,
    stability: skill.stability,
    difficulty: skill.difficulty,
    fsrsState: skill.fsrsState,
    repetitions: skill.repetitions,
    lapses: skill.lapses,
    lastReviewedAt: skill.lastReviewedAt,
  };
}

function toPracticeSkillRecordFromReviewLog(
  attempt: ExistingAttemptRecord,
): PracticeSkillRecord | null {
  const { reviewLog } = attempt;

  if (
    !reviewLog ||
    reviewLog.nextDueAt === null ||
    reviewLog.nextStability === null ||
    reviewLog.nextDifficulty === null ||
    reviewLog.nextElapsedDays === null ||
    reviewLog.nextScheduledDays === null ||
    reviewLog.nextLearningSteps === null ||
    reviewLog.nextRepetitions === null ||
    reviewLog.nextLapses === null ||
    reviewLog.nextState === null
  ) {
    return null;
  }

  return {
    id: attempt.skill.id,
    title: attempt.skill.title,
    collectionId: attempt.skill.collectionId,
    dueAt: reviewLog.nextDueAt,
    stability: reviewLog.nextStability,
    difficulty: reviewLog.nextDifficulty,
    elapsedDays: reviewLog.nextElapsedDays,
    scheduledDays: reviewLog.nextScheduledDays,
    learningSteps: reviewLog.nextLearningSteps,
    repetitions: reviewLog.nextRepetitions,
    lapses: reviewLog.nextLapses,
    fsrsState: reviewLog.nextState,
    lastReviewedAt: reviewLog.reviewedAt,
  };
}

function toPracticeExerciseSummary(exercise: PracticeExerciseRecord): PracticeExerciseSummary {
  return {
    id: exercise.id,
    skillId: exercise.skillId,
    type: exercise.type,
    answerKind: exercise.answerKind,
    prompt: exercise.prompt,
    choices: exercise.choices,
    correctAnswerDisplay: exercise.correctAnswerDisplay,
    explanation: exercise.explanation,
    difficulty: exercise.difficulty,
    expectedSeconds: exercise.expectedSeconds,
  };
}

function toPracticeAttemptSummary(attempt: PracticeAttemptSummary): PracticeAttemptSummary {
  return {
    id: attempt.id,
    exerciseId: attempt.exerciseId,
    skillId: attempt.skillId,
    normalizedAnswer: attempt.normalizedAnswer,
    isCorrect: attempt.isCorrect,
    result: attempt.result,
    responseMs: attempt.responseMs,
    proposedRating: attempt.proposedRating,
    finalRating: attempt.finalRating,
  };
}

function toPracticeReviewLogSummary(
  reviewLog: PracticeReviewLogSummary,
): PracticeReviewLogSummary {
  return {
    id: reviewLog.id,
    exerciseAttemptId: reviewLog.exerciseAttemptId,
    finalRating: reviewLog.finalRating,
    reviewedAt: reviewLog.reviewedAt,
    previousDueAt: reviewLog.previousDueAt,
    nextDueAt: reviewLog.nextDueAt,
    previousState: reviewLog.previousState,
    nextState: reviewLog.nextState,
    schedulerName: reviewLog.schedulerName,
    schedulerVersion: reviewLog.schedulerVersion,
  };
}

function toSkillScheduleFields(skill: NullableSkillScheduleRecord): SkillScheduleFields | null {
  if (skill.dueAt === null || skill.stability === null || skill.difficulty === null) {
    return null;
  }

  return {
    dueAt: skill.dueAt,
    stability: skill.stability,
    difficulty: skill.difficulty,
    elapsedDays: skill.elapsedDays,
    scheduledDays: skill.scheduledDays,
    learningSteps: skill.learningSteps,
    repetitions: skill.repetitions,
    lapses: skill.lapses,
    fsrsState: skill.fsrsState,
    lastReviewedAt: skill.lastReviewedAt,
  };
}

function toStoredAnswer(submittedAnswer: PracticeSubmittedAnswer): Prisma.InputJsonObject {
  return { raw: submittedAnswer };
}

type PracticeQueryClient = Pick<
  Prisma.TransactionClient,
  "exercise" | "exerciseAttempt" | "exerciseFlag" | "reviewLog" | "skill"
>;

type RawEligibleExerciseRecord = Awaited<
  ReturnType<PracticeQueryClient["exercise"]["findMany"]>
>[number] & {
  skill: NullableSkillScheduleRecord & {
    id: string;
    title: string;
    collectionId: string | null;
  };
};

type NullableSkillScheduleRecord = {
  collectionId: string | null;
  dueAt: Date | null;
  stability: number | null;
  difficulty: number | null;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  repetitions: number;
  lapses: number;
  fsrsState: SkillFsrsState;
  lastReviewedAt: Date | null;
};
