import type { PracticeHistoryReview } from "@/lib/practice/history";
import type { HistoryReviewRow } from "./history-reviews-table";
import { formatDueLabel, formatHistoryEnum, formatHistoryLabel, formatNullableHistoryLabel, formatResponseTime, formatReviewResult } from "@/lib/practice/history-formatters";

function formatAnswerKind(kind: PracticeHistoryReview["answerKind"]) {
  return formatHistoryEnum(kind).replace("multiple choice", "choice");
}

export function toHistoryReviewRow(review: PracticeHistoryReview): HistoryReviewRow {
  return {
    id: review.id,
    answerKindLabel: formatAnswerKind(review.answerKind),
    collectionName: review.collectionName ?? "Uncollected",
    correctAnswerDisplay: review.correctAnswerDisplay,
    prompt: review.prompt,
    submittedAnswerDisplay: review.submittedAnswerDisplay,
    explanation: review.explanation,
    finalRatingLabel: formatHistoryLabel(review.finalRating),
    nextDueLabel: formatDueLabel(review.nextDueAt),
    previousDueLabel: formatDueLabel(review.previousDueAt),
    previousStateLabel: formatNullableHistoryLabel(review.previousState),
    responseTimeLabel: formatResponseTime(review.responseMs),
    result: review.result === "CORRECT" ? "correct" : "incorrect",
    resultLabel: formatReviewResult(review.result),
    reviewedFullLabel: formatReviewFull(review.reviewedAt),
    reviewedDayLabel: formatReviewDay(review.reviewedAt),
    reviewedTimeLabel: formatReviewTime(review.reviewedAt),
    skillId: review.skillId,
    skillTitle: review.skillTitle,
    nextStateLabel: formatNullableHistoryLabel(review.nextState),
  };
}

function formatReviewDay(date: Date) {
  return date.toLocaleDateString("en-US", {
    day: "numeric",
    month: "short",
  });
}

function formatReviewTime(date: Date) {
  return date.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatReviewFull(date: Date) {
  return date.toLocaleString("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  });
}
