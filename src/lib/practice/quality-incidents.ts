import "server-only";

import {
  ExerciseEvidenceCorrectionAction,
  ExerciseEvidenceCorrectionStatus,
  ExerciseFlagAdjudicationStatus,
  type FsrsRating,
  type Prisma,
} from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import { createInitialSkillSchedule, type SkillScheduleFields } from "@/lib/scheduling";
import {
  buildScheduleReplayPlan,
  replayIndependentScheduleEvidence,
} from "@/lib/scheduling/replay";

export type ExerciseIncidentAdjudication = "confirmed" | "rejected" | "inconclusive";

export type ExerciseIncidentResult =
  | { status: "not-found" }
  | {
      status: "adjudicated";
      adjudication: ExerciseIncidentAdjudication;
      affectedReviewCount: number;
      replayedReviewCount: number;
      quarantinedExerciseCount: number;
    };

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

export async function adjudicateExerciseQualityIncident(input: {
  userId: string;
  exerciseId: string;
  adjudication: ExerciseIncidentAdjudication;
  adjudicationCode: string;
  now: Date;
  quarantineRelated?: boolean;
}): Promise<ExerciseIncidentResult> {
  const adjudicationCode = input.adjudicationCode.trim().slice(0, 80);
  if (!adjudicationCode) throw new Error("Incident adjudication requires a reason code.");

  const prisma = getPrisma();
  return prisma.$transaction(async (tx) => {
    const exercise = await tx.exercise.findFirst({
      where: { id: input.exerciseId, userId: input.userId },
      select: {
        id: true,
        userId: true,
        skillId: true,
        exerciseFamily: true,
        qualityVersion: true,
        generatorReleaseId: true,
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
    const locked =
      input.adjudication === "confirmed" &&
      input.quarantineRelated &&
      exercise.exerciseFamily &&
      exercise.qualityVersion &&
      exercise.generatorReleaseId
        ? await lockExerciseFamilyForQualityMutation(tx, {
            ...exercise,
            exerciseFamily: exercise.exerciseFamily,
            qualityVersion: exercise.qualityVersion,
            generatorReleaseId: exercise.generatorReleaseId,
          })
        : await lockExerciseForQualityMutation(tx, input.userId, input.exerciseId);
    if (!locked) return { status: "not-found" };

    const flags = await tx.exerciseFlag.findMany({
      where: { exerciseId: exercise.id, userId: input.userId },
      select: { adjudicationStatus: true },
    });
    if (flags.length === 0) return { status: "not-found" };

    if (
      input.adjudication !== "confirmed" &&
      flags.some(
        (flag) => flag.adjudicationStatus === ExerciseFlagAdjudicationStatus.CONFIRMED,
      )
    ) {
      throw new Error(
        "A confirmed quality incident cannot be reversed without restoring its scheduling evidence.",
      );
    }

    if (input.adjudication !== "confirmed") {
      await tx.exerciseFlag.updateMany({
        where: { exerciseId: exercise.id, userId: input.userId },
        data: {
          adjudicationStatus: input.adjudication === "rejected"
            ? ExerciseFlagAdjudicationStatus.REJECTED
            : ExerciseFlagAdjudicationStatus.INCONCLUSIVE,
          adjudicatedAt: input.now,
          adjudicationCode,
          evidenceCorrectionAction: ExerciseEvidenceCorrectionAction.NONE,
          evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus.NOT_REQUIRED,
          practiceEvidenceNeedsCorrection: false,
          affectedReviewCount: 0,
          correctionCompletedAt: input.now,
        },
      });
      return {
        status: "adjudicated",
        adjudication: input.adjudication,
        affectedReviewCount: 0,
        replayedReviewCount: 0,
        quarantinedExerciseCount: 0,
      };
    }

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
        exerciseAttempt: { select: { exerciseId: true } },
      },
    });
    const invalidAttemptIds = new Set(
      reviews
        .filter((review) => review.exerciseAttempt.exerciseId === exercise.id)
        .map((review) => review.exerciseAttemptId),
    );
    const initial = initialSchedule(reviews[0] ?? null, exercise.skill.createdAt);
    const replay = replayIndependentScheduleEvidence({
      initial,
      reviews: buildScheduleReplayPlan({
        reviews: reviews.map((review) => ({
          reviewId: review.id,
          attemptId: review.exerciseAttemptId,
          reviewedAt: review.reviewedAt,
          rating: review.finalRating as FsrsRating,
          evidenceKind: "independent" as const,
        })),
        invalidAttemptIds,
      }),
    });

    await tx.skill.update({
      where: { id: exercise.skillId },
      data: replay.schedule,
    });

    let quarantinedExerciseCount = 0;
    if (
      input.quarantineRelated &&
      exercise.exerciseFamily &&
      exercise.qualityVersion &&
      exercise.generatorReleaseId
    ) {
      const quarantine = await tx.exercise.updateMany({
        where: {
          userId: input.userId,
          skillId: exercise.skillId,
          exerciseFamily: exercise.exerciseFamily,
          qualityVersion: exercise.qualityVersion,
          generatorReleaseId: exercise.generatorReleaseId,
          retiredAt: null,
        },
        data: { retiredAt: input.now, retirementReason: "OTHER" },
      });
      quarantinedExerciseCount = quarantine.count;
    }

    await tx.exerciseFlag.updateMany({
      where: { exerciseId: exercise.id, userId: input.userId },
      data: {
        adjudicationStatus: ExerciseFlagAdjudicationStatus.CONFIRMED,
        adjudicatedAt: input.now,
        adjudicationCode,
        evidenceCorrectionAction: invalidAttemptIds.size
          ? ExerciseEvidenceCorrectionAction.INVALIDATE_AND_REPLAY
          : ExerciseEvidenceCorrectionAction.NONE,
        evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus.COMPLETE,
        practiceEvidenceNeedsCorrection: false,
        affectedReviewCount: invalidAttemptIds.size,
        correctionStartedAt: input.now,
        correctionCompletedAt: input.now,
        incidentKey: buildIncidentKey(exercise, adjudicationCode),
      },
    });

    return {
      status: "adjudicated",
      adjudication: input.adjudication,
      affectedReviewCount: invalidAttemptIds.size,
      replayedReviewCount: replay.appliedReviewIds.length,
      quarantinedExerciseCount,
    };
  });
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
