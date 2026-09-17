"use client";

import { CheckCircle, WarningCircle } from "@phosphor-icons/react/dist/ssr";
import { useState, useTransition, type FormEvent } from "react";
import Link from "next/link";

import { formatHistoryLabel } from "@/lib/practice/history-formatters";
import type { ExerciseQualityIssue } from "@/lib/practice/quality-issues";
import { resolveExerciseIssueAction } from "./actions";

type Resolution = "confirmed" | "rejected" | "inconclusive";
type LocalState = "idle" | "pending" | "saved" | "stale" | "already-resolved" | "failed";

export function ExerciseQualityIssueCard({ issue }: { issue: ExerciseQualityIssue }) {
  const [resolution, setResolution] = useState<Resolution>("confirmed");
  const [reason, setReason] = useState("");
  const [state, setState] = useState<LocalState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const titleId = `quality-issue-${issue.exerciseId}-title`.replace(/[^a-zA-Z0-9_-]/g, "-");
  const latestAttempt = issue.attempts[0] ?? null;
  const issueVersion = new Date(issue.issueVersion).toISOString();

  function submitDecision(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanReason = reason.trim();
    if (cleanReason.length < 3) {
      setState("failed");
      setMessage("Add a reason of at least three characters.");
      return;
    }

    const key = idempotencyKey ?? `quality-resolution-${issue.exerciseId}-${Date.now()}`;
    if (!idempotencyKey) setIdempotencyKey(key);
    setState("pending");
    setMessage(null);
    startTransition(async () => {
      const result = await resolveExerciseIssueAction({
        exerciseId: issue.exerciseId,
        resolution,
        reason: cleanReason,
        expectedUpdatedAt: issueVersion,
        idempotencyKey: key,
      });
      if (result.status === "saved") {
        setState("saved");
        setMessage(
          result.result.idempotent
            ? "This decision was already saved."
            : resolution === "confirmed"
              ? `Excluded ${result.result.affectedReviewCount} scheduled review${result.result.affectedReviewCount === 1 ? "" : "s"} from the replay.`
              : "Decision saved. The report's evidence was not excluded.",
        );
        return;
      }
      setState(result.status === "invalid" ? "failed" : result.status);
      setMessage(result.message);
    });
  }

  return (
    <article
      aria-labelledby={titleId}
      className="practiceAttentionIssueCard"
      data-state={state}
      data-testid="quality-issue"
    >
      <div className="practiceAttentionIssueHeader">
        <span className="practiceAttentionIssueIcon" aria-hidden="true">
          {state === "saved" ? <CheckCircle size={22} weight="bold" /> : <WarningCircle size={22} weight="bold" />}
        </span>
        <div>
          <p className="practiceAttentionKind">Exercise report</p>
          <h2 id={titleId}>{issue.skillTitle}</h2>
          <p className="practiceAttentionMeta">
            {issue.collectionName ?? "Uncollected"} · {formatHistoryLabel(issue.answerKind)} · {issue.flags.length} report{issue.flags.length === 1 ? "" : "s"}
          </p>
        </div>
      </div>

      <div className="practiceAttentionIssuePrompt">
        <p className="practiceAttentionIssueLabel">Prompt</p>
        <p><span className="practiceAttentionIssuePromptText">{issue.prompt}</span></p>
        {latestAttempt ? (
          <p className="practiceAttentionIssueAnswer">
            <span>Your latest answer</span> {latestAttempt.submittedAnswerDisplay}
            {latestAttempt.practiceOnly ? <em>Practice-only</em> : null}
          </p>
        ) : null}
        <p className="practiceAttentionIssueExpected">
          <span>Expected answer</span> {issue.correctAnswerDisplay}
        </p>
      </div>

      <ul className="practiceAttentionIssueReasons" aria-label="Report reasons">
        {issue.flags.map((flag) => (
          <li key={flag.id}>
            <strong>{formatHistoryLabel(flag.reason)}</strong>
            {flag.note ? <span>{flag.note}</span> : null}
          </li>
        ))}
      </ul>

      {state === "saved" || state === "already-resolved" ? (
        <div className="practiceAttentionIssueStatus" role="status">
          <strong>{state === "already-resolved" ? "Decision already saved" : "Decision saved"}</strong>
          <p>{message}</p>
          <p>Original attempts and logs remain in history with their correction annotation.</p>
          <Link className="textButton" href="/history">Open practice history</Link>
        </div>
      ) : (
        <form className="practiceAttentionIssueForm" onSubmit={submitDecision}>
          <div className="practiceAttentionIssueFields">
            <label>
              <span>Decision</span>
              <select
                aria-label="Quality decision"
                disabled={pending}
                onChange={(event) => setResolution(event.target.value as Resolution)}
                value={resolution}
              >
                <option value="confirmed">Confirm defect</option>
                <option value="rejected">Reject report</option>
                <option value="inconclusive">Mark inconclusive</option>
              </select>
            </label>
            <label>
              <span>Decision reason</span>
              <textarea
                aria-label="Decision reason"
                disabled={pending}
                maxLength={500}
                minLength={3}
                onChange={(event) => setReason(event.target.value)}
                placeholder="What did you verify?"
                required
                rows={2}
                value={reason}
              />
            </label>
          </div>
          <div className="practiceAttentionIssueActions">
            <button className="primaryButton" disabled={pending} type="submit">
              {pending ? "Saving decision…" : resolution === "confirmed" ? "Exclude faulty exercise from scheduling" : "Save decision"}
            </button>
            <Link className="textButton" href={`/history?mode=scheduled&skillId=${encodeURIComponent(issue.skillId)}`}>
              View skill history
            </Link>
          </div>
          {message ? <p className="practiceAttentionIssueError" role="alert">{message}</p> : null}
        </form>
      )}
    </article>
  );
}
