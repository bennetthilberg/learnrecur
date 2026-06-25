import { auth, currentUser } from "@clerk/nextjs/server";
import { Badge, Card, Table } from "@radix-ui/themes";
import Link from "next/link";

import { PanelHeaderCount } from "@/components/app/panel-header-count";
import { PressLink } from "@/components/app/open-water";
import { UserStatusPanel } from "@/components/app/user-status-panel";
import {
  getPracticeHistory,
  type PracticeHistoryReview,
} from "@/lib/practice/history";
import {
  formatDueLabel,
  formatHistoryEnum,
  formatHistoryLabel,
  formatNullableHistoryLabel,
  formatResponseTime,
  formatReviewResult,
} from "@/lib/practice/history-formatters";
import { ensureDatabaseUser } from "@/lib/users";

import { MathText } from "../practice/math-text";
import { SkillsTopbar } from "../skills/skills-topbar";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();

  if (!clerkUser) {
    throw new Error("Clerk returned no authenticated user.");
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);

  if (databaseUser.status !== "ready") {
    return (
      <main className="skillShell">
        <SkillsTopbar current="history" />
        <UserStatusPanel id="history-setup-title" status={databaseUser} />
      </main>
    );
  }

  const history = await getPracticeHistory({
    userId,
    now: new Date(),
  });

  return (
    <main className="skillShell">
      <SkillsTopbar current="history" />

      <header className="skillHeader historyHeader">
        <div>
          <h1>Review ledger</h1>
          <p>
            A compact record of completed reviews, grading outcomes, and how each
            answer changed the memory schedule.
          </p>
        </div>
        <div className="dashboardHeaderActions">
          <PressLink className="secondaryButton" href="/practice" variant="white">
            Open practice
          </PressLink>
          <PressLink className="secondaryButton" href="/dashboard" variant="white">
            Back to dashboard
          </PressLink>
        </div>
      </header>

      <Card asChild className="skillPanel historyPanel" size="3" variant="surface">
        <section aria-labelledby="review-history-title">
          <div className="skillPanelHeader">
            <div>
              <h2 id="review-history-title">Latest completed reviews</h2>
            </div>
            <PanelHeaderCount
              ariaLabel="Review rows shown"
              label="Shown"
              value={formatCount(history.reviews.length)}
            />
          </div>

          {history.reviews.length === 0 ? (
            <div className="dashboardEmptyState">
              <h3>No completed reviews yet</h3>
              <p>
                Answer a practice exercise, check it, then continue to record your
                first completed review.
              </p>
              <PressLink className="secondaryButton" href="/practice" variant="white">
                Open practice
              </PressLink>
            </div>
          ) : (
            <HistoryTable reviews={history.reviews} />
          )}
        </section>
      </Card>
    </main>
  );
}

function HistoryTable({ reviews }: { reviews: PracticeHistoryReview[] }) {
  return (
    <div className="historyTableWrapper">
      <Table.Root className="historyTable" layout="auto" size="2" variant="surface">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell scope="col">Reviewed</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell scope="col">Skill</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell scope="col">Result</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell scope="col">Rating</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell scope="col">Next due</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {reviews.map((review) => (
            <Table.Row key={review.id}>
              <Table.Cell data-label="Reviewed">
                <span className="historyDateText">{formatReviewDay(review.reviewedAt)}</span>
                <span className="historySubText">{formatReviewTime(review.reviewedAt)}</span>
              </Table.Cell>
              <Table.Cell data-label="Skill">
                <Link className="historySkillLink" href={`/skills/${review.skillId}`}>
                  {review.skillTitle}
                </Link>
                <span
                  className="historyMetaLine"
                  aria-label={`${review.collectionName ?? "Uncollected"} collection, ${formatAnswerKind(review.answerKind)} answer kind`}
                >
                  <span>{review.collectionName ?? "Uncollected"}</span>
                  <span>{formatAnswerKind(review.answerKind)}</span>
                </span>
              </Table.Cell>
              <Table.Cell data-label="Result">
                <div className="historyResultStack">
                  <Badge
                    className="dashboardChip"
                    color={review.result === "CORRECT" ? "green" : "red"}
                    data-tone={review.result === "CORRECT" ? "ready" : "danger"}
                    highContrast
                    variant="surface"
                  >
                    {formatReviewResult(review.result)}
                  </Badge>
                  <span className="historyAnswerLine">
                    <span>Correct answer</span>
                    <strong>
                      <MathText text={review.correctAnswerDisplay} />
                    </strong>
                  </span>
                </div>
                <span className="historySubText">{formatResponseTime(review.responseMs)}</span>
              </Table.Cell>
              <Table.Cell data-label="Rating">
                <span className="historyPrimaryText">{formatHistoryLabel(review.finalRating)}</span>
                <HistoryStateTransition review={review} />
              </Table.Cell>
              <Table.Cell data-label="Next due">
                <span className="historyPrimaryText">Next: {formatDueLabel(review.nextDueAt)}</span>
                <HistoryDueTransition review={review} />
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
    </div>
  );
}

function HistoryDueTransition({ review }: { review: PracticeHistoryReview }) {
  const previousDue = formatDueLabel(review.previousDueAt);
  const nextDue = formatDueLabel(review.nextDueAt);

  return (
    <span
      className="historyTransitionText"
      aria-label={`Due date changed from ${previousDue} to ${nextDue}`}
    >
      <span>{previousDue}</span>
      <span className="historyTransitionArrow" aria-hidden="true">
        &rarr;
      </span>
      <span>{nextDue}</span>
    </span>
  );
}

function HistoryStateTransition({ review }: { review: PracticeHistoryReview }) {
  const previousState = formatNullableHistoryLabel(review.previousState);
  const nextState = formatNullableHistoryLabel(review.nextState);

  return (
    <span
      className="historyTransitionText"
      aria-label={`Memory stage changed from ${previousState} to ${nextState}`}
    >
      <span>{previousState}</span>
      <span className="historyTransitionArrow" aria-hidden="true">
        &rarr;
      </span>
      <span>{nextState}</span>
    </span>
  );
}

function formatAnswerKind(kind: PracticeHistoryReview["answerKind"]) {
  return formatHistoryEnum(kind).replace("multiple choice", "choice");
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

function formatCount(count: number) {
  return new Intl.NumberFormat("en-US").format(count);
}
