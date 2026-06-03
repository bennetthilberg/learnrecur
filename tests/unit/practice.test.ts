import { describe, expect, it } from "vitest";

import { FsrsRating } from "@/generated/prisma/client";
import { resolveFinalPracticeRating } from "@/lib/practice";

describe("resolveFinalPracticeRating", () => {
  it("keeps incorrect answers at Again regardless of manual override", () => {
    expect(
      resolveFinalPracticeRating({
        isCorrect: false,
        proposedRating: FsrsRating.AGAIN,
        manualRating: FsrsRating.EASY,
      }),
    ).toBe(FsrsRating.AGAIN);
  });

  it("uses manual Hard, Good, and Easy ratings for correct answers", () => {
    for (const manualRating of [FsrsRating.HARD, FsrsRating.GOOD, FsrsRating.EASY]) {
      expect(
        resolveFinalPracticeRating({
          isCorrect: true,
          proposedRating: FsrsRating.GOOD,
          manualRating,
        }),
      ).toBe(manualRating);
    }
  });

  it("falls back to the proposed rating when no correct-answer override is allowed", () => {
    expect(
      resolveFinalPracticeRating({
        isCorrect: true,
        proposedRating: FsrsRating.EASY,
        manualRating: null,
      }),
    ).toBe(FsrsRating.EASY);
    expect(
      resolveFinalPracticeRating({
        isCorrect: true,
        proposedRating: FsrsRating.GOOD,
        manualRating: FsrsRating.AGAIN,
      }),
    ).toBe(FsrsRating.GOOD);
  });
});
