import "server-only";

import {
  ExerciseAttemptResult,
  ExerciseEvidenceCorrectionStatus,
  ExerciseFlagAdjudicationStatus,
  type AnswerKind,
  type ExerciseFlagReason,
  type Prisma,
} from "@/generated/prisma/client";
import { formatSubmittedHistoryAnswer } from "@/lib/practice/history-answer";
import { getPrisma } from "@/lib/prisma";

const DEFAULT_QUALITY_ISSUE_LIMIT = 50;
const MAX_QUALITY_ISSUE_LIMIT = 50;
const QUALITY_ISSUE_CURSOR_VERSION = 1 as const;
const MAX_CURSOR_LENGTH = 8_000;

export type ExerciseQualityIssueFlag = {
  id: string;
  reason: ExerciseFlagReason;
  note: string | null;
  status: string;
  adjudicationStatus: ExerciseFlagAdjudicationStatus;
  evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus;
  adjudicationCode?: string | null;
  resolutionNote?: string | null;
  resolvedAt?: Date | null;
  adjudicatedAt?: Date | null;
  evidenceCorrectionAction?: string;
  practiceEvidenceNeedsCorrection?: boolean;
  affectedReviewCount?: number;
  correctionStartedAt?: Date | null;
  correctionCompletedAt?: Date | null;
  incidentKey?: string | null;
  replayedReviewCount?: number;
  quarantinedExerciseCount?: number;
  createdAt: Date;
  updatedAt: Date;
};

export type ExerciseQualityIssueAttempt = {
  id: string;
  result: Extract<ExerciseAttemptResult, "CORRECT" | "INCORRECT">;
  submittedAnswerDisplay: string;
  responseMs: number | null;
  completedAt: Date;
  practiceOnly: boolean;
};

export type ExerciseQualityIssue = {
  exerciseId: string;
  skillId: string;
  skillTitle: string;
  collectionName: string | null;
  prompt: string;
  correctAnswerDisplay: string;
  answerKind: AnswerKind;
  issueVersion: Date;
  flags: ExerciseQualityIssueFlag[];
  attempts: ExerciseQualityIssueAttempt[];
  retiredAt?: Date | null;
  retirementReason?: string | null;
};

export type ExerciseQualityIssuePage = {
  issues: ExerciseQualityIssue[];
  nextCursor: string | null;
  snapshotCutoff: Date;
};

type QualityIssueCursor = {
  version: typeof QUALITY_ISSUE_CURSOR_VERSION;
  userId: string;
  includeResolved: boolean;
  snapshotCutoff: string;
  updatedAt: string;
  id: string;
};

export class ExerciseQualityIssueCursorError extends Error {
  constructor(message = "The exercise issue pagination cursor is invalid.") {
    super(message);
    this.name = "ExerciseQualityIssueCursorError";
  }
}

