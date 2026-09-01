import { describe, expect, it } from "vitest";

import { FsrsRating, SkillFsrsState } from "@/generated/prisma/client";
import {
  buildScheduleReplayPlan,
  replayIndependentScheduleEvidence,
} from "@/lib/scheduling/replay";

const initial = {
  dueAt: new Date("2026-01-01T12:00:00.000Z"),
  stability: 0,
  difficulty: 0,
  elapsedDays: 0,
  scheduledDays: 0,
  learningSteps: 0,
  repetitions: 0,
  lapses: 0,
  fsrsState: SkillFsrsState.NEW,
  lastReviewedAt: null,
};

describe("replayIndependentScheduleEvidence", () => {
  it("replays only independent, non-invalidated retrieval evidence", () => {
    const result = replayIndependentScheduleEvidence({
      initial,
      reviews: [
        {
          reviewId: "review-independent-1",
          attemptId: "attempt-independent-1",
          reviewedAt: new Date("2026-01-01T12:01:00.000Z"),
          rating: FsrsRating.GOOD,
          evidenceKind: "independent",
        },
        {
          reviewId: "review-assisted",
          attemptId: "attempt-assisted",
          reviewedAt: new Date("2026-01-02T12:01:00.000Z"),
          rating: FsrsRating.EASY,
          evidenceKind: "assisted",
        },
        {
          reviewId: "review-invalidated",
          attemptId: "attempt-invalidated",
          reviewedAt: new Date("2026-01-03T12:01:00.000Z"),
          rating: FsrsRating.AGAIN,
          evidenceKind: "invalidated",
        },
        {
          reviewId: "review-independent-2",
          attemptId: "attempt-independent-2",
          reviewedAt: new Date("2026-01-04T12:01:00.000Z"),
          rating: FsrsRating.HARD,
          evidenceKind: "independent",
        },
      ],
    });

    expect(result.appliedReviewIds).toEqual([
      "review-independent-1",
      "review-independent-2",
    ]);
    expect(result.excluded).toEqual([
      { reviewId: "review-assisted", reason: "assisted" },
      { reviewId: "review-invalidated", reason: "invalidated" },
    ]);
    expect(result.schedule.repetitions).toBe(2);
    expect(result.schedule.lastReviewedAt).toEqual(
      new Date("2026-01-04T12:01:00.000Z"),
    );
  });

  it("sorts stable replay input chronologically and rejects duplicate review IDs", () => {
    const reviews = [
      {
        reviewId: "review-2",
        attemptId: "attempt-2",
        reviewedAt: new Date("2026-01-02T12:00:00.000Z"),
        rating: FsrsRating.GOOD,
        evidenceKind: "independent" as const,
      },
      {
        reviewId: "review-1",
        attemptId: "attempt-1",
        reviewedAt: new Date("2026-01-01T12:00:00.000Z"),
        rating: FsrsRating.GOOD,
        evidenceKind: "independent" as const,
      },
    ];

    expect(
      replayIndependentScheduleEvidence({ initial, reviews }).appliedReviewIds,
    ).toEqual(["review-1", "review-2"]);

    expect(() =>
      replayIndependentScheduleEvidence({
        initial,
        reviews: [...reviews, { ...reviews[0], attemptId: "different-attempt" }],
      }),
    ).toThrow("Duplicate review ID");
  });
});

describe("buildScheduleReplayPlan", () => {
  it("invalidates reviews tied to confirmed defective exercise attempts", () => {
    const plan = buildScheduleReplayPlan({
      reviews: [
        {
          reviewId: "good-review",
          attemptId: "good-attempt",
          reviewedAt: new Date("2026-01-01T12:00:00.000Z"),
          rating: FsrsRating.GOOD,
          evidenceKind: "independent",
        },
        {
          reviewId: "bad-review",
          attemptId: "bad-attempt",
          reviewedAt: new Date("2026-01-02T12:00:00.000Z"),
          rating: FsrsRating.EASY,
          evidenceKind: "independent",
        },
      ],
      invalidAttemptIds: new Set(["bad-attempt"]),
    });

    expect(plan).toEqual([
      expect.objectContaining({ reviewId: "good-review", evidenceKind: "independent" }),
      expect.objectContaining({ reviewId: "bad-review", evidenceKind: "invalidated" }),
    ]);
  });
});
