import { describe, expect, it } from "vitest";

import { FsrsRating } from "@/generated/prisma/client";
import {
  detectRepeatedMisses,
  formatRepeatedMissesReason,
  buildNeedsAttentionLinks,
  isValidNeedsAttentionReview,
  selectNeedsAttentionReviews,
  type NeedsAttentionReviewEvidence,
} from "@/lib/practice/needs-attention";

const now = new Date("2026-09-08T18:00:00.000Z");

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
});
