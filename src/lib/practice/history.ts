import "server-only";

import {
  ExerciseAttemptResult,
  type AnswerKind,
  type FsrsRating,
  type SkillFsrsState,
  type SkillStatus,
} from "@/generated/prisma/client";
import { formatSubmittedHistoryAnswer } from "./history-answer";
import { getPrisma } from "@/lib/prisma";

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;

export type PracticeHistoryReview = {
  id: string;
  skillId: string;
  skillTitle: string;
  skillStatus: SkillStatus;
  collectionName: string | null;
  exerciseAttemptId: string;
  answerKind: AnswerKind;
  result: Extract<
    ExerciseAttemptResult,
    typeof ExerciseAttemptResult.CORRECT | typeof ExerciseAttemptResult.INCORRECT
  >;
  responseMs: number | null;
  finalRating: FsrsRating;
  reviewedAt: Date;
  previousDueAt: Date | null;
  nextDueAt: Date | null;
  previousState: SkillFsrsState | null;
  nextState: SkillFsrsState | null;
  correctAnswerDisplay: string;
  prompt: string;
  submittedAnswerDisplay: string;
  explanation: string | null;
};

export type PracticeHistoryResult = {
  status: "ready";
  reviews: PracticeHistoryReview[];
};

export type SkillPracticeHistoryResult =
  | PracticeHistoryResult
  | {
      status: "not-found";
      message: string;
    };

export type GetPracticeHistoryInput = {
  userId: string;
  now: Date;
  limit?: number;
  skillId?: string;
  collectionId?: string;
  incorrectOnly?: boolean;
  cursor?: { reviewedAt: string; id: string };
};

export type GetSkillPracticeHistoryInput = GetPracticeHistoryInput & {
  skillId: string;
};

export async function getPracticeHistory(
  input: GetPracticeHistoryInput,
): Promise<PracticeHistoryResult> {
  assertValidHistoryDate(input.now, "getPracticeHistory");

  return {
    status: "ready",
    reviews: await findPracticeHistoryReviews(input),
  };
}

export async function getSkillPracticeHistory(
  input: GetSkillPracticeHistoryInput,
): Promise<SkillPracticeHistoryResult> {
  assertValidHistoryDate(input.now, "getSkillPracticeHistory");

  const prisma = getPrisma();
  const skill = await prisma.skill.findFirst({
    where: {
      id: input.skillId,
      userId: input.userId,
    },
    select: {
      id: true,
    },
  });

  if (!skill) {
    return {
      status: "not-found",
      message: "Skill not found.",
    };
  }

  return {
    status: "ready",
    reviews: await findPracticeHistoryReviews(input),
  };
}

async function findPracticeHistoryReviews(
  input: GetPracticeHistoryInput & { skillId?: string },
): Promise<PracticeHistoryReview[]> {
  const prisma = getPrisma();
  const rows = await prisma.reviewLog.findMany({
    where: {
      userId: input.userId,
      skillId: input.skillId,
      skill: input.collectionId ? { userId: input.userId, collectionId: input.collectionId } : undefined,
      ...(input.cursor ? { OR: [
        { reviewedAt: { lt: new Date(input.cursor.reviewedAt) } },
        { reviewedAt: new Date(input.cursor.reviewedAt), id: { gt: input.cursor.id } },
      ] } : {}),
      reviewedAt: {
        lte: input.now,
      },
      exerciseAttempt: {
        finalRating: {
          not: null,
        },
        result: {
          in: input.incorrectOnly ? [ExerciseAttemptResult.INCORRECT] : [ExerciseAttemptResult.CORRECT, ExerciseAttemptResult.INCORRECT],
        },
      },
    },
    orderBy: [{ reviewedAt: "desc" }, { id: "asc" }],
    take: normalizeHistoryLimit(input.limit),
    select: {
      id: true,
      skillId: true,
      exerciseAttemptId: true,
      finalRating: true,
      reviewedAt: true,
      previousDueAt: true,
      nextDueAt: true,
      previousState: true,
      nextState: true,
      exerciseAttempt: {
        select: {
          result: true,
          responseMs: true,
          answer: true,
          exercise: {
            select: {
              answerKind: true,
              correctAnswerDisplay: true,
              prompt: true,
              choices: true,
              explanation: true,
            },
          },
          skill: {
            select: {
              title: true,
              status: true,
              collection: {
                select: {
                  name: true,
                },
              },
            },
          },
        },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    skillId: row.skillId,
    skillTitle: row.exerciseAttempt.skill.title,
    skillStatus: row.exerciseAttempt.skill.status,
    collectionName: row.exerciseAttempt.skill.collection?.name ?? null,
    exerciseAttemptId: row.exerciseAttemptId,
    answerKind: row.exerciseAttempt.exercise.answerKind,
    result: row.exerciseAttempt.result as PracticeHistoryReview["result"],
    responseMs: row.exerciseAttempt.responseMs,
    finalRating: row.finalRating,
    reviewedAt: row.reviewedAt,
    previousDueAt: row.previousDueAt,
    nextDueAt: row.nextDueAt,
    previousState: row.previousState,
    nextState: row.nextState,
    correctAnswerDisplay: row.exerciseAttempt.exercise.correctAnswerDisplay,
    prompt: row.exerciseAttempt.exercise.prompt,
    submittedAnswerDisplay: formatSubmittedHistoryAnswer(row.exerciseAttempt.answer, row.exerciseAttempt.exercise.choices),
    explanation: row.exerciseAttempt.exercise.explanation,
  }));
}

function normalizeHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_HISTORY_LIMIT;
  }

  return Math.min(MAX_HISTORY_LIMIT, Math.max(1, Math.trunc(limit)));
}

function assertValidHistoryDate(now: Date, caller: string) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new Error(`${caller} requires a valid now Date.`);
  }
}

export async function getPracticeHistoryPage(input: GetPracticeHistoryInput) {
  assertValidHistoryDate(input.now, "getPracticeHistoryPage");
  const size = 50;
  const rows = await findPracticeHistoryReviews({ ...input, limit: size + 1 });
  const reviews = rows.slice(0, size);
  const last = reviews.at(-1);
  return { reviews, nextCursor: rows.length > size && last ? { reviewedAt: last.reviewedAt.toISOString(), id: last.id } : null };
}
