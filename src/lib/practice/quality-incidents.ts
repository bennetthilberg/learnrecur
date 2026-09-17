import "server-only";

import { createHash } from "node:crypto";

import {
  ExerciseEvidenceCorrectionAction,
  ExerciseEvidenceCorrectionStatus,
  ExerciseFlagAdjudicationStatus,
  ExerciseFlagStatus,
  ExerciseRetirementReason,
  type FsrsRating,
  type Prisma,
} from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import { createInitialSkillSchedule, type SkillScheduleFields } from "@/lib/scheduling";
import {
  buildScheduleReplayPlan,
  replayIndependentScheduleEvidence,
  type PracticeEvidenceKind,
} from "@/lib/scheduling/replay";

export type ExerciseIncidentAdjudication = "confirmed" | "rejected" | "inconclusive";

export type ExerciseIncidentResult =
  | { status: "not-found" }
  | {
      status: "adjudicated";
      adjudication: ExerciseIncidentAdjudication;
      affectedAttemptCount: number;
      affectedReviewCount: number;
      practiceOnlyAttemptCount: number;
      replayedReviewCount: number;
      quarantinedExerciseCount: number;
      idempotent: boolean;
      incidentKey: string | null;
    };

export type ExerciseQualityIncidentErrorCode =
  | "already-confirmed"
  | "idempotency-conflict"
  | "stale";

export class ExerciseQualityIncidentError extends Error {
  readonly code: ExerciseQualityIncidentErrorCode;

  constructor(code: ExerciseQualityIncidentErrorCode, message: string) {
    super(message);
    this.name = "ExerciseQualityIncidentError";
    this.code = code;
  }
}

export async function lockExerciseForQualityMutation(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  userId: string,
  exerciseId: string,
): Promise<boolean> {
  const lockedExercises = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "exercises"
    WHERE "id" = ${exerciseId} AND "userId" = ${userId}
    FOR UPDATE
  `;
  return lockedExercises.length === 1;
}

async function lockExerciseFamilyForQualityMutation(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  exercise: {
    id: string;
    userId: string;
    skillId: string;
    exerciseFamily: string;
    qualityVersion: string;
    generatorReleaseId: string;
  },
): Promise<boolean> {
  const lockedExercises = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "exercises"
    WHERE "userId" = ${exercise.userId}
      AND "skillId" = ${exercise.skillId}
      AND "exerciseFamily" = ${exercise.exerciseFamily}
      AND "qualityVersion" = ${exercise.qualityVersion}
      AND "generatorReleaseId" = ${exercise.generatorReleaseId}
    ORDER BY "id"
    FOR UPDATE
  `;
  return lockedExercises.some((locked) => locked.id === exercise.id);
}

async function lockSkillForQualityReplay(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  userId: string,
  skillId: string,
): Promise<boolean> {
  const lockedSkills = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "skills"
    WHERE "id" = ${skillId} AND "userId" = ${userId}
    FOR UPDATE
  `;
  return lockedSkills.length === 1;
}

async function lockUserForQualityMutation(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  userId: string,
): Promise<boolean> {
  const lockedUsers = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "users"
    WHERE "id" = ${userId}
    FOR NO KEY UPDATE
  `;
  return lockedUsers.length === 1;
}

type QualityFlag = {
  id: string;
  exerciseId: string;
  adjudicationStatus: ExerciseFlagAdjudicationStatus;
  adjudicationCode: string | null;
  incidentKey: string | null;
  updatedAt: Date;
  affectedReviewCount: number;
  replayedReviewCount: number;
  quarantinedExerciseCount: number;
};

type ConfirmedExercise = {
  exerciseId: string;
  adjudicationCode: string;
  incidentKey: string;
  exercise: {
    generatorReleaseId: string | null;
    exerciseFamily: string | null;
    qualityVersion: string | null;
  };
};

/**
 * Resolve a report while retaining every attempt and review log. A confirmed
 * incident rebuilds the owning skill from the union of all confirmed-defect
 * exercises for that skill, so resolving incidents in a different order cannot
 * reintroduce bad evidence.
 */
