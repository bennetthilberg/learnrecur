import "server-only";

import {
  ExerciseAttemptResult,
  Prisma,
  type AnswerKind,
  type ExerciseEvidenceCorrectionStatus,
  type ExerciseFlagAdjudicationStatus,
  type FsrsRating,
  type SkillFsrsState,
  type SkillStatus,
} from "@/generated/prisma/client";
import { choicesSchema, type Choice } from "@/lib/answer-checking";
import { getPrisma } from "@/lib/prisma";
import { practiceContextSchema } from "./policies";
import { formatSubmittedHistoryAnswer } from "./history-answer";
import { readStoredPromptLayout } from "./structured-prompt";
import {
  resolveHistoricalAnswerContract,
  type AcceptedAnswerVariant,
  type AnswerComparisonPolicy,
  type AnswerContract,
  type AnswerContractSource,
} from "./answer-contract";

const DEFAULT_COMPLETED_HISTORY_LIMIT = 20;
const MAX_COMPLETED_HISTORY_LIMIT = 50;
const CURSOR_VERSION = 2 as const;
const MAX_CURSOR_LENGTH = 8_000;
const IDENTIFIER_MAX_LENGTH = 200;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/u;

type CompletedAttemptResult = Extract<
  ExerciseAttemptResult,
  typeof ExerciseAttemptResult.CORRECT | typeof ExerciseAttemptResult.INCORRECT
>;

const completedHistorySelect = {
  id: true,
  skillId: true,
  exerciseId: true,
  ratingPolicyVersion: true,
  practiceContext: true,
  answerPolicySnapshot: true,
  answer: true,
  normalizedAnswer: true,
  isCorrect: true,
  result: true,
  responseMs: true,
  proposedRating: true,
  finalRating: true,
  feedbackShownAt: true,
  createdAt: true,
  reviewLog: {
    select: {
      id: true,
      finalRating: true,
      reviewedAt: true,
      previousDueAt: true,
      nextDueAt: true,
      previousState: true,
      nextState: true,
    },
  },
  exercise: {
    select: {
      id: true,
      type: true,
      answerKind: true,
      prompt: true,
      choices: true,
      answerSpec: true,
      correctAnswerDisplay: true,
      explanation: true,
      generationMetadata: true,
      flags: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          adjudicationStatus: true,
          evidenceCorrectionStatus: true,
          practiceEvidenceNeedsCorrection: true,
          affectedReviewCount: true,
        },
      },
    },
  },
  skill: {
    select: {
      id: true,
      title: true,
      status: true,
      collectionId: true,
      collection: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  },
} satisfies Prisma.ExerciseAttemptSelect;

type CompletedHistoryRow = Prisma.ExerciseAttemptGetPayload<{
  select: typeof completedHistorySelect;
}>;

export type CompletedPracticeHistoryMode = "all" | "scheduled" | "practice-only";
export type CompletedPracticeHistoryResult = "all" | "correct" | "incorrect";
export type CompletedPracticeHistoryModeInput = CompletedPracticeHistoryMode | "practice_only";
export type CompletedPracticeHistoryResultInput =
  | CompletedPracticeHistoryResult
  | "CORRECT"
  | "INCORRECT";

export type HistoryCorrectionStatus = "NONE" | ExerciseEvidenceCorrectionStatus;

export type HistoryCorrectionSummary = {
  status: HistoryCorrectionStatus;
  adjudicationStatus: ExerciseFlagAdjudicationStatus | "NONE";
  evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus;
  evidenceExcluded: boolean;
  flagCount: number;
  affectedReviewCount: number;
  flagged: boolean;
};

export type RecordedPracticeContext = {
  source: "recorded" | "unavailable";
  version: 1 | null;
  answerMode: AnswerKind | null;
  answerModeSource: "recorded" | "exercise-fallback" | "unavailable";
  mixedReview: boolean | null;
  reducedRuleCues: boolean | null;
  assistance: "none" | "observed" | null;
  sessionId: string | null;
  sessionMode: "PRACTICE_ONLY" | "SCHEDULED" | null;
  exposure: "PRACTICE_ONLY" | "SCHEDULED" | null;
};

