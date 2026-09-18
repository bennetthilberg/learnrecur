"use client";

import { Badge, Modal, Table } from "@mantine/core";
import Link from "next/link";
import { useState } from "react";

import { MathText } from "../practice/math-text";

export type HistoryReviewRow = {
  id: string;
  answerKindLabel: string;
  collectionName: string;
  correctAnswerDisplay: string;
  prompt: string;
  submittedAnswerDisplay: string;
  explanation: string | null;
  finalRatingLabel: string;
  nextDueLabel: string;
  previousDueLabel: string;
  previousStateLabel: string;
  responseTimeLabel: string;
  result: "correct" | "incorrect";
  resultLabel: string;
  reviewedFullLabel: string;
  reviewedDayLabel: string;
  reviewedTimeLabel: string;
  skillId: string;
  skillTitle: string;
  nextStateLabel: string;
  eventKind: "scheduled" | "practice-only";
  eventKindLabel: string;
  evidenceCorrectionStatus: string;
  evidenceCorrectionNote: string | null;
  qualityReportReasons: string[];
};

export function HistoryReviewsTable({ reviews }: { reviews: HistoryReviewRow[] }) {
  const [selectedReview, setSelectedReview] = useState<HistoryReviewRow | null>(null);

  return (
    <>
      <div className="historySimpleTableWrap">
        <Table className="historySimpleTable">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Activity</Table.Th>
              <Table.Th>Skill</Table.Th>
              <Table.Th>Result</Table.Th>
              <Table.Th>Rating</Table.Th>
              <Table.Th>Next due</Table.Th>
              <Table.Th aria-label="Review details" />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {reviews.map((review) => (
              <Table.Tr key={review.id}>
                <Table.Td data-label="Activity">
                  <span className="historyDateText">{review.reviewedDayLabel}</span>
                  <span className="historySubText">{review.reviewedTimeLabel}</span>
                </Table.Td>
                <Table.Td data-label="Skill">
                  <span className="historySkillName">{review.skillTitle}</span>
                  <span className="historyMetaLine">
                    <span>{review.collectionName}</span>
                    <span>{review.answerKindLabel}</span>
                    <span className="historyEventLabel">{review.eventKindLabel}</span>
                  </span>
                </Table.Td>
                <Table.Td data-label="Result">
                  <Badge
                    className="historyResultBadge"
                    color={review.result === "correct" ? "leaf" : "amber"}
                    radius="sm"
                    size="sm"
                    variant="outline"
                  >
                    {review.resultLabel}
                  </Badge>
                </Table.Td>
                <Table.Td data-label="Rating">
                  <span className="historyPrimaryText">{review.finalRatingLabel}</span>
                </Table.Td>
                <Table.Td data-label="Next due">
                  <span className="historyPrimaryText">{review.nextDueLabel}</span>
                </Table.Td>
                <Table.Td data-label="Details">
                  <button
                    aria-label={`Open review details for ${review.skillTitle} reviewed ${review.reviewedFullLabel}`}
                    className="historyDetailsButton"
                    onClick={() => setSelectedReview(review)}
                    type="button"
                  >
                    Details
                  </button>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </div>

      <Modal
        centered
        classNames={{
          body: "historyReviewModalBody",
          content: "historyReviewModalContent",
          header: "historyReviewModalHeader",
          inner: "historyReviewModalInner",
          overlay: "historyReviewModalOverlay",
          root: "historyReviewModalRoot",
          title: "historyReviewModalTitle",
        }}
        onClose={() => setSelectedReview(null)}
        opened={Boolean(selectedReview)}
        closeButtonProps={{ "aria-label": "Close review details" }}
        radius="md"
        size="lg"
        title="Review details"
        transitionProps={{ duration: 0 }}
        withinPortal
        zIndex={2200}
      >
        {selectedReview ? <HistoryReviewDetails review={selectedReview} /> : null}
      </Modal>
    </>
  );
}

function HistoryReviewDetails({ review }: { review: HistoryReviewRow }) {
  return (
    <div className="historyReviewDetails">
      <div className="historyReviewDetailsHeader">
        <Badge
          className="historyResultBadge"
          color={review.result === "correct" ? "leaf" : "amber"}
          radius="sm"
          size="sm"
          variant="outline"
        >
          {review.resultLabel}
        </Badge>
        <h3>{review.skillTitle}</h3>
        <span className="historyEventLabel">{review.eventKindLabel}</span>
        <p>{review.reviewedFullLabel}</p>
      </div>

      {review.eventKind === "practice-only" ? (
        <aside className="historyPracticeOnlyNotice" role="status">
          <strong>Practice-only exposure</strong>
          <p>This activity was recorded for your history but did not change the FSRS schedule.</p>
        </aside>
      ) : null}

      {review.evidenceCorrectionStatus !== "NOT_REQUIRED" ? (
        <aside className="historyCorrectionNotice" role="status">
          <strong>{correctionStatusLabel(review.evidenceCorrectionStatus)}</strong>
          <p>{review.evidenceCorrectionNote ?? correctionStatusDescription(review.evidenceCorrectionStatus)}</p>
          <p>Your original answer and result remain available for audit.</p>
        </aside>
      ) : null}

      {review.qualityReportReasons.length > 0 ? (
        <p className="historyQualityReason">Reported issue: {review.qualityReportReasons.join(", ")}</p>
      ) : null}

      <section className="historyReviewAnswer" aria-label="Question">
        <h4>Question</h4>
        <p><MathText formatBlanks text={review.prompt} /></p>
      </section>
      <section className="historyReviewAnswer" aria-label="Your answer">
        <h4>Your answer</h4>
        <p><MathText text={review.submittedAnswerDisplay} /></p>
      </section>
      <section className="historyReviewAnswer" aria-labelledby="history-review-answer-title">
        <h4 id="history-review-answer-title">Correct answer</h4>
        <p>
          <MathText text={review.correctAnswerDisplay} />
        </p>
      </section>

      {review.explanation ? <section className="historyReviewAnswer" aria-label="Explanation">
        <h4>Explanation</h4><p><MathText text={review.explanation} /></p>
      </section> : <p>No explanation was saved for this exercise.</p>}
      <dl className="historyReviewDetailGrid">
        <div>
          <dt>Rating</dt>
          <dd>{review.finalRatingLabel}</dd>
        </div>
        <div>
          <dt>Response</dt>
          <dd>{review.responseTimeLabel}</dd>
        </div>
        <div>
          <dt>Schedule</dt>
          <dd>
            {review.previousDueLabel} <span aria-hidden="true">&rarr;</span> {review.nextDueLabel}
          </dd>
        </div>
        <div>
          <dt>Memory stage</dt>
          <dd>
            {review.previousStateLabel} <span aria-hidden="true">&rarr;</span> {review.nextStateLabel}
          </dd>
        </div>
        <div>
          <dt>Collection</dt>
          <dd>{review.collectionName}</dd>
        </div>
        <div>
          <dt>Answer type</dt>
          <dd>{review.answerKindLabel}</dd>
        </div>
      </dl>

      <div className="historyReviewModalActions">
        <Link className="primaryButton" href={`/skills/${review.skillId}`}>
          Open skill
        </Link>
      </div>
    </div>
  );
}

function correctionStatusLabel(status: string) {
  switch (status) {
    case "COMPLETE":
      return "Schedule evidence corrected";
    case "PENDING":
      return "Schedule correction pending";
    case "IN_PROGRESS":
      return "Schedule correction in progress";
    case "BLOCKED":
      return "Schedule correction blocked";
    default:
      return "Schedule correction status";
  }
}

function correctionStatusDescription(status: string) {
  switch (status) {
    case "COMPLETE":
      return "This retained record was excluded from the skill's FSRS replay.";
    case "PENDING":
      return "This retained record is awaiting schedule correction.";
    case "IN_PROGRESS":
      return "This retained record is being excluded from the skill's FSRS replay.";
    case "BLOCKED":
      return "Schedule correction needs attention before the skill's FSRS replay can be completed.";
    default:
      return "This retained record has a schedule correction status that needs attention.";
  }
}
