import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

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

import { SkillsTopbar } from "../skills/skills-topbar";
import {
  HistoryReviewsTable,
  type HistoryReviewRow,
} from "./history-reviews-table";

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

  const reviewRows = history.reviews.map(toHistoryReviewRow);

  return (
    <main className="skillShell historyShell">
      <SkillsTopbar current="history" />

      <header className="skillHeader historyHeader">
        <div>
          <h1>History</h1>
          <p>
            See your recent review results, ratings, and next due dates. Choose
            Details for the answer, response time, and schedule change.
          </p>
        </div>
      </header>

      <section className="skillPanel historyPanel" aria-labelledby="review-history-title">
        <div className="historyPanelIntro">
          <h2 id="review-history-title">Completed reviews</h2>
          <p>Showing {formatCount(history.reviews.length)} most recent.</p>
        </div>

        {history.reviews.length === 0 ? (
          <div className="dashboardEmptyState">
            <h3>No completed reviews yet</h3>
            <p>
              Answer a practice exercise, check it, then continue to record your
              first completed review.
            </p>
            <Link className="secondaryButton" href="/practice">
              Open practice
            </Link>
          </div>
        ) : (
          <HistoryReviewsTable reviews={reviewRows} />
        )}
      </section>
    </main>
  );
}

function formatAnswerKind(kind: PracticeHistoryReview["answerKind"]) {
  return formatHistoryEnum(kind).replace("multiple choice", "choice");
}

function toHistoryReviewRow(review: PracticeHistoryReview): HistoryReviewRow {
  return {
    id: review.id,
    answerKindLabel: formatAnswerKind(review.answerKind),
    collectionName: review.collectionName ?? "Uncollected",
    correctAnswerDisplay: review.correctAnswerDisplay,
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
  });
}

function formatCount(count: number) {
  return new Intl.NumberFormat("en-US").format(count);
}