export type CompletedPracticeHistoryAttempt = {
  id: string;
  exerciseAttemptId: string;
  reviewLogId: string | null;
  exerciseId: string;
  skillId: string;
  skillTitle: string;
  skillStatus: SkillStatus;
  collectionId: string | null;
  collectionName: string | null;
  type: CompletedHistoryRow["exercise"]["type"];
  answerKind: AnswerKind;
  answerMode: AnswerKind;
  answerModeSource: RecordedPracticeContext["answerModeSource"];
  prompt: string;
  instruction: string | null;
  content: string;
  promptLayout: { instruction: string; content: string } | null;
  choices: Choice[] | null;
  result: CompletedAttemptResult;
  isCorrect: boolean;
  responseMs: number | null;
  completedAt: Date;
  createdAt: Date;
  feedbackShownAt: Date | null;
  reviewedAt: Date | null;
  finalRating: FsrsRating | null;
  proposedRating: FsrsRating | null;
  ratingPolicyVersion: string;
  previousDueAt: Date | null;
  nextDueAt: Date | null;
  previousState: SkillFsrsState | null;
  nextState: SkillFsrsState | null;
  submittedAnswer: Prisma.JsonValue;
  submittedAnswerStorage: Prisma.JsonValue;
  normalizedAnswer: string | null;
  submittedAnswerDisplay: string;
  correctAnswerDisplay: string;
  explanation: string | null;
  mode: "SCHEDULED" | "PRACTICE_ONLY";
  submissionType: "scheduled" | "practice-only";
  scheduled: boolean;
  practiceOnly: boolean;
  practiceContext: RecordedPracticeContext;
  mixedReview: boolean | null;
  reducedRuleCues: boolean | null;
  answerContract: AnswerContract | null;
  answerContractSource: AnswerContractSource;
  answerContractSourceLabel: string;
  answerContractFallback: boolean;
  answerContractFallbackReason: "missing" | "invalid" | null;
  comparisonPolicy: AnswerComparisonPolicy | null;
  acceptedVariants: AcceptedAnswerVariant[];
  correction: HistoryCorrectionSummary;
  qualityCorrection: HistoryCorrectionSummary;
  correctionStatus: HistoryCorrectionStatus;
  evidenceExcluded: boolean;
  original: {
    result: CompletedAttemptResult;
    isCorrect: boolean;
    finalRating: FsrsRating | null;
    proposedRating: FsrsRating | null;
  };
};

export type PracticeHistoryReadModelCursor = {
  version: typeof CURSOR_VERSION;
  userId: string;
  skillId: string | null;
  collectionId: string | null;
  result: CompletedPracticeHistoryResult;
  mode: CompletedPracticeHistoryMode;
  snapshotCutoff: string;
  completedAt: string;
  id: string;
};

export type GetCompletedPracticeHistoryInput = {
  userId: string;
  now?: Date;
  limit?: number;
  skillId?: string;
  collectionId?: string;
  result?: CompletedPracticeHistoryResultInput;
  incorrectOnly?: boolean;
  mode?: CompletedPracticeHistoryModeInput;
  submissionType?: CompletedPracticeHistoryModeInput;
  cursor?: string;
};

export type CompletedPracticeHistoryPage = {
  status: "ready";
  attempts: CompletedPracticeHistoryAttempt[];
  nextCursor: string | null;
  snapshotCutoff: Date;
};

export class PracticeHistoryCursorError extends Error {
  constructor(message = "The completed practice history pagination cursor is invalid.") {
    super(message);
    this.name = "PracticeHistoryCursorError";
  }
}

export function encodePracticeHistoryCursor(cursor: PracticeHistoryReadModelCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodePracticeHistoryCursor(value: string): PracticeHistoryReadModelCursor {
  if (!value || value.length > MAX_CURSOR_LENGTH) {
    throw new PracticeHistoryCursorError();
  }

  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);

    if (!isPracticeHistoryCursor(parsed)) {
      throw new PracticeHistoryCursorError();
    }

    return parsed;
  } catch (error) {
    if (error instanceof PracticeHistoryCursorError) {
      throw error;
    }
    throw new PracticeHistoryCursorError();
  }
}

