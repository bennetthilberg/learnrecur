import "server-only";

import {
  ExerciseAttemptResult,
  ExerciseEvidenceCorrectionStatus,
  Prisma,
  type AnswerKind,
  type FsrsRating,
  type SkillFsrsState,
  type SkillStatus,
} from "@/generated/prisma/client";
import { formatSubmittedHistoryAnswer } from "./history-answer";
import { getPrisma } from "@/lib/prisma";

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;

export type PracticeHistoryMode = "scheduled" | "practice-only";

export type PracticeHistoryCursor = {
  mode: PracticeHistoryMode;
  reviewedAt: string;
  id: string;
};

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
  finalRating: FsrsRating | null;
  reviewedAt: Date;
  previousDueAt: Date | null;
  nextDueAt: Date | null;
  previousState: SkillFsrsState | null;
  nextState: SkillFsrsState | null;
  correctAnswerDisplay: string;
  prompt: string;
  submittedAnswerDisplay: string;
  explanation: string | null;
  eventKind: PracticeHistoryMode;
  practiceContext: Prisma.JsonValue | null;
  evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus;
  evidenceCorrectionNote: string | null;
  evidenceCorrectionAt: Date | null;
  evidenceCorrectionIncidentKey: string | null;
  qualityReportReasons: string[];
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

export class PracticeHistoryCursorError extends Error {
  constructor(message = "The practice history pagination cursor is invalid.") {
    super(message);
    this.name = "PracticeHistoryCursorError";
  }
}

export type GetPracticeHistoryInput = {
  userId: string;
  now: Date;
  limit?: number;
  skillId?: string;
  collectionId?: string;
  incorrectOnly?: boolean;
  mode?: PracticeHistoryMode;
  cursor?: PracticeHistoryCursor;
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
  const mode = input.mode ?? "scheduled";
  if (input.cursor && input.cursor.mode !== mode) {
    throw new PracticeHistoryCursorError(
      "The practice history cursor does not match the requested activity mode.",
    );
  }
  return mode === "practice-only"
    ? findPracticeOnlyHistoryReviews(input)
    : findScheduledHistoryReviews(input);
}

