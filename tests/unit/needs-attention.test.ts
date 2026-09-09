import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  preparationFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    $queryRaw: prismaMocks.queryRaw,
    skill: { findMany: prismaMocks.preparationFindMany },
  }),
}));

import { FsrsRating } from "@/generated/prisma/client";
import {
  detectRepeatedMisses,
  formatRepeatedMissesReason,
  buildNeedsAttentionLinks,
  getNeedsAttention,
  isValidNeedsAttentionReview,
  NeedsAttentionCursorError,
  selectNeedsAttentionReviews,
  type NeedsAttentionReviewEvidence,
} from "@/lib/practice/needs-attention";

const now = new Date("2026-09-08T18:00:00.000Z");

beforeEach(() => {
  prismaMocks.queryRaw.mockReset();
  prismaMocks.preparationFindMany.mockReset();
  prismaMocks.preparationFindMany.mockResolvedValue([]);
});

function review(
  index: number,
  input: Partial<NeedsAttentionReviewEvidence> = {},
): NeedsAttentionReviewEvidence {
  return {
    id: `review-${index}`,
    reviewedAt: new Date(`2026-09-${String(index).padStart(2, "0")}T12:00:00.000Z`),
    isCorrect: false,
    finalRating: FsrsRating.AGAIN,
    scheduled: true,
    ...input,
  };
}

