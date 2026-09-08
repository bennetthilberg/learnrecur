"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";

import { AnswerKind, FsrsRating } from "@/generated/prisma/enums";
import {
  MAX_MATH_EXPRESSION_LENGTH,
  MAX_NUMERIC_ANSWER_LENGTH,
  MAX_TEXT_ANSWER_LENGTH,
} from "@/lib/answer-limits";

import {
  commitCustomPracticeAnswerAction,
  previewCustomPracticeAnswerAction,
  resumeCustomPracticeSessionAction,
  stopCustomPracticeSessionAction,
} from "./actions";
import { MathText } from "./math-text";
import type {
  CustomPracticeClientPreviewResult,
  CustomPracticeClientView,
} from "./types";

export function CustomPracticeClient({
  initialView,
}: {
  initialView: CustomPracticeClientView;
}) {
  const [view, setView] = useState(initialView);
  const [answer, setAnswer] = useState("");
  const [feedback, setFeedback] = useState<CustomPracticeClientPreviewResult | null>(null);
  const [manualRating, setManualRating] = useState<FsrsRating>(FsrsRating.GOOD);
  const [pending, setPending] = useState<"check" | "save" | "stop" | "resume" | null>(null);
  const [revealingCueSeen, setRevealingCueSeen] = useState(
    !(initialView.status === "ready" && initialView.session.mixedReview),
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const startedAt = useRef<number | null>(null);
  const submittedResponseMs = useRef<number | null>(null);

  const readyItem = view.status === "ready" ? view.item : null;
  const activeSessionId = view.status === "ready" ? view.session.id : null;
  const sessionId = view.session?.id ?? null;
  const presentedItemKey = readyItem?.itemKey ?? null;

  useEffect(() => {
    if (presentedItemKey === null) {
      startedAt.current = null;
      submittedResponseMs.current = null;
      return;
    }

    startedAt.current = performance.now();
    submittedResponseMs.current = null;
  }, [presentedItemKey]);

  const handleCheck = () => {
    if (!readyItem || answer.trim().length === 0 || pending) return;
    const responseMs =
      startedAt.current === null
        ? 0
        : Math.max(0, Math.round(performance.now() - startedAt.current));
    submittedResponseMs.current = responseMs;
    setPending("check");
    setActionError(null);
    void previewCustomPracticeAnswerAction({
      sessionId: activeSessionId ?? "",
      itemKey: readyItem.itemKey,
      exerciseId: readyItem.exerciseId,
      submittedAnswer: answer,
      responseMs,
    })
      .then((result) => {
        setFeedback(result);
        if (result.status === "checked") {
          setManualRating(result.answerCheck.isCorrect ? FsrsRating.GOOD : FsrsRating.AGAIN);
        }
      })
      .catch(() => setActionError("Could not check this answer. Try again."))
      .finally(() => setPending(null));
  };

  const handleSave = () => {
    if (!readyItem || !feedback || feedback.status !== "checked" || pending) return;
    setPending("save");
    setActionError(null);
    void commitCustomPracticeAnswerAction({
      sessionId: activeSessionId ?? "",
      itemKey: readyItem.itemKey,
      exerciseId: readyItem.exerciseId,
      submittedAnswer: answer,
      responseMs: submittedResponseMs.current ?? 0,
      manualRating: view.status === "ready" && view.session.mode === "SCHEDULED" && feedback.answerCheck.isCorrect ? manualRating : null,
      reducedRuleCues: view.status === "ready" && view.session.mixedReview && !revealingCueSeen,
    })
      .then((result) => {
        if (result.status === "committed") {
          setView(result.next);
          setRevealingCueSeen(
            result.next.status !== "ready" || !result.next.session.mixedReview,
          );
          setAnswer("");
          setFeedback(null);
          setManualRating(FsrsRating.GOOD);
          startedAt.current = null;
          return;
        }
        setFeedback({ status: "unavailable", message: result.message });
      })
      .catch(() => setActionError("Could not save this answer. Try again."))
      .finally(() => setPending(null));
  };

  const handleStop = () => {
    if (!sessionId || pending) return;
    setPending("stop");
    setActionError(null);
    void stopCustomPracticeSessionAction({ sessionId })
      .then((result) => {
        setView(result);
        setRevealingCueSeen(true);
        setAnswer("");
        setFeedback(null);
        startedAt.current = null;
      })
      .catch(() => setActionError("Could not stop this session. Try again."))
      .finally(() => setPending(null));
  };

  const handleResume = () => {
    if (!sessionId || pending) return;
    setPending("resume");
    setActionError(null);
    void resumeCustomPracticeSessionAction({ sessionId })
      .then((result) => {
        setView(result);
        setRevealingCueSeen(
          result.status !== "ready" || !result.session.mixedReview,
        );
        setAnswer("");
        setFeedback(null);
        startedAt.current = null;
      })
      .catch(() => setActionError("Could not resume this session. Try again."))
      .finally(() => setPending(null));
  };

  if (view.status !== "ready") {
    return (
      <section className="practiceFrame practiceEmpty customPracticeState" aria-live="polite">
        <p className="practiceEyebrow">Custom session</p>
        <h1>
          {view.status === "completed"
            ? "Session complete."
            : view.status === "stopped"
              ? "Session paused."
              : view.status === "preparing"
                ? "Exercises are still preparing."
                : view.status === "daily-limit"
                  ? "Daily new-skill limit reached."
                  : "This session is unavailable."}
        </h1>
        <p>{view.message}</p>
        {actionError ? <p className="skillFormMessage" data-tone="error" role="alert">{actionError}</p> : null}
        {view.session ? (
          <p className="practiceMetaSummary tnum">
            {view.session.completedCount} of {view.session.targetCount} exercises · {formatMode(view.session.mode)}
          </p>
        ) : null}
        <div className="practiceCompleteActions">
          {view.status === "stopped" ? (
            <button className="primaryButton" type="button" onClick={handleResume} disabled={pending !== null}>
              {pending === "resume" ? "Resuming" : "Resume session"}
            </button>
          ) : null}
          <Link className="primaryButton" href="/practice/custom">Set up another session</Link>
          <Link className="secondaryButton" href="/practice">Return to normal practice</Link>
          <Link className="secondaryButton" href="/practice/attention">Needs attention</Link>
        </div>
      </section>
    );
  }

  const exercise = view.item;
  const isChoice = exercise.answerKind === AnswerKind.CHOICE;
  const isMath = exercise.answerKind === AnswerKind.MATH;
  const isNumeric = exercise.answerKind === AnswerKind.NUMERIC;
  const checked = feedback?.status === "checked" ? feedback : null;
  const isCorrect = checked?.answerCheck.isCorrect === true;
  const session = view.session;

  return (
    <>
      <div className="practiceScopeBar customPracticeScopeBar" aria-label="Custom practice session">
        <span>Custom session</span>
        <strong>{formatMode(session.mode)}</strong>
        <span className="tnum">{session.completedCount} of {session.targetCount}</span>
        <button className="quietButton" type="button" onClick={handleStop} disabled={pending !== null || checked !== null}>
          {pending === "stop" ? "Stopping" : "Stop session"}
        </button>
        <Link href="/practice/attention">Needs attention</Link>
      </div>
      <section className="practiceFrame customPracticeClient" aria-labelledby="custom-practice-title">
        <div className="practiceMetaRow">
          <div>
            <p className="practiceEyebrow">Custom session</p>
            <h1 id="custom-practice-title">{session.mixedReview && !checked ? "Review" : exercise.skillTitle}</h1>
            <p className="practiceMetaSummary tnum">Exercise {session.completedCount + 1} of {session.targetCount}</p>
          </div>
        </div>
        <article className="practicePromptPanel">
          <p><MathText formatBlanks text={exercise.prompt} /></p>
        </article>
        {actionError ? <p className="skillFormMessage" data-tone="error" role="alert">{actionError}</p> : null}
        {isChoice ? (
          <div className="choiceGrid" role="radiogroup" aria-label="Answer choices">
            {exercise.choices.map((choice, index) => (
              <button
                className="choiceCard"
                data-selected={answer === choice.id ? "true" : "false"}
                data-tone={checked && (answer === choice.id || checked.correctChoiceId === choice.id) ? checked.answerCheck.isCorrect || checked.correctChoiceId === choice.id ? "correct" : "incorrect" : "neutral"}
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={answer === choice.id}
                disabled={feedback !== null || pending !== null}
                onClick={() => setAnswer(choice.id)}
              >
                <span className="choiceIndex" aria-hidden="true">{index + 1}</span>
                <span>{choice.label}</span>
              </button>
            ))}
          </div>
        ) : (
          <label className="exactAnswerField">
            <span>Your answer</span>
            <input
              value={answer}
              inputMode={isNumeric ? "decimal" : "text"}
              autoComplete="off"
              maxLength={isMath ? MAX_MATH_EXPRESSION_LENGTH : isNumeric ? MAX_NUMERIC_ANSWER_LENGTH : MAX_TEXT_ANSWER_LENGTH}
              disabled={feedback !== null || pending !== null}
              placeholder={isMath ? "Enter a math expression" : isNumeric ? "Enter a number or fraction" : "Type your answer"}
              onChange={(event) => setAnswer(event.target.value)}
            />
          </label>
        )}
        {feedback === null ? (
          <div className="practiceActions">
            <button className="primaryButton" type="button" onClick={handleCheck} disabled={!answer.trim() || pending !== null}>
              {pending === "check" ? "Checking" : "Check"}
            </button>
          </div>
        ) : null}
        {feedback && feedback.status !== "checked" ? (
          <section className="practiceFeedback" data-tone="incorrect" aria-live="polite" role="alert">
            <p>{feedback.message}</p>
            <Link href="/practice/custom">Set up another session</Link>
          </section>
        ) : null}
        {checked ? (
          <section className="practiceFeedback" data-tone={isCorrect ? "correct" : "incorrect"} aria-live="polite" role="status">
            <h2>{isCorrect ? "Correct." : "Not quite."}</h2>
            <p><strong>Correct answer:</strong> <MathText text={checked.correctAnswerDisplay} /></p>
            {checked.explanation ? <p><MathText text={checked.explanation} /></p> : null}
          </section>
        ) : null}
        {checked && session.mode === "SCHEDULED" && isCorrect ? (
          <fieldset className="ratingOverride">
            <legend>Review rating</legend>
            <div role="radiogroup" aria-label="Review rating">
              {[FsrsRating.HARD, FsrsRating.GOOD, FsrsRating.EASY].map((rating) => (
                <button className="ratingButton" key={rating} type="button" role="radio" aria-checked={manualRating === rating} data-selected={manualRating === rating ? "true" : "false"} onClick={() => setManualRating(rating)}>
                  {formatRating(rating)}
                </button>
              ))}
            </div>
          </fieldset>
        ) : null}
        {checked ? (
          <div className="practiceActions">
            <button className="primaryButton" type="button" onClick={handleSave} disabled={pending !== null}>
              {pending === "save" ? "Saving" : session.mode === "PRACTICE_ONLY" ? "Save practice" : "Continue"}
            </button>
          </div>
        ) : null}
      </section>
    </>
  );
}

function formatMode(mode: "PRACTICE_ONLY" | "SCHEDULED"): string {
  return mode === "PRACTICE_ONLY" ? "Practice only" : "Scheduled review";
}

function formatRating(rating: FsrsRating): string {
  return rating === FsrsRating.HARD ? "Hard" : rating === FsrsRating.EASY ? "Easy" : "Good";
}
