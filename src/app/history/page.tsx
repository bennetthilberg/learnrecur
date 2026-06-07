import { auth, currentUser } from "@clerk/nextjs/server";
import Link from "next/link";

import {
  getPracticeHistory,
  type PracticeHistoryReview,
} from "@/lib/practice/history";
import {
  formatDueLabel,
  formatHistoryEnum,
  formatNullableHistoryEnum,
  formatResponseTime,
  formatReviewDate,
  formatReviewResult,
} from "@/lib/practice/history-formatters";
import { ensureDatabaseUser } from "@/lib/users";

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
            A compact record of completed reviews, deterministic grading, and
            the FSRS schedule transition after each answer.
          </p>
        </div>
        <div className="dashboardHeaderActions">
          <Link className="secondaryButton" href="/dashboard">
            Back to dashboard
          </Link>
          <Link className="primaryButton" href="/practice">
            Start practice
          </Link>
        </div>
      </header>

      <section className="skillPanel historyPanel" aria-labelledby="review-history-title">
        <div className="skillPanelHeader">
          <div>
            <p className="eyebrow">Completed reviews</p>
            <h2 id="review-history-title">Latest scheduled review events</h2>
          </div>
          <span className="dashboardChip">{formatCount(history.reviews.length)}</span>
        </div>

        {history.reviews.length === 0 ? (
          <div className="dashboardEmptyState">
            <h3>No completed reviews yet.</h3>
            <p>
              Finish a practice item and continue to save the first review log
              here.
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
            <th scope="col">Schedule</th>
          </tr>
        </thead>
        <tbody>
          {reviews.map((review) => (
            <tr key={review.id}>
              <td data-label="Reviewed">
                <span className="historyPrimaryText">{formatReviewDate(review.reviewedAt)}</span>
              </td>
              <td data-label="Skill">
                <Link className="historySkillLink" href={`/skills/${review.skillId}`}>
                  {review.skillTitle}
                </Link>
                <span className="historySubText">
                  {review.collectionName ?? "Uncollected"} / {formatAnswerKind(review.answerKind)}
                </span>
              </td>
              <td data-label="Result">
                <span
                  className="dashboardChip"
                  data-tone={review.result === "CORRECT" ? "ready" : "neutral"}
                >
                  {formatReviewResult(review.result)}
                </span>
                <span className="historySubText">Answer: {review.correctAnswerDisplay}</span>
                <span className="historySubText">{formatResponseTime(review.responseMs)}</span>
              </td>
              <td data-label="Rating">
                <span className="historyPrimaryText">{formatHistoryEnum(review.finalRating)}</span>
                <span className="historySubText">
                  {formatNullableHistoryEnum(review.previousState)} to{" "}
                  {formatNullableHistoryEnum(review.nextState)}
                </span>
              </td>
              <td data-label="Schedule">
                <span className="historyPrimaryText">{formatDueLabel(review.nextDueAt)}</span>
                <span className="historySubText">
                  Previous: {formatDueLabel(review.previousDueAt)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatAnswerKind(kind: PracticeHistoryReview["answerKind"]) {
  return formatHistoryEnum(kind).replace("multiple choice", "choice");
}

function formatCount(count: number) {
  return new Intl.NumberFormat("en-US").format(count);
}
