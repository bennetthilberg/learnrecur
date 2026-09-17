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
    finalRatingLabel: review.finalRating ? formatHistoryLabel(review.finalRating) : "Practice only",
    nextDueLabel: review.eventKind === "practice-only" ? "No schedule change" : formatDueLabel(review.nextDueAt),
    previousDueLabel: review.eventKind === "practice-only" ? "Not scheduled" : formatDueLabel(review.previousDueAt),
    previousStateLabel: review.eventKind === "practice-only" ? "Not scheduled" : formatNullableHistoryLabel(review.previousState),
    responseTimeLabel: formatResponseTime(review.responseMs),
    result: review.result === "CORRECT" ? "correct" : "incorrect",
    resultLabel: formatReviewResult(review.result),
    reviewedFullLabel: formatReviewFull(review.reviewedAt),
    reviewedDayLabel: formatReviewDay(review.reviewedAt),
    reviewedTimeLabel: formatReviewTime(review.reviewedAt),
    skillId: review.skillId,
    skillTitle: review.skillTitle,
    nextStateLabel: review.eventKind === "practice-only" ? "Not scheduled" : formatNullableHistoryLabel(review.nextState),
    eventKind: review.eventKind,
    eventKindLabel: review.eventKind === "practice-only" ? "Practice-only exposure" : "Scheduled review",
    evidenceCorrectionStatus: review.evidenceCorrectionStatus,
    evidenceCorrectionNote: review.evidenceCorrectionNote,
    qualityReportReasons: review.qualityReportReasons.map(formatHistoryLabel),
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
