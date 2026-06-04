import "server-only";

import {
  AnswerKind,
  ExerciseAttemptResult,
  ExerciseVerificationStatus,
  FsrsRating,
  Prisma,
  SkillStatus,
  type ExerciseType,
  type SkillFsrsState,
} from "@/generated/prisma/client";
import { checkAnswer, type AnswerCheckResult } from "@/lib/answer-checking";
import { getPrisma } from "@/lib/prisma";
import {
  advanceSkillSchedule,
  mapAttemptToFsrsRating,
  type SkillScheduleFields,
} from "@/lib/scheduling";

const SUPPORTED_ANSWER_KINDS = [AnswerKind.CHOICE, AnswerKind.TEXT, AnswerKind.NUMERIC] as const;

export type PracticeSubmittedAnswer = Prisma.InputJsonValue;

export type PracticeSkillSummary = {
  id: string;
  title: string;
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

export type GetNextPracticeItemInput = {
  userId: string;
  now: Date;
};

export type PreviewPracticeAnswerInput = {
  userId: string;
  exerciseId: string;
  submittedAnswer: PracticeSubmittedAnswer;
  responseMs?: number | null;
  now?: Date;
};

export type CommitPracticeReviewInput = PreviewPracticeAnswerInput & {
  attemptId: string;
  manualRating?: FsrsRating | null;
  reviewedAt: Date;
};

type PracticeSkillRecord = SkillScheduleFields & {
  id: string;
  title: string;
};

type PracticeExerciseRecord = PracticeExerciseSummary & {
  userId: string;
  answerSpec: Prisma.JsonValue;
  createdAt: Date;
  skill: PracticeSkillRecord;
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

export async function getNextPracticeItem(
  input: GetNextPracticeItemInput,
): Promise<NextPracticeItemResult> {
  const prisma = getPrisma();
  const exercise = await findEligibleExercise(prisma, {
    userId: input.userId,
    now: input.now,
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

async function findEligibleExercise(
  prisma: PracticeQueryClient,
  input: {
    userId: string;
    exerciseId?: string;
    now: Date;
  },
): Promise<PracticeExerciseRecord | null> {
  const exercises = await prisma.exercise.findMany({
    where: {
      ...(input.exerciseId ? { id: input.exerciseId } : {}),
      userId: input.userId,
      verificationStatus: ExerciseVerificationStatus.VERIFIED,
      retiredAt: null,
      answerKind: { in: [...SUPPORTED_ANSWER_KINDS] },
      skill: {
        userId: input.userId,
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

  return exercises
    .map(toPracticeExerciseRecord)
    .toSorted(comparePracticeExercises)[0] ?? null;
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

function comparePracticeExercises(left: PracticeExerciseRecord, right: PracticeExerciseRecord) {
  const dueDifference = left.skill.dueAt.getTime() - right.skill.dueAt.getTime();

  if (dueDifference !== 0) {
    return dueDifference;
  }

  const skillDifference = left.skill.id.localeCompare(right.skill.id);

  if (skillDifference !== 0) {
    return skillDifference;
  }

  const createdDifference = left.createdAt.getTime() - right.createdAt.getTime();

  if (createdDifference !== 0) {
    return createdDifference;
  }

  return left.id.localeCompare(right.id);
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
  skill: NullableSkillScheduleRecord & { id: string; title: string },
): PracticeSkillRecord {
  const schedule = toSkillScheduleFields(skill);

  if (!schedule) {
    throw new Error(`Eligible practice skill ${skill.id} is missing FSRS fields.`);
  }

  return {
    id: skill.id,
    title: skill.title,
    ...schedule,
  };
}

function toPracticeSkillSummary(skill: PracticeSkillRecord): PracticeSkillSummary {
  return {
    id: skill.id,
    title: skill.title,
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
  "exercise" | "exerciseAttempt" | "reviewLog" | "skill"
>;

type RawEligibleExerciseRecord = Awaited<
  ReturnType<PracticeQueryClient["exercise"]["findMany"]>
>[number] & {
  skill: NullableSkillScheduleRecord & {
    id: string;
    title: string;
  };
};

type NullableSkillScheduleRecord = {
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
