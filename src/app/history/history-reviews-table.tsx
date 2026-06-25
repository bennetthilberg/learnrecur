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
};

export function HistoryReviewsTable({ reviews }: { reviews: HistoryReviewRow[] }) {
  const [selectedReview, setSelectedReview] = useState<HistoryReviewRow | null>(null);

  return (
    <>
      <div className="historySimpleTableWrap">
        <Table className="historySimpleTable">
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Reviewed</Table.Th>
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
                <Table.Td data-label="Reviewed">
                  <span className="historyDateText">{review.reviewedDayLabel}</span>
                  <span className="historySubText">{review.reviewedTimeLabel}</span>
                </Table.Td>
                <Table.Td data-label="Skill">
                  <span className="historySkillName">{review.skillTitle}</span>
                  <span className="historyMetaLine">
                    <span>{review.collectionName}</span>
                    <span>{review.answerKindLabel}</span>
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
        <p>{review.reviewedFullLabel}</p>
      </div>

      <section className="historyReviewAnswer" aria-labelledby="history-review-answer-title">
        <h4 id="history-review-answer-title">Correct answer</h4>
        <p>
          <MathText text={review.correctAnswerDisplay} />
        </p>
      </section>

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
        <Link className="secondaryButton" href={`/skills/${review.skillId}`}>
          Open skill
        </Link>
      </div>
    </div>
  );
}