export async function getCompletedPracticeHistoryPage(
  input: GetCompletedPracticeHistoryInput,
): Promise<CompletedPracticeHistoryPage> {
  const now = input.now ?? new Date();
  assertValidDate(now, "getCompletedPracticeHistoryPage");

  const skillId = normalizeOptionalIdentifier(input.skillId);
  const collectionId = normalizeOptionalIdentifier(input.collectionId);
  const result = normalizeResultFilter(input.result, input.incorrectOnly);
  const mode = normalizeMode(input.mode, input.submissionType);
  const limit = normalizeCompletedHistoryLimit(input.limit);
  const cursor = input.cursor ? decodePracticeHistoryCursor(input.cursor) : null;

  if (cursor) {
    assertMatchingCursor(cursor, {
      userId: input.userId,
      skillId,
      collectionId,
      result,
      mode,
    });
  }

  const snapshotCutoff = cursor ? new Date(cursor.snapshotCutoff) : now;
  const ids = await loadCompletedHistoryIds({
    userId: input.userId,
    skillId,
    collectionId,
    result,
    mode,
    snapshotCutoff,
    cursor,
    limit,
  });
  const prisma = getPrisma();
  const rows = ids.length === 0
    ? []
    : await prisma.exerciseAttempt.findMany({
        where: {
          userId: input.userId,
          id: { in: ids },
        },
        select: completedHistorySelect,
      });
  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const orderedRows = ids.flatMap((id) => {
    const row = rowsById.get(id);
    return row ? [row] : [];
  });

  const attempts = orderedRows.slice(0, limit).map(mapCompletedHistoryAttempt);
  const last = attempts.at(-1);
  const nextCursor = orderedRows.length > limit && last
    ? encodePracticeHistoryCursor({
        version: CURSOR_VERSION,
        userId: input.userId,
        skillId,
        collectionId,
        result,
        mode,
        snapshotCutoff: snapshotCutoff.toISOString(),
        completedAt: last.completedAt.toISOString(),
        id: last.id,
      })
    : null;

  return {
    status: "ready",
    attempts,
    nextCursor,
    snapshotCutoff,
  };
}

export const getPracticeHistoryReadModelPage = getCompletedPracticeHistoryPage;
export const getCompletedPracticeHistory = getCompletedPracticeHistoryPage;

export function summarizeHistoryCorrection(
  flags: ReadonlyArray<{
    adjudicationStatus: ExerciseFlagAdjudicationStatus;
    evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus;
    practiceEvidenceNeedsCorrection: boolean;
    affectedReviewCount: number;
  }>,
): HistoryCorrectionSummary {
  if (flags.length === 0) {
    return {
      status: "NONE",
      adjudicationStatus: "NONE",
      evidenceCorrectionStatus: "NOT_REQUIRED",
      evidenceExcluded: false,
      flagCount: 0,
      affectedReviewCount: 0,
      flagged: false,
    };
  }

  const evidenceCorrectionStatus = highestEvidenceCorrectionStatus(
    flags.map((flag) => (
      flag.practiceEvidenceNeedsCorrection && flag.evidenceCorrectionStatus === "NOT_REQUIRED"
        ? "PENDING"
        : flag.evidenceCorrectionStatus
    )),
  );
  const adjudicationStatus = highestAdjudicationStatus(
    flags.map((flag) => flag.adjudicationStatus),
  );

  return {
    status: evidenceCorrectionStatus,
    adjudicationStatus,
    evidenceCorrectionStatus,
    // A report or a pending correction is not evidence that the learner's
    // answer was wrong. Only a confirmed incident excludes the evidence.
    evidenceExcluded: adjudicationStatus === "CONFIRMED",
    flagCount: flags.length,
    affectedReviewCount: Math.max(
      0,
      ...flags.map((flag) => (Number.isFinite(flag.affectedReviewCount) ? flag.affectedReviewCount : 0)),
    ),
    flagged: true,
  };
}

