import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

import { PanelHeaderCount } from "@/components/app/panel-header-count";
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
        <section className="dashboardSetupPanel" aria-labelledby="history-setup-title">
          <p className="eyebrow">History</p>
          <h1 id="history-setup-title">Database setup needs attention.</h1>
          <p>{databaseUser.message}</p>
        </section>
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

      <header className="skillHeader">
        <div>
          <p className="eyebrow">History</p>
          <h1>Review ledger.</h1>
          <p>
            A compact record of completed reviews, grading outcomes, and how each
            answer changed the memory schedule.
          </p>
        </div>
        <div className="dashboardHeaderActions">
          <Link className="primaryButton" href="/practice">
            Start practice
          </Link>
          <Link className="secondaryButton" href="/dashboard">
            Back to dashboard
          </Link>
        </div>
      </header>

      <section className="skillPanel historyPanel" aria-labelledby="review-history-title">
        <div className="skillPanelHeader">
          <div>
            <p className="eyebrow">Completed reviews</p>
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
            <h3>No completed reviews yet.</h3>
            <p>
              Answer a practice exercise, check it, then continue to record your
              first completed review.
            </p>
            <Link className="secondaryButton" href="/practice">
              Open practice
            </Link>
          </div>
        ) : (
          <HistoryTable reviews={history.reviews} />
        )}
      </section>
    </main>
  );
}

function HistoryTable({ reviews }: { reviews: PracticeHistoryReview[] }) {
  return (
    <div className="historyTableWrapper">
      <table className="historyTable">
        <thead>
          <tr>
            <th scope="col">Reviewed</th>
            <th scope="col">Skill</th>
            <th scope="col">Result</th>
            <th scope="col">Rating</th>
            <th scope="col">Next due</th>
          </tr>
        </thead>
        <tbody>
          {reviews.map((review) => (
            <tr key={review.id}>
              <td data-label="Reviewed">
                <span className="historyDateText">{formatReviewDay(review.reviewedAt)}</span>
                <span className="historySubText">{formatReviewTime(review.reviewedAt)}</span>
              </td>
              <td data-label="Skill">
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
              </td>
              <td data-label="Result">
                <div className="historyResultStack">
                  <span
                    className="dashboardChip"
                    data-tone={review.result === "CORRECT" ? "ready" : "danger"}
                  >
                    {formatReviewResult(review.result)}
                  </span>
                  <span className="historyAnswerLine">
                    <span>Correct answer</span>
                    <strong>
                      <MathText text={review.correctAnswerDisplay} />
                    </strong>
                  </span>
                </div>
                <span className="historySubText">{formatResponseTime(review.responseMs)}</span>
              </td>
              <td data-label="Rating">
                <span className="historyPrimaryText">{formatHistoryLabel(review.finalRating)}</span>
                <HistoryStateTransition review={review} />
              </td>
              <td data-label="Next due">
                <span className="historyPrimaryText">Next: {formatDueLabel(review.nextDueAt)}</span>
                <HistoryDueTransition review={review} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
