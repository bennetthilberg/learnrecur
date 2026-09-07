import type { AnswerKind, FsrsRating } from "@/generated/prisma/client";
import {
  classifyAttemptEvidence,
  type RecentExercise,
} from "./exercise-planning";

export const RECENT_REVIEW_LIMIT = 20;
export const RECOVERY_POLICY_VERSION = "recent-recovery-v1";
export type RecentReviewEvidence = {
  id: string;
  reviewedAt: Date;
  isCorrect: boolean;
  rating: FsrsRating;
  answerKind: AnswerKind;
  exerciseFamily: string | null;
  assisted: boolean;
  scheduled: boolean;
};
export type GenerationRecentEvidence = {
  reviews: RecentReviewEvidence[];
  exercises: RecentExercise[];
};

// Chronological UTC days are stable across timezone preference changes. This is
// a conservative initial heuristic, not a measured optimum or a new scheduler.
export function summarizeRecentEvidence(input: {
  reviews: readonly RecentReviewEvidence[];
  lapses?: number;
  state?: string | null;
  now: Date;
}) {
  if (!Number.isFinite(input.now.getTime()))
    throw new Error("Planning requires a valid current time.");
  const reviews = input.reviews
    .filter((review) => review.scheduled && review.reviewedAt <= input.now)
    .toSorted(
      (a, b) =>
        a.reviewedAt.getTime() - b.reviewedAt.getTime() ||
        a.id.localeCompare(b.id),
    )
    .slice(-RECENT_REVIEW_LIMIT);
  const lastFailure = reviews.findLastIndex(
    (review) => !review.isCorrect || review.rating === "AGAIN",
  );
  const needsRecovery =
    lastFailure >= 0 || (input.lapses ?? 0) > 0 || input.state === "RELEARNING";
  const afterFailure = reviews.slice(lastFailure + 1);
  const consecutive = afterFailure.slice(-2);
  const boundary = lastFailure >= 0 ? reviews[lastFailure] : reviews[0];
  const recovered =
    consecutive.length === 2 &&
    consecutive.every((review) => review.isCorrect && !review.assisted) &&
    Boolean(
      boundary &&
        consecutive.some(
          (review) =>
            review.reviewedAt.toISOString().slice(0, 10) >
            boundary.reviewedAt.toISOString().slice(0, 10),
        ),
    );
  const classified = reviews.map((review) =>
    classifyAttemptEvidence({
      isCorrect: review.isCorrect,
      answerRevealed: review.assisted,
    }),
  );
  return {
    recoveryActive: needsRecovery && !recovered,
    recentRatings: reviews.map((review) => review.rating),
    recentAnswerModes: reviews.map((review) => review.answerKind),
    recentExerciseFamilies: reviews.flatMap((review) =>
      review.exerciseFamily ? [review.exerciseFamily] : [],
    ),
    reviewWindow: {
      count: reviews.length,
      firstAt: reviews[0]?.reviewedAt.toISOString() ?? null,
      lastAt: reviews.at(-1)?.reviewedAt.toISOString() ?? null,
    },
    recentIndependentReviews: classified.filter(
      (value) => value.isIndependentRetention,
    ).length,
    recentAssistedAttempts: classified.filter(
      (value) => value.kind === "assisted_learning",
    ).length,
  };
}
