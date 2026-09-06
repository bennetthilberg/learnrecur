import { describe, expect, it } from "vitest";
import {
  summarizeRecentEvidence,
  type RecentReviewEvidence,
} from "@/lib/skills/recent-evidence";
const now = new Date("2026-09-06T18:00:00Z");
function review(
  day: number,
  correct = true,
  assisted = false,
): RecentReviewEvidence {
  return {
    id: `r${day}`,
    reviewedAt: new Date(`2026-09-0${day}T12:00:00Z`),
    isCorrect: correct,
    rating: correct ? "GOOD" : "AGAIN",
    answerKind: "CHOICE",
    exerciseFamily: "recognition",
    assisted,
    scheduled: true,
  };
}
describe("recent recovery evidence", () => {
  it("recovers despite lifetime lapses after two unassisted scheduled successes on a later UTC day", () => {
    const result = summarizeRecentEvidence({
      reviews: [review(5), review(3, false), review(4)],
      lapses: 4,
      state: "RELEARNING",
      now,
    });
    expect(result.recoveryActive).toBe(false);
    expect(result.recentIndependentReviews).toBe(2);
  });
  it("needs two consecutive successes and a later day, without treating choice as assistance", () => {
    expect(
      summarizeRecentEvidence({ reviews: [review(3, false), review(4)], now })
        .recoveryActive,
    ).toBe(true);
    expect(
      summarizeRecentEvidence({
        reviews: [review(3, false), review(4), review(5, true, true)],
        now,
      }).recoveryActive,
    ).toBe(true);
    expect(
      summarizeRecentEvidence({
        reviews: [
          review(3, false),
          { ...review(3), id: "r3b" },
          { ...review(3), id: "r3c" },
        ],
        now,
      }).recoveryActive,
    ).toBe(true);
  });
  it("a fresh failure re-enters recovery; future and unscheduled successes cannot clear it", () => {
    const reviews = [
      review(2, false),
      review(3),
      review(4),
      review(5, false),
      { ...review(6), scheduled: false },
      review(7),
    ];
    expect(summarizeRecentEvidence({ reviews, now }).recoveryActive).toBe(true);
  });
  it("has a recoverable conservative fallback for missing legacy history", () => {
    expect(
      summarizeRecentEvidence({ reviews: [], lapses: 1, now }).recoveryActive,
    ).toBe(true);
    expect(
      summarizeRecentEvidence({
        reviews: [review(4), review(5)],
        lapses: 1,
        now,
      }).recoveryActive,
    ).toBe(false);
    expect(summarizeRecentEvidence({ reviews: [], now }).recoveryActive).toBe(
      false,
    );
  });
});

it("passes actual assistance and mode history into planning without inventing independent success", async () => {
  const { buildGenerationQualityContext } = await import(
    "@/lib/skills/quality-pipeline"
  );
  const skill = {
    id: "history",
    title: "Technical terminology",
    objective: "Recall approved terms.",
    rules: null,
    examples: null,
    exerciseConstraints: null,
    tags: [],
    fsrsState: "REVIEW" as const,
    repetitions: 8,
    lapses: 0,
    stability: 15,
  };
  const context = buildGenerationQualityContext({
    skill,
    sourceContext: null,
    requestedCount: 2,
    answerModes: ["choice", "text"],
    now,
    recentEvidence: {
      reviews: [review(3, true, true), review(4, true, true)],
      exercises: [],
    },
  });
  expect(context.recentEvidence).toMatchObject({
    recentIndependentReviews: 0,
    recentAssistedAttempts: 2,
    recentAnswerModes: ["CHOICE", "CHOICE"],
  });
  expect(context.blueprint.slots[0]).toMatchObject({
    evidenceMode: "learning-time",
    answerMode: "text",
  });
});