async function findScheduledHistoryReviews(
  input: GetPracticeHistoryInput & { skillId?: string },
): Promise<PracticeHistoryReview[]> {
  const rows = await getPrisma().reviewLog.findMany({
    where: {
      userId: input.userId,
      skillId: input.skillId,
      skill: input.collectionId
        ? { userId: input.userId, collectionId: input.collectionId }
        : undefined,
      ...(input.cursor
        ? {
            OR: [
              { reviewedAt: { lt: new Date(input.cursor.reviewedAt) } },
              { reviewedAt: new Date(input.cursor.reviewedAt), id: { gt: input.cursor.id } },
            ],
          }
        : {}),
      reviewedAt: {
        lte: input.now,
      },
      exerciseAttempt: {
        finalRating: {
          not: null,
        },
        result: {
          in: input.incorrectOnly
            ? [ExerciseAttemptResult.INCORRECT]
            : [ExerciseAttemptResult.CORRECT, ExerciseAttemptResult.INCORRECT],
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
      evidenceCorrectionStatus: true,
      evidenceCorrectionNote: true,
      evidenceCorrectionAt: true,
      evidenceCorrectionIncidentKey: true,
      exerciseAttempt: {
        select: {
          result: true,
          responseMs: true,
          answer: true,
          practiceContext: true,
          evidenceCorrectionStatus: true,
          evidenceCorrectionNote: true,
          evidenceCorrectionAt: true,
          evidenceCorrectionIncidentKey: true,
          exercise: {
            select: {
              answerKind: true,
              correctAnswerDisplay: true,
              prompt: true,
              choices: true,
              explanation: true,
              flags: {
                where: { userId: input.userId },
                select: { reason: true },
              },
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

  return rows.map((row) => {
    const correction = chooseCorrectionAnnotation({
      primary: row.evidenceCorrectionStatus,
      primaryNote: row.evidenceCorrectionNote,
      primaryAt: row.evidenceCorrectionAt,
      primaryIncidentKey: row.evidenceCorrectionIncidentKey,
      fallback: row.exerciseAttempt.evidenceCorrectionStatus,
      fallbackNote: row.exerciseAttempt.evidenceCorrectionNote,
      fallbackAt: row.exerciseAttempt.evidenceCorrectionAt,
      fallbackIncidentKey: row.exerciseAttempt.evidenceCorrectionIncidentKey,
    });

    return {
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
      submittedAnswerDisplay: formatSubmittedHistoryAnswer(
        row.exerciseAttempt.answer,
        row.exerciseAttempt.exercise.choices,
      ),
      explanation: row.exerciseAttempt.exercise.explanation,
      eventKind: "scheduled" as const,
      practiceContext: row.exerciseAttempt.practiceContext,
      evidenceCorrectionStatus: correction.status,
      evidenceCorrectionNote: correction.note,
      evidenceCorrectionAt: correction.at,
      evidenceCorrectionIncidentKey: correction.incidentKey,
      qualityReportReasons: row.exerciseAttempt.exercise.flags.map((flag) => flag.reason),
    };
  });
}

async function findPracticeOnlyHistoryReviews(
  input: GetPracticeHistoryInput & { skillId?: string },
): Promise<PracticeHistoryReview[]> {
  const prisma = getPrisma();
  const resultFilter = input.incorrectOnly
    ? Prisma.sql`ea."result" = ${ExerciseAttemptResult.INCORRECT}::"ExerciseAttemptResult"`
    : Prisma.sql`ea."result" IN (${Prisma.join([
        ExerciseAttemptResult.CORRECT,
        ExerciseAttemptResult.INCORRECT,
      ].map((result) => Prisma.sql`${result}::"ExerciseAttemptResult"`))})`;
  const skillFilter = input.skillId
    ? Prisma.sql`AND ea."skillId" = ${input.skillId}`
    : Prisma.empty;
  const collectionFilter = input.collectionId
    ? Prisma.sql`AND s."collectionId" = ${input.collectionId}`
    : Prisma.empty;
  const cursorFilter = input.cursor
    ? (() => {
        const reviewedAt = new Date(input.cursor.reviewedAt);
        return Prisma.sql`
          AND (
            COALESCE(ea."feedbackShownAt", ea."createdAt") < ${reviewedAt}
            OR (
              COALESCE(ea."feedbackShownAt", ea."createdAt") = ${reviewedAt}
              AND ea."id" > ${input.cursor.id}
            )
          )
        `;
      })()
    : Prisma.empty;
  const ids = await prisma.$queryRaw<Array<{ id: string }>>`
    SELECT ea."id"
    FROM "exercise_attempts" ea
    INNER JOIN "skills" s
      ON s."id" = ea."skillId"
     AND s."userId" = ea."userId"
    INNER JOIN "exercises" e
      ON e."id" = ea."exerciseId"
     AND e."skillId" = ea."skillId"
     AND e."userId" = ea."userId"
    LEFT JOIN "review_logs" rl
      ON rl."exerciseAttemptId" = ea."id"
     AND rl."skillId" = ea."skillId"
     AND rl."userId" = ea."userId"
    WHERE ea."userId" = ${input.userId}
      ${skillFilter}
      ${collectionFilter}
      AND rl."id" IS NULL
      AND (
        ea."ratingPolicyVersion" = 'practice-only-v1'
        OR ea."practiceContext"->>'practiceOnly' = 'true'
        OR ea."practiceContext"->>'sessionMode' = 'PRACTICE_ONLY'
        OR ea."practiceContext"->>'exposure' IN ('PRACTICE_ONLY', 'practice-only')
      )
      AND ${resultFilter}
      AND ea."finalRating" IS NULL
      AND COALESCE(ea."feedbackShownAt", ea."createdAt") <= ${input.now}
      ${cursorFilter}
    ORDER BY COALESCE(ea."feedbackShownAt", ea."createdAt") DESC,
      ea."id" ASC
    LIMIT ${normalizeHistoryLimit(input.limit)}
  `;
  if (ids.length === 0) return [];

  const rows = await prisma.exerciseAttempt.findMany({
    where: {
      userId: input.userId,
      id: { in: ids.map((row) => row.id) },
    },
    select: {
      id: true,
      skillId: true,
      result: true,
      responseMs: true,
      answer: true,
      practiceContext: true,
      evidenceCorrectionStatus: true,
      evidenceCorrectionNote: true,
      evidenceCorrectionAt: true,
      evidenceCorrectionIncidentKey: true,
      feedbackShownAt: true,
      createdAt: true,
      exercise: {
        select: {
          answerKind: true,
          correctAnswerDisplay: true,
          prompt: true,
          choices: true,
          explanation: true,
          flags: {
            where: { userId: input.userId },
            select: { reason: true },
          },
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
  });
  const rowsById = new Map(rows.map((row) => [row.id, row]));

  return ids.flatMap(({ id }) => {
    const row = rowsById.get(id);
    if (!row) return [];
    return [{
      id: row.id,
      skillId: row.skillId,
      skillTitle: row.skill.title,
      skillStatus: row.skill.status,
      collectionName: row.skill.collection?.name ?? null,
      exerciseAttemptId: row.id,
      answerKind: row.exercise.answerKind,
      result: row.result as PracticeHistoryReview["result"],
      responseMs: row.responseMs,
      finalRating: null,
      reviewedAt: row.feedbackShownAt ?? row.createdAt,
      previousDueAt: null,
      nextDueAt: null,
      previousState: null,
      nextState: null,
      correctAnswerDisplay: row.exercise.correctAnswerDisplay,
      prompt: row.exercise.prompt,
      submittedAnswerDisplay: formatSubmittedHistoryAnswer(row.answer, row.exercise.choices),
      explanation: row.exercise.explanation,
      eventKind: "practice-only" as const,
      practiceContext: row.practiceContext,
      evidenceCorrectionStatus: row.evidenceCorrectionStatus,
      evidenceCorrectionNote: row.evidenceCorrectionNote,
      evidenceCorrectionAt: row.evidenceCorrectionAt,
      evidenceCorrectionIncidentKey: row.evidenceCorrectionIncidentKey,
      qualityReportReasons: row.exercise.flags.map((flag) => flag.reason),
    }];
  });
}

function chooseCorrectionAnnotation(input: {
  primary: ExerciseEvidenceCorrectionStatus;
  primaryNote: string | null;
  primaryAt: Date | null;
  primaryIncidentKey: string | null;
  fallback: ExerciseEvidenceCorrectionStatus;
  fallbackNote: string | null;
  fallbackAt: Date | null;
  fallbackIncidentKey: string | null;
}) {
  return input.primary !== ExerciseEvidenceCorrectionStatus.NOT_REQUIRED
    ? {
        status: input.primary,
        note: input.primaryNote,
        at: input.primaryAt,
        incidentKey: input.primaryIncidentKey,
      }
    : {
        status: input.fallback,
        note: input.fallbackNote,
        at: input.fallbackAt,
        incidentKey: input.fallbackIncidentKey,
      };
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
  return {
    reviews,
    nextCursor:
      rows.length > size && last
        ? {
            mode: input.mode ?? "scheduled",
            reviewedAt: last.reviewedAt.toISOString(),
            id: last.id,
          }
        : null,
  };
}