async function loadCompletedHistoryIds(input: {
  userId: string;
  skillId: string | null;
  collectionId: string | null;
  result: CompletedPracticeHistoryResult;
  mode: CompletedPracticeHistoryMode;
  snapshotCutoff: Date;
  cursor: PracticeHistoryReadModelCursor | null;
  limit: number;
}): Promise<string[]> {
  const resultFilter = input.result === "all"
    ? Prisma.sql`ea."result" IN (${Prisma.join([
        ExerciseAttemptResult.CORRECT,
        ExerciseAttemptResult.INCORRECT,
      ].map((result) => Prisma.sql`${result}::"ExerciseAttemptResult"`))})`
    : Prisma.sql`ea."result" = ${(input.result === "correct"
      ? ExerciseAttemptResult.CORRECT
      : ExerciseAttemptResult.INCORRECT)}::"ExerciseAttemptResult"`;
  const skillFilter = input.skillId
    ? Prisma.sql`AND ea."skillId" = ${input.skillId}`
    : Prisma.empty;
  const collectionFilter = input.collectionId
    ? Prisma.sql`AND s."collectionId" = ${input.collectionId}`
    : Prisma.empty;
  const completionFilter = input.mode === "scheduled"
    ? Prisma.sql`
        AND rl."id" IS NOT NULL
        AND rl."reviewedAt" <= ${input.snapshotCutoff}
      `
    : input.mode === "practice-only"
      ? Prisma.sql`
          AND rl."id" IS NULL
          AND ea."finalRating" IS NULL
          AND COALESCE(ea."feedbackShownAt", ea."createdAt") <= ${input.snapshotCutoff}
        `
      : Prisma.sql`
          AND (
            (
              rl."id" IS NOT NULL
              AND rl."reviewedAt" <= ${input.snapshotCutoff}
            )
            OR (
              rl."id" IS NULL
              AND ea."finalRating" IS NULL
              AND COALESCE(ea."feedbackShownAt", ea."createdAt") <= ${input.snapshotCutoff}
            )
          )
        `;
  const cursorFilter = input.cursor
    ? (() => {
        const completedAt = new Date(input.cursor.completedAt);
        return Prisma.sql`
          AND (
            (
              rl."id" IS NOT NULL
              AND (
                rl."reviewedAt" < ${completedAt}
                OR (
                  rl."reviewedAt" = ${completedAt}
                  AND ea."id" > ${input.cursor.id}
                )
              )
            )
            OR (
              rl."id" IS NULL
              AND ea."finalRating" IS NULL
              AND (
                COALESCE(ea."feedbackShownAt", ea."createdAt") < ${completedAt}
                OR (
                  COALESCE(ea."feedbackShownAt", ea."createdAt") = ${completedAt}
                  AND ea."id" > ${input.cursor.id}
                )
              )
            )
          )
        `;
      })()
    : Prisma.empty;

  const rows = await getPrisma().$queryRaw<Array<{ id: string }>>`
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
      AND ${resultFilter}
      ${completionFilter}
      ${cursorFilter}
    ORDER BY COALESCE(rl."reviewedAt", ea."feedbackShownAt", ea."createdAt") DESC,
      ea."id" ASC
    LIMIT ${input.limit + 1}
  `;

  return rows.map((row) => row.id);
}