export async function getExerciseQualityIssues(input: {
  userId: string;
  limit?: number;
}): Promise<ExerciseQualityIssue[]> {
  if (!input.userId.trim()) {
    throw new Error("getExerciseQualityIssues requires an owning userId.");
  }

  const rows = await getPrisma().exercise.findMany({
    where: {
      userId: input.userId,
      flags: {
        some: {
          OR: [
            { adjudicationStatus: ExerciseFlagAdjudicationStatus.PENDING },
            {
              evidenceCorrectionStatus: {
                in: [
                  ExerciseEvidenceCorrectionStatus.PENDING,
                  ExerciseEvidenceCorrectionStatus.IN_PROGRESS,
                  ExerciseEvidenceCorrectionStatus.BLOCKED,
                ],
              },
            },
          ],
        },
      },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: normalizeLimit(input.limit),
    select: {
      id: true,
      skillId: true,
      answerKind: true,
      prompt: true,
      choices: true,
      correctAnswerDisplay: true,
      updatedAt: true,
      skill: {
        select: {
          title: true,
          collection: { select: { name: true } },
        },
      },
      flags: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          reason: true,
          note: true,
          status: true,
          adjudicationStatus: true,
          evidenceCorrectionStatus: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      attempts: {
        where: {
          userId: input.userId,
          result: {
            in: [ExerciseAttemptResult.CORRECT, ExerciseAttemptResult.INCORRECT],
          },
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: 3,
        select: {
          id: true,
          result: true,
          answer: true,
          responseMs: true,
          practiceContext: true,
          ratingPolicyVersion: true,
          createdAt: true,
        },
      },
    },
  });

  return rows.map((row) => {
    const issueFlags = row.flags.filter(isVisibleQualityIssueFlag);
    const issueVersion = issueFlags
      .map((flag) => flag.updatedAt)
      .toSorted((left, right) => right.getTime() - left.getTime())[0];

    if (!issueVersion) {
      throw new Error(`Quality issue ${row.id} has no visible report version.`);
    }

    return {
      exerciseId: row.id,
      skillId: row.skillId,
      skillTitle: row.skill.title,
      collectionName: row.skill.collection?.name ?? null,
      prompt: row.prompt,
      correctAnswerDisplay: row.correctAnswerDisplay,
      answerKind: row.answerKind,
      issueVersion,
      flags: issueFlags,
      attempts: row.attempts.map((attempt) => ({
        id: attempt.id,
        result: attempt.result as ExerciseQualityIssueAttempt["result"],
        submittedAnswerDisplay: formatSubmittedHistoryAnswer(attempt.answer, row.choices),
        responseMs: attempt.responseMs,
        completedAt: attempt.createdAt,
        practiceOnly: isPracticeOnlyAttempt(attempt),
      })),
    };
  });
}

/**
 * Return the durable quality-report queue for an agent. The default view is
 * intentionally driven by adjudication/correction state rather than the
 * legacy OPEN/RESOLVED flag status, because reporting retires an exercise and
 * may mark its flags RESOLVED before a human decision is complete.
 */
export async function listExerciseQualityIssues(input: {
  userId: string;
  limit?: number;
  cursor?: string;
  includeResolved?: boolean;
  now?: Date;
}): Promise<ExerciseQualityIssuePage> {
  if (!input.userId.trim()) {
    throw new Error("listExerciseQualityIssues requires an owning userId.");
  }

  const limit = normalizeLimit(input.limit);
  const includeResolved = input.includeResolved === true;
  const now = input.now ?? new Date();
  if (Number.isNaN(now.getTime())) {
    throw new Error("listExerciseQualityIssues requires a valid now Date.");
  }

  const cursor = input.cursor ? decodeQualityIssueCursor(input.cursor) : null;
  if (cursor && (cursor.userId !== input.userId || cursor.includeResolved !== includeResolved)) {
    throw new ExerciseQualityIssueCursorError("The exercise issue cursor does not match these filters.");
  }
  const snapshotCutoff = cursor ? new Date(cursor.snapshotCutoff) : now;
  if (Number.isNaN(snapshotCutoff.getTime())) {
    throw new ExerciseQualityIssueCursorError();
  }

  const rows = await getPrisma().exercise.findMany({
    where: {
      userId: input.userId,
      updatedAt: { lte: snapshotCutoff },
      flags: {
        some: {
          updatedAt: { lte: snapshotCutoff },
          ...(includeResolved ? {} : { OR: visibleQualityIssuePredicate() }),
        },
      },
      ...(cursor
        ? {
            OR: [
              { updatedAt: { lt: new Date(cursor.updatedAt) } },
              { updatedAt: new Date(cursor.updatedAt), id: { gt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    take: limit + 1,
    select: {
      id: true,
      skillId: true,
      answerKind: true,
      prompt: true,
      choices: true,
      correctAnswerDisplay: true,
      retiredAt: true,
      retirementReason: true,
      updatedAt: true,
      skill: {
        select: {
          title: true,
          collection: { select: { name: true } },
        },
      },
      flags: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          reason: true,
          note: true,
          status: true,
          adjudicationStatus: true,
          evidenceCorrectionStatus: true,
          adjudicationCode: true,
          resolutionNote: true,
          resolvedAt: true,
          adjudicatedAt: true,
          evidenceCorrectionAction: true,
          practiceEvidenceNeedsCorrection: true,
          affectedReviewCount: true,
          correctionStartedAt: true,
          correctionCompletedAt: true,
          incidentKey: true,
          replayedReviewCount: true,
          quarantinedExerciseCount: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      attempts: {
        where: {
          userId: input.userId,
          result: { in: [ExerciseAttemptResult.CORRECT, ExerciseAttemptResult.INCORRECT] },
        },
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: 3,
        select: {
          id: true,
          result: true,
          answer: true,
          responseMs: true,
          practiceContext: true,
          ratingPolicyVersion: true,
          createdAt: true,
        },
      },
    },
  });

  const visibleRows: Array<{ row: (typeof rows)[number]; issue: ExerciseQualityIssue }> = [];
  for (const row of rows) {
    const flags = row.flags.filter((flag) =>
      flag.updatedAt <= snapshotCutoff && (includeResolved || isVisibleQualityIssueFlag(flag)),
    );
    if (flags.length === 0) continue;
    const issueVersion = flags
      .map((flag) => flag.updatedAt)
      .toSorted((left, right) => right.getTime() - left.getTime())[0];
    if (!issueVersion) continue;
    const issue: ExerciseQualityIssue = {
      exerciseId: row.id,
      skillId: row.skillId,
      skillTitle: row.skill.title,
      collectionName: row.skill.collection?.name ?? null,
      prompt: row.prompt,
      correctAnswerDisplay: row.correctAnswerDisplay,
      answerKind: row.answerKind,
      issueVersion,
      flags,
      attempts: row.attempts.map((attempt) => ({
        id: attempt.id,
        result: attempt.result as ExerciseQualityIssueAttempt["result"],
        submittedAnswerDisplay: formatSubmittedHistoryAnswer(attempt.answer, row.choices),
        responseMs: attempt.responseMs,
        completedAt: attempt.createdAt,
        practiceOnly: isPracticeOnlyAttempt(attempt),
      })),
      retiredAt: row.retiredAt,
      retirementReason: row.retirementReason,
    };
    visibleRows.push({ row, issue });
  }

  const page = visibleRows.slice(0, limit).map((value) => value.issue);
  const last = visibleRows.at(limit - 1);
  return {
    issues: page,
    snapshotCutoff,
    nextCursor: visibleRows.length > limit && last
      ? encodeQualityIssueCursor({
          version: QUALITY_ISSUE_CURSOR_VERSION,
          userId: input.userId,
          includeResolved,
          snapshotCutoff: snapshotCutoff.toISOString(),
          updatedAt: last.row.updatedAt.toISOString(),
          id: last.row.id,
        })
      : null,
  };
}

export function encodeQualityIssueCursor(cursor: QualityIssueCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeQualityIssueCursor(value: string): QualityIssueCursor {
  if (!value || value.length > MAX_CURSOR_LENGTH) throw new ExerciseQualityIssueCursorError();
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isQualityIssueCursor(parsed)) throw new ExerciseQualityIssueCursorError();
    return parsed;
  } catch (error) {
    if (error instanceof ExerciseQualityIssueCursorError) throw error;
    throw new ExerciseQualityIssueCursorError();
  }
}

function isVisibleQualityIssueFlag(flag: {
  adjudicationStatus: ExerciseFlagAdjudicationStatus;
  evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus;
}) {
  return (
    flag.adjudicationStatus === ExerciseFlagAdjudicationStatus.PENDING ||
    flag.evidenceCorrectionStatus === ExerciseEvidenceCorrectionStatus.PENDING ||
    flag.evidenceCorrectionStatus === ExerciseEvidenceCorrectionStatus.IN_PROGRESS ||
    flag.evidenceCorrectionStatus === ExerciseEvidenceCorrectionStatus.BLOCKED
  );
}

function visibleQualityIssuePredicate(): Prisma.ExerciseFlagWhereInput[] {
  return [
    { adjudicationStatus: ExerciseFlagAdjudicationStatus.PENDING },
    {
      evidenceCorrectionStatus: {
        in: [
          ExerciseEvidenceCorrectionStatus.PENDING,
          ExerciseEvidenceCorrectionStatus.IN_PROGRESS,
          ExerciseEvidenceCorrectionStatus.BLOCKED,
        ],
      },
    },
  ];
}

function isQualityIssueCursor(value: unknown): value is QualityIssueCursor {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const cursor = value as Record<string, unknown>;
  return (
    cursor.version === QUALITY_ISSUE_CURSOR_VERSION &&
    typeof cursor.userId === "string" && cursor.userId.length > 0 &&
    typeof cursor.includeResolved === "boolean" &&
    typeof cursor.snapshotCutoff === "string" && !Number.isNaN(new Date(cursor.snapshotCutoff).getTime()) &&
    typeof cursor.updatedAt === "string" && !Number.isNaN(new Date(cursor.updatedAt).getTime()) &&
    typeof cursor.id === "string" && cursor.id.length > 0
  );
}

function isPracticeOnlyAttempt(attempt: {
  practiceContext: Prisma.JsonValue | null;
  ratingPolicyVersion?: string;
}) {
  if (attempt.ratingPolicyVersion === "practice-only-v1") return true;
  if (!attempt.practiceContext || typeof attempt.practiceContext !== "object" || Array.isArray(attempt.practiceContext)) return false;
  const context = attempt.practiceContext as Record<string, unknown>;
  return context.practiceOnly === true || context.sessionMode === "PRACTICE_ONLY" || context.exposure === "PRACTICE_ONLY" || context.exposure === "practice-only";
}

function normalizeLimit(limit: number | undefined) {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_QUALITY_ISSUE_LIMIT;
  return Math.min(MAX_QUALITY_ISSUE_LIMIT, Math.max(1, Math.trunc(limit)));
}
