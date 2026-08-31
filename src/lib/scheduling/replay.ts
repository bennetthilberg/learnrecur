import { FsrsRating } from "@/generated/prisma/client";
import {
  advanceSkillSchedule,
  type SkillScheduleFields,
} from "@/lib/scheduling";

export type PracticeEvidenceKind = "independent" | "assisted" | "invalidated";

export type ScheduleReplayReview = {
  reviewId: string;
  attemptId: string;
  reviewedAt: Date;
  rating: FsrsRating;
  evidenceKind: PracticeEvidenceKind;
};

export type ScheduleReplayResult = {
  schedule: SkillScheduleFields;
  appliedReviewIds: string[];
  excluded: Array<{
    reviewId: string;
    reason: Exclude<PracticeEvidenceKind, "independent">;
  }>;
};

/**
 * Converts confirmed defective attempts into explicit invalidated evidence while
 * preserving the immutable review history used for audit and replay.
 */
export function buildScheduleReplayPlan({
  reviews,
  invalidAttemptIds,
}: {
  reviews: readonly ScheduleReplayReview[];
  invalidAttemptIds: ReadonlySet<string>;
}): ScheduleReplayReview[] {
  return reviews.map((review) => ({
    ...review,
    evidenceKind: invalidAttemptIds.has(review.attemptId)
      ? "invalidated"
      : review.evidenceKind,
  }));
}

/**
 * Rebuilds a skill schedule from independently completed retrieval evidence.
 * Assisted practice remains useful learning activity, but it is deliberately
 * excluded from the retention schedule. Confirmed defective attempts are also
 * excluded without deleting their audit records.
 */
export function replayIndependentScheduleEvidence({
  initial,
  reviews,
}: {
  initial: SkillScheduleFields;
  reviews: readonly ScheduleReplayReview[];
}): ScheduleReplayResult {
  assertUniqueReviews(reviews);

  const ordered = [...reviews].toSorted((left, right) => {
    const timeDifference = left.reviewedAt.getTime() - right.reviewedAt.getTime();

    return timeDifference || left.reviewId.localeCompare(right.reviewId);
  });
  let schedule = { ...initial };
  const appliedReviewIds: string[] = [];
  const excluded: ScheduleReplayResult["excluded"] = [];

  for (const review of ordered) {
    assertValidReview(review);

    if (review.evidenceKind !== "independent") {
      excluded.push({
        reviewId: review.reviewId,
        reason: review.evidenceKind,
      });
      continue;
    }

    schedule = advanceSkillSchedule({
      current: schedule,
      rating: review.rating,
      reviewedAt: review.reviewedAt,
    }).skillUpdate;
    appliedReviewIds.push(review.reviewId);
  }

  return {
    schedule,
    appliedReviewIds,
    excluded,
  };
}

function assertUniqueReviews(reviews: readonly ScheduleReplayReview[]) {
  const ids = new Set<string>();

  for (const review of reviews) {
    if (ids.has(review.reviewId)) {
      throw new Error(`Duplicate review ID: ${review.reviewId}`);
    }

    ids.add(review.reviewId);
  }
}

function assertValidReview(review: ScheduleReplayReview) {
  if (!review.reviewId.trim() || !review.attemptId.trim()) {
    throw new Error("Schedule replay reviews require review and attempt IDs.");
  }

  if (!Number.isFinite(review.reviewedAt.getTime())) {
    throw new Error(`Review ${review.reviewId} has an invalid reviewedAt value.`);
  }
}
