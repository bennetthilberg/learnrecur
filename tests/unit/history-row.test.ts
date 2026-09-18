import { describe, expect, it } from "vitest";

import { ExerciseEvidenceCorrectionStatus, FsrsRating } from "@/generated/prisma/client";
import type { PracticeHistoryReview } from "@/lib/practice/history";
import { toHistoryReviewRow } from "@/app/history/history-row";

const baseReview: PracticeHistoryReview = {
  id: "review-1",
  skillId: "skill-1",
  skillTitle: "Spanish present tense",
  skillStatus: "ACTIVE",
  collectionName: "Spanish",
  exerciseAttemptId: "attempt-1",
  answerKind: "CHOICE",
  result: "CORRECT",
  responseMs: 1200,
  finalRating: FsrsRating.GOOD,
  reviewedAt: new Date("2026-09-10T12:00:00.000Z"),
  previousDueAt: new Date("2026-09-09T12:00:00.000Z"),
  nextDueAt: new Date("2026-09-12T12:00:00.000Z"),
  previousState: "LEARNING",
  nextState: "REVIEW",
  correctAnswerDisplay: "ser",
  prompt: "Choose the correct verb.",
  submittedAnswerDisplay: "ser",
  explanation: "Use ser for identity.",
  eventKind: "scheduled",
  practiceContext: null,
  evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus.NOT_REQUIRED,
  evidenceCorrectionNote: null,
  evidenceCorrectionAt: null,
  evidenceCorrectionIncidentKey: null,
  qualityReportReasons: [],
};

describe("toHistoryReviewRow", () => {
  it("labels practice-only activity as unscheduled and preserves correction notices", () => {
    const row = toHistoryReviewRow({
      ...baseReview,
      id: "practice-1",
      finalRating: null,
      previousDueAt: null,
      nextDueAt: null,
      previousState: null,
      nextState: null,
      eventKind: "practice-only",
      evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus.COMPLETE,
      evidenceCorrectionNote: "Retained historical evidence.",
      qualityReportReasons: ["INCORRECT_ANSWER"],
    });

    expect(row).toMatchObject({
      eventKind: "practice-only",
      eventKindLabel: "Practice-only exposure",
      finalRatingLabel: "Practice only",
      previousDueLabel: "Not scheduled",
      nextDueLabel: "No schedule change",
      previousStateLabel: "Not scheduled",
      nextStateLabel: "Not scheduled",
      evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus.COMPLETE,
      evidenceCorrectionNote: "Retained historical evidence.",
      qualityReportReasons: ["Incorrect Answer"],
    });
  });
});