function mapCompletedHistoryAttempt(row: CompletedHistoryRow): CompletedPracticeHistoryAttempt {
  const choicesResult = choicesSchema.safeParse(row.exercise.choices);
  const choices = choicesResult.success ? choicesResult.data : null;
  const contract = resolveHistoricalAnswerContract({
    savedAnswerPolicySnapshot: row.answerPolicySnapshot,
    exerciseAnswerSpec: row.exercise.answerSpec,
    choices,
  });
  const promptLayout = readStoredPromptLayout(row.exercise.prompt, row.exercise.generationMetadata);
  const parsedContext = practiceContextSchema.safeParse(row.practiceContext);
  const context = parsedContext.success ? parsedContext.data : null;
  const scheduled = row.reviewLog !== null;
  const mode = scheduled ? "SCHEDULED" : "PRACTICE_ONLY";
  const result = row.result as CompletedAttemptResult;
  const submittedAnswerStorage = cloneJsonValue(row.answer);
  const submittedAnswer = cloneJsonValue(unwrapStoredAnswer(row.answer));
  const correction = summarizeHistoryCorrection(row.exercise.flags);
  const answerMode = context?.answerMode ?? row.exercise.answerKind;
  const answerModeSource = context ? "recorded" : "exercise-fallback";
  const practiceContext: RecordedPracticeContext = {
    source: context ? "recorded" : "unavailable",
    version: context?.version ?? null,
    answerMode: context?.answerMode ?? null,
    answerModeSource,
    mixedReview: context?.mixedReview ?? null,
    reducedRuleCues: context?.reducedRuleCues ?? null,
    assistance: context?.assistance ?? null,
    sessionId: context?.sessionId ?? null,
    sessionMode: context?.sessionMode ?? null,
    exposure: context?.exposure ?? null,
  };

  return {
    id: row.id,
    exerciseAttemptId: row.id,
    reviewLogId: row.reviewLog?.id ?? null,
    exerciseId: row.exerciseId,
    skillId: row.skillId,
    skillTitle: row.skill.title,
    skillStatus: row.skill.status,
    collectionId: row.skill.collectionId,
    collectionName: row.skill.collection?.name ?? null,
    type: row.exercise.type,
    answerKind: row.exercise.answerKind,
    answerMode,
    answerModeSource,
    prompt: row.exercise.prompt,
    instruction: promptLayout?.instruction ?? null,
    content: promptLayout?.content ?? row.exercise.prompt,
    promptLayout,
    choices,
    result,
    isCorrect: row.isCorrect,
    responseMs: row.responseMs,
    completedAt: getCompletionTimestamp(row),
    createdAt: row.createdAt,
    feedbackShownAt: row.feedbackShownAt,
    reviewedAt: row.reviewLog?.reviewedAt ?? null,
    finalRating: row.reviewLog?.finalRating ?? row.finalRating,
    proposedRating: row.proposedRating,
    ratingPolicyVersion: row.ratingPolicyVersion,
    previousDueAt: row.reviewLog?.previousDueAt ?? null,
    nextDueAt: row.reviewLog?.nextDueAt ?? null,
    previousState: row.reviewLog?.previousState ?? null,
    nextState: row.reviewLog?.nextState ?? null,
    submittedAnswer,
    submittedAnswerStorage,
    normalizedAnswer: row.normalizedAnswer,
    submittedAnswerDisplay: formatSubmittedHistoryAnswer(row.answer, row.exercise.choices),
    correctAnswerDisplay: formatHistoricalCorrectAnswerDisplay(
      contract.contract,
      row.exercise.correctAnswerDisplay,
    ),
    explanation: row.exercise.explanation,
    mode,
    submissionType: scheduled ? "scheduled" : "practice-only",
    scheduled,
    practiceOnly: !scheduled,
    practiceContext,
    mixedReview: context?.mixedReview ?? null,
    reducedRuleCues: context?.reducedRuleCues ?? null,
    answerContract: contract.contract,
    answerContractSource: contract.source,
    answerContractSourceLabel: contract.sourceLabel,
    answerContractFallback: contract.source === "exercise-fallback",
    answerContractFallbackReason: contract.fallbackReason,
    comparisonPolicy: contract.contract?.comparisonPolicy ?? null,
    acceptedVariants: contract.contract?.acceptedVariants ?? [],
    correction,
    qualityCorrection: correction,
    correctionStatus: correction.status,
    evidenceExcluded: correction.evidenceExcluded,
    original: {
      result,
      isCorrect: row.isCorrect,
      finalRating: row.reviewLog?.finalRating ?? row.finalRating,
      proposedRating: row.proposedRating,
    },
  };
}

function getCompletionTimestamp(row: CompletedHistoryRow): Date {
  return row.reviewLog?.reviewedAt ?? row.feedbackShownAt ?? row.createdAt;
}

function formatHistoricalCorrectAnswerDisplay(
  contract: AnswerContract | null,
  fallback: string,
): string {
  const variant = contract?.acceptedVariants[0];
  if (!variant) {
    return fallback;
  }

  switch (variant.kind) {
    case "choice":
      return variant.display;
    case "text":
      return variant.value;
    case "numeric":
      return typeof variant.value === "string" || typeof variant.value === "number"
        ? String(variant.value)
        : fallback;
    case "math":
      return variant.expression;
  }
}

function unwrapStoredAnswer(value: Prisma.JsonValue): Prisma.JsonValue {
  if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, "raw")) {
    return value.raw as Prisma.JsonValue;
  }
  return value;
}

function cloneJsonValue(value: Prisma.JsonValue): Prisma.JsonValue {
  if (Array.isArray(value)) {
    return value.map(cloneJsonValue) as Prisma.JsonArray;
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child as Prisma.JsonValue)]),
    ) as Prisma.JsonObject;
  }
  return value;
}

function normalizeMode(
  mode: CompletedPracticeHistoryModeInput | undefined,
  submissionType: CompletedPracticeHistoryModeInput | undefined,
): CompletedPracticeHistoryMode {
  const normalizedMode = canonicalizeMode(mode);
  const normalizedSubmissionType = canonicalizeMode(submissionType);
  if (normalizedMode && normalizedSubmissionType && normalizedMode !== normalizedSubmissionType) {
    throw new Error("getCompletedPracticeHistoryPage received conflicting mode filters.");
  }
  return normalizedMode ?? normalizedSubmissionType ?? "all";
}

