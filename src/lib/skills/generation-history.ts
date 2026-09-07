import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import { MAX_RECENT_EXERCISES_CONSIDERED } from "./exercise-planning";
import {
  RECENT_REVIEW_LIMIT,
  type GenerationRecentEvidence,
} from "./recent-evidence";

// Two bounded queries per generation operation. Private raw/normalized learner
// answers never enter this projection or the model prompt.
export async function loadGenerationRecentEvidence(input: {
  userId: string;
  skillId: string;
  now: Date;
  prisma?: Pick<Prisma.TransactionClient, "reviewLog" | "exercise">;
}): Promise<GenerationRecentEvidence> {
  const prisma = input.prisma ?? getPrisma();
  const [reviews, exercises] = await Promise.all([
    prisma.reviewLog.findMany({
      where: {
        userId: input.userId,
        skillId: input.skillId,
        reviewedAt: { lte: input.now },
        exerciseAttempt: {
          result: { in: ["CORRECT", "INCORRECT"] },
          exercise: { flags: { none: { adjudicationStatus: "CONFIRMED" } } },
        },
      },
      orderBy: [{ reviewedAt: "desc" }, { id: "desc" }],
      take: RECENT_REVIEW_LIMIT,
      select: {
        id: true,
        reviewedAt: true,
        previousDueAt: true,
        finalRating: true,
        exerciseAttempt: {
          select: {
            isCorrect: true,
            practiceContext: true,
            exercise: { select: { answerKind: true, exerciseFamily: true } },
          },
        },
      },
    }),
    prisma.exercise.findMany({
      where: {
        userId: input.userId,
        skillId: input.skillId,
        createdAt: { lte: input.now },
        verificationStatus: "VERIFIED",
        flags: { none: { adjudicationStatus: "CONFIRMED" } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: MAX_RECENT_EXERCISES_CONSIDERED,
      select: {
        id: true,
        answerKind: true,
        exerciseFamily: true,
        freshnessKey: true,
        createdAt: true,
      },
    }),
  ]);
  return {
    reviews: reviews.reverse().map((review) => {
      const context = review.exerciseAttempt.practiceContext;
      const assisted = Boolean(
        context &&
          typeof context === "object" &&
          !Array.isArray(context) &&
          context.assistance === "observed",
      );
      return {
        id: review.id,
        reviewedAt: review.reviewedAt,
        rating: review.finalRating,
        isCorrect: review.exerciseAttempt.isCorrect,
        ...review.exerciseAttempt.exercise,
        assisted,
        scheduled: Boolean(
          review.previousDueAt && review.previousDueAt <= review.reviewedAt,
        ),
      };
    }),
    exercises: exercises.reverse(),
  };
}