export async function adjudicateExerciseQualityIncident(input: {
  userId: string;
  exerciseId: string;
  adjudication: ExerciseIncidentAdjudication;
  adjudicationCode: string;
  now: Date;
  expectedUpdatedAt?: Date | string | null;
  idempotencyKey?: string | null;
  quarantineRelated?: boolean;
  transaction?: Prisma.TransactionClient;
}): Promise<ExerciseIncidentResult> {
  assertValidDate(input.now, "Incident adjudication requires a valid now Date.");

  const resolutionReason = input.adjudicationCode.trim().slice(0, 500);
  if (!resolutionReason) {
    throw new Error("Incident adjudication requires a reason code.");
  }

  const expectedUpdatedAt = normalizeOptionalDate(input.expectedUpdatedAt);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
  const adjudicationCode = resolutionReason.slice(0, 80);
  const payloadHash = hashResolutionPayload({
    adjudication: input.adjudication,
    exerciseId: input.exerciseId,
    quarantineRelated: input.quarantineRelated === true,
    resolutionReason,
  });

  const resolve = async (tx: Prisma.TransactionClient): Promise<ExerciseIncidentResult> => {
    // Practice commits take this lock before reading or writing a skill. Using
    // the same order makes a resolution and a concurrent review serialize.
    if (!await lockUserForQualityMutation(tx, input.userId)) {
      return { status: "not-found" };
    }

    if (idempotencyKey) {
      const prior = await tx.exerciseFlag.findFirst({
        where: {
          userId: input.userId,
          resolutionIdempotencyKey: idempotencyKey,
        },
        orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
        select: {
          exerciseId: true,
          adjudicationStatus: true,
          incidentKey: true,
          affectedAttemptCount: true,
          affectedReviewCount: true,
          practiceOnlyAttemptCount: true,
          replayedReviewCount: true,
          quarantinedExerciseCount: true,
          resolutionPayloadHash: true,
          updatedAt: true,
        },
      });

      if (prior) {
        if (prior.exerciseId !== input.exerciseId || prior.resolutionPayloadHash !== payloadHash) {
          throw new ExerciseQualityIncidentError(
            "idempotency-conflict",
            "This resolution key was already used for a different quality decision.",
          );
        }

        return {
          status: "adjudicated",
          adjudication: fromAdjudicationStatus(prior.adjudicationStatus),
          affectedAttemptCount: prior.affectedAttemptCount,
          affectedReviewCount: prior.affectedReviewCount,
          practiceOnlyAttemptCount: prior.practiceOnlyAttemptCount,
          replayedReviewCount: prior.replayedReviewCount,
          quarantinedExerciseCount: prior.quarantinedExerciseCount,
          idempotent: true,
          incidentKey: prior.incidentKey,
        };
      }
    }

    const exercise = await tx.exercise.findFirst({
      where: { id: input.exerciseId, userId: input.userId },
      select: {
        id: true,
        userId: true,
        skillId: true,
        exerciseFamily: true,
        qualityVersion: true,
        generatorReleaseId: true,
        retiredAt: true,
        retirementReason: true,
        skill: { select: { createdAt: true } },
      },
    });
    if (!exercise) return { status: "not-found" };

    if (
      input.adjudication === "confirmed" &&
      !await lockSkillForQualityReplay(tx, input.userId, exercise.skillId)
    ) {
      return { status: "not-found" };
    }

    const lockRelated =
      input.adjudication === "confirmed" &&
      input.quarantineRelated === true &&
      exercise.exerciseFamily &&
      exercise.qualityVersion &&
      exercise.generatorReleaseId;
    const locked = lockRelated
      ? await lockExerciseFamilyForQualityMutation(tx, {
          id: exercise.id,
          userId: exercise.userId,
          skillId: exercise.skillId,
          exerciseFamily: exercise.exerciseFamily!,
          qualityVersion: exercise.qualityVersion!,
          generatorReleaseId: exercise.generatorReleaseId!,
        })
      : await lockExerciseForQualityMutation(tx, input.userId, input.exerciseId);
    if (!locked) return { status: "not-found" };

    const flags = await tx.exerciseFlag.findMany({
      where: { exerciseId: exercise.id, userId: input.userId },
      select: {
        id: true,
        exerciseId: true,
        adjudicationStatus: true,
        adjudicationCode: true,
        incidentKey: true,
        updatedAt: true,
        affectedReviewCount: true,
        replayedReviewCount: true,
        quarantinedExerciseCount: true,
      },
    });
    if (flags.length === 0) return { status: "not-found" };

    assertFreshResolution(flags, expectedUpdatedAt);

    if (input.adjudication !== "confirmed") {
      if (flags.some((flag) => flag.adjudicationStatus === ExerciseFlagAdjudicationStatus.CONFIRMED)) {
        throw new ExerciseQualityIncidentError(
          "already-confirmed",
          "A confirmed quality incident cannot be reversed without restoring its scheduling evidence.",
        );
      }

      const retirement = await ensureExerciseRetired(tx, exercise, input.now);

      await tx.exerciseFlag.updateMany({
        where: { exerciseId: exercise.id, userId: input.userId },
        data: {
          adjudicationStatus: input.adjudication === "rejected"
            ? ExerciseFlagAdjudicationStatus.REJECTED
            : ExerciseFlagAdjudicationStatus.INCONCLUSIVE,
          status: ExerciseFlagStatus.RESOLVED,
          resolvedAt: input.now,
          adjudicatedAt: input.now,
          adjudicationCode,
          resolutionNote: formatResolutionNote(input.adjudication, resolutionReason),
          retiredExerciseAt: retirement.retiredAt,
          retirementReason: retirement.retirementReason,
          evidenceCorrectionAction: ExerciseEvidenceCorrectionAction.NONE,
          evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus.NOT_REQUIRED,
          practiceEvidenceNeedsCorrection: false,
          affectedAttemptCount: 0,
          affectedReviewCount: 0,
          practiceOnlyAttemptCount: 0,
          replayedReviewCount: 0,
          quarantinedExerciseCount: 0,
          correctionStartedAt: null,
          correctionCompletedAt: input.now,
          incidentKey: null,
          resolutionIdempotencyKey: idempotencyKey,
          resolutionPayloadHash: idempotencyKey ? payloadHash : null,
          updatedAt: input.now,
        },
      });

      return {
        status: "adjudicated",
        adjudication: input.adjudication,
        affectedAttemptCount: 0,
        affectedReviewCount: 0,
        practiceOnlyAttemptCount: 0,
        replayedReviewCount: 0,
        quarantinedExerciseCount: 0,
        idempotent: false,
        incidentKey: null,
      };
    }

    if (flags.some((flag) => flag.adjudicationStatus === ExerciseFlagAdjudicationStatus.CONFIRMED)) {
      throw new ExerciseQualityIncidentError(
        "already-confirmed",
        "This quality incident is already confirmed and its schedule correction has been applied.",
      );
    }

    const incidentKey = buildIncidentKey(exercise, adjudicationCode);
    const confirmedExercises = await loadConfirmedExercisesForSkill(tx, {
      userId: input.userId,
      skillId: exercise.skillId,
    });
    confirmedExercises.push({
      exerciseId: exercise.id,
      adjudicationCode,
      incidentKey,
      exercise: {
        generatorReleaseId: exercise.generatorReleaseId,
        exerciseFamily: exercise.exerciseFamily,
        qualityVersion: exercise.qualityVersion,
      },
    });

    const confirmedByExercise = new Map<string, ConfirmedExercise>();
    for (const confirmed of confirmedExercises) {
      if (!confirmedByExercise.has(confirmed.exerciseId)) {
        confirmedByExercise.set(confirmed.exerciseId, confirmed);
      }
    }
    const confirmedExerciseIds = [...confirmedByExercise.keys()];

    const reviews = await tx.reviewLog.findMany({
      where: { skillId: exercise.skillId, userId: input.userId },
      orderBy: [{ reviewedAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        exerciseAttemptId: true,
        finalRating: true,
        reviewedAt: true,
        previousDueAt: true,
        previousStability: true,
        previousDifficulty: true,
        previousElapsedDays: true,
        previousScheduledDays: true,
        previousLearningSteps: true,
        previousRepetitions: true,
        previousLapses: true,
        previousState: true,
        desiredRetention: true,
        evidenceCorrectionStatus: true,
        exerciseAttempt: {
          select: {
            exerciseId: true,
            practiceContext: true,
            ratingPolicyVersion: true,
            evidenceCorrectionStatus: true,
          },
        },
      },
    });

    const invalidAttemptIds = new Set(
      reviews
        .filter((review) =>
          confirmedByExercise.has(review.exerciseAttempt.exerciseId) ||
          review.evidenceCorrectionStatus !== ExerciseEvidenceCorrectionStatus.NOT_REQUIRED ||
          review.exerciseAttempt.evidenceCorrectionStatus !== ExerciseEvidenceCorrectionStatus.NOT_REQUIRED,
        )
        .map((review) => review.exerciseAttemptId),
    );
    const plannedReviews = buildScheduleReplayPlan({
      reviews: reviews.map((review) => ({
        reviewId: review.id,
        attemptId: review.exerciseAttemptId,
        reviewedAt: review.reviewedAt,
        rating: review.finalRating as FsrsRating,
        evidenceKind: classifyPracticeEvidence({
          practiceContext: review.exerciseAttempt.practiceContext,
          ratingPolicyVersion: review.exerciseAttempt.ratingPolicyVersion,
          reviewCorrectionStatus: review.evidenceCorrectionStatus,
          attemptCorrectionStatus: review.exerciseAttempt.evidenceCorrectionStatus,
        }),
        desiredRetention: review.desiredRetention,
      })),
      invalidAttemptIds,
    });
    const hasIndependentReview = plannedReviews.some(
      (review) => review.evidenceKind === "independent",
    );
    const firstIndependentReviewId = plannedReviews.find(
      (review) => review.evidenceKind === "independent",
    )?.reviewId;
    const firstIndependentReview = firstIndependentReviewId
      ? reviews.find((review) => review.id === firstIndependentReviewId) ?? null
      : null;
    const initial = hasIndependentReview
      ? initialSchedule(firstIndependentReview, exercise.skill.createdAt)
      : createInitialSkillSchedule(input.now);
    const replay = replayIndependentScheduleEvidence({
      initial,
      reviews: plannedReviews,
    });

    const affectedAttempts = await tx.exerciseAttempt.findMany({
      where: {
        userId: input.userId,
        skillId: exercise.skillId,
        exerciseId: { in: confirmedExerciseIds },
      },
      select: {
        id: true,
        exerciseId: true,
        practiceContext: true,
        ratingPolicyVersion: true,
      },
    });
    const affectedReviewCount = reviews.filter((review) =>
      confirmedByExercise.has(review.exerciseAttempt.exerciseId),
    ).length;
    const practiceOnlyAttemptCount = affectedAttempts.filter((attempt) =>
      isPracticeOnlyAttempt(attempt),
    ).length;

    for (const [exerciseId, confirmed] of confirmedByExercise) {
      const correctionNote = buildCorrectionNote(confirmed.adjudicationCode);
      await tx.exerciseAttempt.updateMany({
        where: {
          userId: input.userId,
          skillId: exercise.skillId,
          exerciseId,
          evidenceCorrectionStatus: { not: ExerciseEvidenceCorrectionStatus.COMPLETE },
        },
        data: {
          evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus.COMPLETE,
          evidenceCorrectionNote: correctionNote,
          evidenceCorrectionAt: input.now,
          evidenceCorrectionIncidentKey: confirmed.incidentKey,
        },
      });
      await tx.reviewLog.updateMany({
        where: {
          userId: input.userId,
          skillId: exercise.skillId,
          exerciseAttempt: { exerciseId },
          evidenceCorrectionStatus: { not: ExerciseEvidenceCorrectionStatus.COMPLETE },
        },
        data: {
          evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus.COMPLETE,
          evidenceCorrectionNote: correctionNote,
          evidenceCorrectionAt: input.now,
          evidenceCorrectionIncidentKey: confirmed.incidentKey,
        },
      });
    }

    await tx.skill.update({
      where: { id: exercise.skillId },
      data: replay.schedule,
    });

    let quarantinedExerciseCount = 0;
    if (input.quarantineRelated === true && exercise.exerciseFamily && exercise.qualityVersion && exercise.generatorReleaseId) {
      const quarantine = await tx.exercise.updateMany({
        where: {
          userId: input.userId,
          skillId: exercise.skillId,
          exerciseFamily: exercise.exerciseFamily,
          qualityVersion: exercise.qualityVersion,
          generatorReleaseId: exercise.generatorReleaseId,
          retiredAt: null,
        },
        data: { retiredAt: input.now, retirementReason: ExerciseRetirementReason.OTHER },
      });
      quarantinedExerciseCount = quarantine.count;
    }

    // A directly-created pending flag may not have gone through the practice
    // report path. Confirming it still retires the defective exercise.
    const retirement = await ensureExerciseRetired(tx, exercise, input.now);

    const evidenceCorrectionAction = affectedReviewCount > 0
      ? ExerciseEvidenceCorrectionAction.INVALIDATE_AND_REPLAY
      : affectedAttempts.length > 0
        ? ExerciseEvidenceCorrectionAction.INVALIDATE
        : ExerciseEvidenceCorrectionAction.NONE;
    await tx.exerciseFlag.updateMany({
      where: { exerciseId: exercise.id, userId: input.userId },
      data: {
        adjudicationStatus: ExerciseFlagAdjudicationStatus.CONFIRMED,
        status: ExerciseFlagStatus.RESOLVED,
        resolvedAt: input.now,
        adjudicatedAt: input.now,
        adjudicationCode,
        resolutionNote: formatResolutionNote(input.adjudication, resolutionReason),
        retiredExerciseAt: retirement.retiredAt,
        retirementReason: retirement.retirementReason,
        evidenceCorrectionAction,
        evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus.COMPLETE,
        practiceEvidenceNeedsCorrection: false,
        affectedAttemptCount: affectedAttempts.length,
        affectedReviewCount,
        practiceOnlyAttemptCount,
        replayedReviewCount: replay.appliedReviewIds.length,
        quarantinedExerciseCount,
        correctionStartedAt: input.now,
        correctionCompletedAt: input.now,
        incidentKey,
        resolutionIdempotencyKey: idempotencyKey,
        resolutionPayloadHash: idempotencyKey ? payloadHash : null,
        updatedAt: input.now,
      },
    });

    return {
      status: "adjudicated",
      adjudication: input.adjudication,
      affectedAttemptCount: affectedAttempts.length,
      affectedReviewCount,
      practiceOnlyAttemptCount,
      replayedReviewCount: replay.appliedReviewIds.length,
      quarantinedExerciseCount,
      idempotent: false,
      incidentKey,
    };
  };

  return input.transaction
    ? resolve(input.transaction)
    : getPrisma().$transaction(resolve);
}

async function ensureExerciseRetired(
  tx: Prisma.TransactionClient,
  exercise: {
    id: string;
    retiredAt: Date | null;
    retirementReason: ExerciseRetirementReason | null;
  },
  now: Date,
): Promise<{ retiredAt: Date; retirementReason: ExerciseRetirementReason }> {
  const retiredAt = exercise.retiredAt ?? now;
  const retirementReason = exercise.retirementReason ?? ExerciseRetirementReason.OTHER;

  if (!exercise.retiredAt) {
    await tx.exercise.update({
      where: { id: exercise.id },
      data: { retiredAt, retirementReason },
    });
  }

  return { retiredAt, retirementReason };
}

async function loadConfirmedExercisesForSkill(
  tx: Prisma.TransactionClient,
  input: { userId: string; skillId: string },
): Promise<ConfirmedExercise[]> {
  const flags = await tx.exerciseFlag.findMany({
    where: {
      userId: input.userId,
      adjudicationStatus: ExerciseFlagAdjudicationStatus.CONFIRMED,
      exercise: { userId: input.userId, skillId: input.skillId },
    },
    orderBy: [{ adjudicatedAt: "asc" }, { id: "asc" }],
    select: {
      exerciseId: true,
      adjudicationCode: true,
      incidentKey: true,
      exercise: {
        select: {
          generatorReleaseId: true,
          exerciseFamily: true,
          qualityVersion: true,
        },
      },
    },
  });

  return flags.map((flag) => ({
    exerciseId: flag.exerciseId,
    adjudicationCode: flag.adjudicationCode ?? "confirmed quality incident",
    incidentKey: flag.incidentKey ?? `confirmed:${flag.exerciseId}`,
    exercise: flag.exercise,
  }));
}

function assertFreshResolution(
  flags: readonly Pick<QualityFlag, "updatedAt">[],
  expectedUpdatedAt: Date | null,
) {
  if (!expectedUpdatedAt) return;

  const currentUpdatedAt = flags
    .map((flag) => flag.updatedAt)
    .toSorted((left, right) => right.getTime() - left.getTime())[0];
  if (!currentUpdatedAt || currentUpdatedAt.getTime() !== expectedUpdatedAt.getTime()) {
    throw new ExerciseQualityIncidentError(
      "stale",
      "This quality report changed before the decision was saved. Refresh the report and try again.",
    );
  }
}

function classifyPracticeEvidence(input: {
  practiceContext: Prisma.JsonValue | null;
  ratingPolicyVersion: string;
  reviewCorrectionStatus: ExerciseEvidenceCorrectionStatus;
  attemptCorrectionStatus: ExerciseEvidenceCorrectionStatus;
}): PracticeEvidenceKind {
  if (
    input.reviewCorrectionStatus !== ExerciseEvidenceCorrectionStatus.NOT_REQUIRED ||
    input.attemptCorrectionStatus !== ExerciseEvidenceCorrectionStatus.NOT_REQUIRED
  ) {
    return "invalidated";
  }
  if (isPracticeOnlyAttempt(input)) {
    return "practice-only";
  }
  if (contextValue(input.practiceContext, "assistance") === "observed") {
    return "assisted";
  }
  return "independent";
}

function isPracticeOnlyAttempt(input: {
  practiceContext: Prisma.JsonValue | null;
  ratingPolicyVersion?: string;
}): boolean {
  return input.ratingPolicyVersion === "practice-only-v1" || isPracticeOnlyContext(input.practiceContext);
}

function isPracticeOnlyContext(context: Prisma.JsonValue | null): boolean {
  return (
    contextValue(context, "practiceOnly") === true ||
    contextValue(context, "sessionMode") === "PRACTICE_ONLY" ||
    contextValue(context, "exposure") === "PRACTICE_ONLY" ||
    contextValue(context, "exposure") === "practice-only"
  );
}

function contextValue(context: Prisma.JsonValue | null, key: string): unknown {
  if (!context || typeof context !== "object" || Array.isArray(context)) return undefined;
  return (context as Record<string, unknown>)[key];
}

function initialSchedule(
  review: {
    reviewedAt: Date;
    previousDueAt: Date | null;
    previousStability: number | null;
    previousDifficulty: number | null;
    previousElapsedDays: number | null;
    previousScheduledDays: number | null;
    previousLearningSteps: number | null;
    previousRepetitions: number | null;
    previousLapses: number | null;
    previousState: SkillScheduleFields["fsrsState"] | null;
  } | null,
  createdAt: Date,
): SkillScheduleFields {
  if (
    review?.previousDueAt &&
    review.previousStability !== null &&
    review.previousDifficulty !== null &&
    review.previousElapsedDays !== null &&
    review.previousScheduledDays !== null &&
    review.previousLearningSteps !== null &&
    review.previousRepetitions !== null &&
    review.previousLapses !== null &&
    review.previousState !== null
  ) {
    return {
      dueAt: review.previousDueAt,
      stability: review.previousStability,
      difficulty: review.previousDifficulty,
      elapsedDays: review.previousElapsedDays,
      scheduledDays: review.previousScheduledDays,
      learningSteps: review.previousLearningSteps,
      repetitions: review.previousRepetitions,
      lapses: review.previousLapses,
      fsrsState: review.previousState,
      lastReviewedAt: null,
    };
  }
  return createInitialSkillSchedule(review?.reviewedAt ?? createdAt);
}

function buildCorrectionNote(adjudicationCode: string): string {
  return `Retained historical evidence. Excluded from FSRS schedule replay because this exercise was confirmed defective: ${adjudicationCode}.`;
}

function formatResolutionNote(
  adjudication: ExerciseIncidentAdjudication,
  reason: string,
): string {
  return `${adjudication[0]!.toUpperCase()}${adjudication.slice(1)} quality decision: ${reason}`;
}

function fromAdjudicationStatus(
  status: ExerciseFlagAdjudicationStatus,
): ExerciseIncidentAdjudication {
  switch (status) {
    case ExerciseFlagAdjudicationStatus.CONFIRMED:
      return "confirmed";
    case ExerciseFlagAdjudicationStatus.REJECTED:
      return "rejected";
    case ExerciseFlagAdjudicationStatus.INCONCLUSIVE:
      return "inconclusive";
    case ExerciseFlagAdjudicationStatus.PENDING:
      throw new Error("A pending quality decision cannot be returned as idempotent.");
  }
}

function normalizeIdempotencyKey(value: string | null | undefined): string | null {
  const key = value?.trim() || null;
  if (key && (key.length < 8 || key.length > 200)) {
    throw new Error("Incident resolution idempotency keys must be 8 to 200 characters.");
  }
  return key;
}

function normalizeOptionalDate(value: Date | string | null | undefined): Date | null {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Incident resolution expectedUpdatedAt must be a valid date.");
  return date;
}

function assertValidDate(value: Date, message: string) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new Error(message);
}

function hashResolutionPayload(input: {
  adjudication: ExerciseIncidentAdjudication;
  exerciseId: string;
  quarantineRelated: boolean;
  resolutionReason: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex");
}

function buildIncidentKey(
  exercise: {
    generatorReleaseId: string | null;
    exerciseFamily: string | null;
    qualityVersion: string | null;
  },
  adjudicationCode: string,
): string {
  return [
    exercise.generatorReleaseId ?? "release-unknown",
    exercise.exerciseFamily ?? "family-unknown",
    exercise.qualityVersion ?? "quality-unknown",
    adjudicationCode,
  ].join(":").slice(0, 300);
}