describe("needs-attention evidence detection", () => {
  it("prefills an owned skill in the custom practice route", () => {
    expect(buildNeedsAttentionLinks("skill/with spaces")).toMatchObject({
      skill: "/skills/skill%2Fwith%20spaces",
      practice: "/practice/custom?skillId=skill%2Fwith%20spaces",
    });
  });

  it("reports three misses in the last five independent scheduled reviews when the latest is a miss", () => {
    const finding = detectRepeatedMisses({
      now,
      reviews: [
        review(1),
        review(2, { isCorrect: true, finalRating: FsrsRating.GOOD }),
        review(3),
        review(4, { isCorrect: true, finalRating: FsrsRating.GOOD }),
        review(5),
      ],
    });

    expect(finding).toMatchObject({
      missCount: 3,
      reviewCount: 5,
      lastReviewedAt: new Date("2026-09-05T12:00:00.000Z"),
    });
    expect(formatRepeatedMissesReason(finding!)).toBe(
      "3 misses in the last 5 independent scheduled reviews, including the most recent review.",
    );
  });

  it("stays quiet after a recent successful independent recovery", () => {
    expect(
      detectRepeatedMisses({
        now,
        reviews: [
          review(1),
          review(2),
          review(3),
          review(4),
          review(5, { isCorrect: true, finalRating: FsrsRating.GOOD }),
        ],
      }),
    ).toBeNull();
  });

  it("uses the latest five reviews instead of lifetime lapse history", () => {
    const finding = detectRepeatedMisses({
      now,
      reviews: [
        review(1),
        review(2),
        review(3),
        review(4, { isCorrect: true, finalRating: FsrsRating.GOOD }),
        review(5, { isCorrect: true, finalRating: FsrsRating.GOOD }),
        review(6, { isCorrect: true, finalRating: FsrsRating.GOOD }),
        review(7, { isCorrect: true, finalRating: FsrsRating.GOOD }),
      ],
    });

    expect(finding).toBeNull();
    expect(
      selectNeedsAttentionReviews({
        now,
        reviews: [review(1), review(2), review(3), review(4), review(5), review(6)],
      }),
    ).toHaveLength(5);
  });

  it("does not count assisted, practice-only, future, unscheduled, or corrected evidence", () => {
    const evidence = [
      review(1),
      review(2, { assisted: true, isCorrect: true, finalRating: FsrsRating.GOOD }),
      review(3, { exposure: "PRACTICE_ONLY", isCorrect: true, finalRating: FsrsRating.GOOD }),
      review(4, { sessionMode: "PRACTICE_ONLY", isCorrect: true, finalRating: FsrsRating.GOOD }),
      review(5, { invalidated: true, isCorrect: true, finalRating: FsrsRating.GOOD }),
      review(6, { scheduled: false, isCorrect: true, finalRating: FsrsRating.GOOD }),
      review(7, {
        reviewedAt: new Date("2026-09-09T12:00:00.000Z"),
        isCorrect: true,
        finalRating: FsrsRating.GOOD,
      }),
      review(8),
      review(9, { reviewedAt: new Date("2026-09-07T12:00:00.000Z") }),
    ];

    const selected = selectNeedsAttentionReviews({ now, reviews: evidence });
    expect(selected.map((entry) => entry.id)).toEqual(["review-1", "review-9", "review-8"]);
    expect(detectRepeatedMisses({ now, reviews: evidence })).toMatchObject({
      missCount: 3,
      reviewCount: 3,
    });
  });

  it("does not report a short or already recovered history", () => {
    expect(
      detectRepeatedMisses({ now, reviews: [review(1), review(2)] }),
    ).toBeNull();
    expect(
      detectRepeatedMisses({
        now,
        reviews: [
          review(1),
          review(2),
          review(3, { isCorrect: true, finalRating: FsrsRating.GOOD }),
        ],
      }),
    ).toBeNull();
  });

  it("requires a valid date boundary", () => {
    expect(() => selectNeedsAttentionReviews({ now: new Date("invalid"), reviews: [] })).toThrow(
      "valid now Date",
    );
    expect(
      isValidNeedsAttentionReview(review(1), now),
    ).toBe(true);
  });

  it("rejects malformed cursors with a typed domain error before querying", async () => {
    await expect(
      getNeedsAttention({ userId: "learner-1", now, cursor: "not-base64-json" }),
    ).rejects.toBeInstanceOf(NeedsAttentionCursorError);
    expect(prismaMocks.queryRaw).not.toHaveBeenCalled();
  });

  it("caps discarded candidate scans at two and returns a progressing cursor", async () => {
    prismaMocks.queryRaw
      .mockResolvedValueOnce([
        candidate("discarded-1", "2026-09-07T12:00:00.000Z"),
        candidate("discarded-2", "2026-09-06T12:00:00.000Z"),
      ])
      .mockResolvedValueOnce([
        candidate("discarded-3", "2026-09-05T12:00:00.000Z"),
        candidate("discarded-4", "2026-09-04T12:00:00.000Z"),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        candidate("should-not-be-scanned", "2026-09-03T12:00:00.000Z"),
      ]);

    const result = await getNeedsAttention({ userId: "learner-1", now, limit: 1 });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeTruthy();
    expect(decodeCursor(result.nextCursor!)).toMatchObject({
      kind: "preparation",
      skillId: "discarded-4",
    });
    expect(prismaMocks.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("uses the returned item cursor only when more than the page are valid", async () => {
    prismaMocks.queryRaw
      .mockResolvedValueOnce([
        repeatedCandidate("valid-1", "2026-09-07T12:00:00.000Z"),
        repeatedCandidate("valid-2", "2026-09-06T12:00:00.000Z"),
      ])
      .mockResolvedValueOnce([
        ...reviewRows("valid-1", "2026-09-07T12:00:00.000Z"),
        ...reviewRows("valid-2", "2026-09-06T12:00:00.000Z"),
      ]);

    const result = await getNeedsAttention({ userId: "learner-1", now, limit: 1 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.skillId).toBe("valid-1");
    expect(decodeCursor(result.nextCursor!)).toMatchObject({
      kind: "repeated-misses",
      skillId: "valid-1",
    });
    expect(prismaMocks.queryRaw).toHaveBeenCalledTimes(2);
  });

  it("uses the last scanned candidate when exactly one valid item shares a fuller scan", async () => {
    prismaMocks.queryRaw
      .mockResolvedValueOnce([
        candidate("discarded-1", "2026-09-07T12:00:00.000Z"),
        candidate("discarded-2", "2026-09-06T12:00:00.000Z"),
      ])
      .mockResolvedValueOnce([
        repeatedCandidate("valid-1", "2026-09-05T12:00:00.000Z"),
        candidate("discarded-3", "2026-09-04T12:00:00.000Z"),
      ])
      .mockResolvedValueOnce(reviewRows("valid-1", "2026-09-05T12:00:00.000Z"));

    const result = await getNeedsAttention({ userId: "learner-1", now, limit: 1 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.skillId).toBe("valid-1");
    expect(decodeCursor(result.nextCursor!)).toMatchObject({
      kind: "preparation",
      skillId: "discarded-3",
    });
  });

  it("clears candidate continuation after an empty scan", async () => {
    prismaMocks.queryRaw
      .mockResolvedValueOnce([
        candidate("discarded-1", "2026-09-07T12:00:00.000Z"),
        candidate("discarded-2", "2026-09-06T12:00:00.000Z"),
      ])
      .mockResolvedValueOnce([]);

    const result = await getNeedsAttention({ userId: "learner-1", now, limit: 1 });

    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
    expect(prismaMocks.queryRaw).toHaveBeenCalledTimes(2);
  });
});

function candidate(skillId: string, sortAt: string) {
  return {
    skill_id: skillId,
    skill_title: skillId,
    collection_name: null,
    due_at: new Date(sortAt),
    kind: "preparation" as const,
    sort_at: new Date(sortAt),
    review_count: 0,
    miss_count: 0,
    latest_job_status: null,
  };
}

function repeatedCandidate(skillId: string, sortAt: string) {
  return {
    ...candidate(skillId, sortAt),
    kind: "repeated-misses" as const,
    review_count: 3,
    miss_count: 3,
    latest_job_status: null,
  };
}

function reviewRows(skillId: string, reviewedAt: string) {
  return Array.from({ length: 3 }, (_, index) => ({
    skill_id: skillId,
    skill_title: skillId,
    collection_name: null,
    due_at: new Date("2026-09-01T12:00:00.000Z"),
    review_id: `${skillId}-review-${index}`,
    reviewed_at: new Date(
      new Date(reviewedAt).getTime() - (2 - index) * 86_400_000,
    ),
    is_correct: false,
    final_rating: FsrsRating.AGAIN,
  }));
}

function decodeCursor(value: string) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as {
    kind: string;
    skillId: string;
  };
}