function canonicalizeMode(
  value: CompletedPracticeHistoryModeInput | undefined,
): CompletedPracticeHistoryMode | null {
  if (value === undefined) {
    return null;
  }
  if (value === "practice_only") {
    return "practice-only";
  }
  if (value === "all" || value === "scheduled" || value === "practice-only") {
    return value;
  }
  throw new Error("getCompletedPracticeHistoryPage received an invalid mode filter.");
}

function normalizeResultFilter(
  result: CompletedPracticeHistoryResultInput | undefined,
  incorrectOnly: boolean | undefined,
): CompletedPracticeHistoryResult {
  if (incorrectOnly && result && result !== "incorrect" && result !== "INCORRECT") {
    throw new Error("getCompletedPracticeHistoryPage received conflicting result filters.");
  }
  if (incorrectOnly || result === "incorrect" || result === "INCORRECT") {
    return "incorrect";
  }
  if (result === "correct" || result === "CORRECT") {
    return "correct";
  }
  if (result === undefined || result === "all") {
    return "all";
  }
  throw new Error("getCompletedPracticeHistoryPage received an invalid result filter.");
}

function normalizeCompletedHistoryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_COMPLETED_HISTORY_LIMIT;
  }
  return Math.min(MAX_COMPLETED_HISTORY_LIMIT, Math.max(1, Math.trunc(limit)));
}

function normalizeOptionalIdentifier(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > IDENTIFIER_MAX_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(normalized)
  ) {
    throw new Error("getCompletedPracticeHistoryPage received an invalid identifier filter.");
  }
  return normalized;
}

function assertValidDate(value: Date, caller: string) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new Error(`${caller} requires a valid now Date.`);
  }
}

function assertMatchingCursor(
  cursor: PracticeHistoryReadModelCursor,
  expected: Pick<PracticeHistoryReadModelCursor, "userId" | "skillId" | "collectionId" | "result" | "mode">,
) {
  if (
    cursor.userId !== expected.userId ||
    cursor.skillId !== expected.skillId ||
    cursor.collectionId !== expected.collectionId ||
    cursor.result !== expected.result ||
    cursor.mode !== expected.mode
  ) {
    throw new PracticeHistoryCursorError("The completed practice history cursor does not match these filters.");
  }
}

function isPracticeHistoryCursor(value: unknown): value is PracticeHistoryReadModelCursor {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.version === CURSOR_VERSION &&
    isNonEmptyString(value.userId) &&
    (value.skillId === null || isNonEmptyString(value.skillId)) &&
    (value.collectionId === null || isNonEmptyString(value.collectionId)) &&
    (value.result === "all" || value.result === "correct" || value.result === "incorrect") &&
    (value.mode === "all" || value.mode === "scheduled" || value.mode === "practice-only") &&
    isValidIsoDate(value.snapshotCutoff) &&
    isValidIsoDate(value.completedAt) &&
    isNonEmptyString(value.id)
  );
}

function isValidIsoDate(value: unknown): value is string {
  return isNonEmptyString(value) && !Number.isNaN(new Date(value).getTime());
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CURSOR_LENGTH;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function highestEvidenceCorrectionStatus(
  statuses: readonly ExerciseEvidenceCorrectionStatus[],
): ExerciseEvidenceCorrectionStatus {
  const priority: ExerciseEvidenceCorrectionStatus[] = [
    "NOT_REQUIRED",
    "COMPLETE",
    "PENDING",
    "IN_PROGRESS",
    "BLOCKED",
  ];
  return statuses.reduce(
    (highest, status) => (priority.indexOf(status) > priority.indexOf(highest) ? status : highest),
    "NOT_REQUIRED",
  );
}

function highestAdjudicationStatus(
  statuses: readonly ExerciseFlagAdjudicationStatus[],
): ExerciseFlagAdjudicationStatus {
  const priority: ExerciseFlagAdjudicationStatus[] = [
    "REJECTED",
    "INCONCLUSIVE",
    "PENDING",
    "CONFIRMED",
  ];
  return statuses.reduce(
    (highest, status) => (priority.indexOf(status) > priority.indexOf(highest) ? status : highest),
    "REJECTED",
  );
}
