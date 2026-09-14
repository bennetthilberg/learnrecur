"use client";

import { ActionNotification } from "@/components/app/action-notification";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Link from "next/link";
import { appendPracticeBuffer, PRACTICE_BUFFER_SIZE, PRACTICE_BUFFER_LOW_WATER } from "@/lib/practice/buffer";
import { writeRecovery, type CustomDraft, type Recovery } from "@/lib/practice/recovery";
import { confirmReviewSave, useReviewSaveGuard } from "./use-review-save-guard";
import { getInstantPracticeFeedback } from "@/lib/practice/instant-feedback";

import { AnswerKind, FsrsRating } from "@/generated/prisma/enums";
import {
  MAX_MATH_EXPRESSION_LENGTH,
  MAX_NUMERIC_ANSWER_LENGTH,
  MAX_TEXT_ANSWER_LENGTH,
} from "@/lib/answer-limits";

import {
  flagCustomPracticeExerciseAction,
  preloadCustomPracticeBufferAction,
  commitCustomPracticeAnswerAction,
  resumeCustomPracticeSessionAction,
  stopCustomPracticeSessionAction,
} from "./actions";
import { MathText } from "./math-text";
import { ExerciseReport } from "./exercise-report";
import { RecoveryNotice } from "./recovery-notice";
import { PracticePrompt } from "./practice-prompt";
import type {
  CustomPracticeClientPreviewResult,
  CustomPracticeClientView,
} from "./types";

export function CustomPracticeClient({
  initialView, recoveryKey, initialRecovery,
}: {
  initialView: CustomPracticeClientView;
  recoveryKey?: string;
  initialRecovery?: Recovery<CustomDraft> | null;
}) {
  const restored = initialRecovery?.pending ?? initialRecovery?.current;
  const [showRecovery, setShowRecovery] = useState(Boolean(initialRecovery));
  const [view, setView] = useState(initialView);
  const [answer, setAnswer] = useState(restored?.answer ?? "");
  const [feedback, setFeedback] = useState<CustomPracticeClientPreviewResult | null>(() => restored?.checked ? getInstantPracticeFeedback(restored.view.item, restored.answer) : null);
  const [manualRating, setManualRating] = useState<FsrsRating>(restored?.rating ?? FsrsRating.GOOD);
  const [pending, setPending] = useState<"check" | "save" | "stop" | "resume" | "flag" | null>(null);
  const [reportedExerciseId, setReportedExerciseId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const startedAt = useRef<number | null>(null);
  const submittedResponseMs = useRef<number | null>(null);
  const restoredResponseMs = useRef<number | null>(restored?.responseMs ?? null);

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
    submittedResponseMs.current = restoredResponseMs.current;
    restoredResponseMs.current = null;
  }, [presentedItemKey]);

  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [preloaded, setPreloaded] = useState<Extract<CustomPracticeClientView, { status: "ready" }>[]>([]);
  const preloadRequest = useRef<{ key: string; promise: Promise<CustomPracticeClientView[]> } | null>(null);
  const pendingDraft = useRef<CustomDraft | undefined>(undefined);
  const deferredDraft = useRef<CustomDraft | undefined>(initialRecovery?.pending ? initialRecovery.current : initialRecovery?.deferred);
  const currentDraft = useRef<CustomDraft | undefined>(restored);
  const [protectedDraft, setProtectedDraft] = useState(true);
  const { finishSave, navigationMessage } = useReviewSaveGuard(saving, Boolean(answer) && !protectedDraft);
  useLayoutEffect(() => {
    const current: CustomDraft | undefined = view.status === "ready" ? { view, answer, checked: feedback?.status === "checked", rating: manualRating, responseMs: submittedResponseMs.current } : undefined;
    currentDraft.current = current;
    if (recoveryKey) setProtectedDraft(writeRecovery(recoveryKey, current && (current.answer || pendingDraft.current || deferredDraft.current) ? { current, pending: pendingDraft.current, deferred: deferredDraft.current } : null));
  }, [view, answer, feedback, manualRating, recoveryKey, saving]);
  useEffect(() => {
    if (!activeSessionId || !presentedItemKey || saving || preloaded.length >= PRACTICE_BUFFER_LOW_WATER) return;
    let active = true;
    const key = [presentedItemKey, ...preloaded.map((next) => next.item.itemKey)].join(":");
    if (preloadRequest.current?.key !== key) {
      preloadRequest.current = { key, promise: preloadCustomPracticeBufferAction({
        sessionId: activeSessionId, itemKey: presentedItemKey,
        excludedItemKeys: preloaded.map((next) => next.item.itemKey), limit: PRACTICE_BUFFER_SIZE - preloaded.length,
      }) };
    }
    void preloadRequest.current.promise.then((items) => {
      const next = items.filter((candidate): candidate is Extract<CustomPracticeClientView, { status: "ready" }> => candidate.status === "ready");
      if (active && next.length) setPreloaded((current) => appendPracticeBuffer(current, next, (candidate) => candidate.item.itemKey));
    }).catch(() => {});
    return () => { active = false; };
  }, [activeSessionId, presentedItemKey, saving, preloaded]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") { preloadRequest.current = null; setPreloaded([]); } };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);

  const handleCheck = () => {
    if (!readyItem || answer.trim().length === 0 || pending) return;
    const responseMs =
      startedAt.current === null
        ? 0
        : Math.max(0, Math.round(performance.now() - startedAt.current));
    submittedResponseMs.current = responseMs;
    setActionError(null);
    const result = getInstantPracticeFeedback(readyItem, answer);
    if (result.answerCheck.status !== "correct" && result.answerCheck.status !== "incorrect") {
      setActionError(result.answerCheck.message ?? "Check your answer and try again.");
      return;
    }
    setFeedback(result);
    setManualRating(result.proposedRating ?? FsrsRating.GOOD);
  };

  const handleSave = () => {
    if (!readyItem || !feedback || feedback.status !== "checked" || pending) return;
    if (savingRef.current) return;
    savingRef.current = true;
    pendingDraft.current = currentDraft.current;
    if (recoveryKey && pendingDraft.current) writeRecovery(recoveryKey, { current: pendingDraft.current, pending: pendingDraft.current, deferred: deferredDraft.current });
    setSaving(true);
    const next = preloaded[0] ?? null;
    const responseMs = submittedResponseMs.current ?? 0;
    const restore = (message: string) => {
      if (currentDraft.current?.view.item.itemKey !== readyItem.itemKey) deferredDraft.current = currentDraft.current;
      pendingDraft.current = undefined;
      finishSave(false);
      setShowRecovery(true);
      setPreloaded([]);
      preloadRequest.current = null;
      setView(view); setAnswer(answer); setFeedback(feedback); setManualRating(manualRating);
      submittedResponseMs.current = responseMs;
      if (next) restoredResponseMs.current = responseMs;
      setActionError(message);
    };
    setPreloaded((current) => current.slice(1));
    setActionError(null);
    if (next) { setView(next); setAnswer(""); setFeedback(null); setManualRating(FsrsRating.GOOD); }
    else setPending("save");
    void confirmReviewSave(commitCustomPracticeAnswerAction({
      sessionId: activeSessionId ?? "", itemKey: readyItem.itemKey, exerciseId: readyItem.exerciseId,
      submittedAnswer: answer, responseMs,
      manualRating: view.status === "ready" && view.session.mode === "SCHEDULED" && feedback.answerCheck.isCorrect ? manualRating : null,
      reducedRuleCues: true,
    })).then((result) => {
      if (result.status !== "committed") { restore(result.message); return; }
      pendingDraft.current = undefined;
      finishSave(true);
      setShowRecovery(false);
      const recoveredNext = deferredDraft.current;
      if (recoveredNext && result.next.status === "ready" && recoveredNext.view.item.itemKey === result.next.item.itemKey) {
        setView(result.next); setAnswer(recoveredNext.answer);
        setFeedback(recoveredNext.checked ? getInstantPracticeFeedback(result.next.item, recoveredNext.answer) : null);
        setManualRating(recoveredNext.rating ?? FsrsRating.GOOD);
        restoredResponseMs.current = recoveredNext.responseMs;
        deferredDraft.current = undefined;
        return;
      }
      deferredDraft.current = undefined;
      if (!next || result.next.status !== "ready" || result.next.item.itemKey !== next.item.itemKey) {
        setPreloaded([]);
        preloadRequest.current = null;
        setView(result.next); setAnswer(""); setFeedback(null); setManualRating(FsrsRating.GOOD);
      }
    }).catch(() => restore("Could not confirm the save. Your checked answer is restored. Try saving again."))
      .finally(() => { savingRef.current = false; setSaving(false); setPending(null); });
  };

  const handleStop = () => {
    if (!sessionId || pending || savingRef.current) return;
    setPending("stop");
    setActionError(null);
    void stopCustomPracticeSessionAction({ sessionId })
      .then((result) => {
        setPreloaded([]);
        preloadRequest.current = null;
        setView(result);
        setAnswer("");
        setFeedback(null);
        startedAt.current = null;
      })
      .catch(() => setActionError("Could not stop this session. Try again."))
      .finally(() => setPending(null));
  };

  const handleResume = () => {
    if (!sessionId || pending || savingRef.current) return;
    setPending("resume");
    setActionError(null);
    void resumeCustomPracticeSessionAction({ sessionId })
      .then((result) => {
        setPreloaded([]);
        preloadRequest.current = null;
        setView(result);
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
        {actionError ? <ActionNotification id="custom-practice-error" title="Could not update session" message={actionError} /> : null}
        {reportedExerciseId ? <ActionNotification id={`custom-report-${reportedExerciseId}`} title="Report saved" tone="success" message="The exercise was removed. Your review schedule is unchanged." /> : null}
        {view.session ? (
          <p className="practiceMetaSummary tnum">
            {view.session.completedCount} of {view.session.targetCount} exercises · {formatMode(view.session.mode)}
          </p>
        ) : null}
        <div className="practiceCompleteActions">
          <Link className="secondaryButton" href="/practice/attention">Needs attention</Link>
          <Link className="secondaryButton" href="/practice">Return to normal practice</Link>
          <Link className={view.status === "stopped" ? "secondaryButton" : "primaryButton"} href="/practice/custom">Set up another session</Link>
          {view.status === "stopped" ? (
            <button className="primaryButton" type="button" onClick={handleResume} disabled={pending !== null}>
              {pending === "resume" ? "Resuming" : "Resume session"}
            </button>
          ) : null}
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
      <section className="practiceFrame customPracticeClient" aria-label="Practice exercise" data-next-ready={preloaded.length > 0} data-buffered-count={preloaded.length}>
        {showRecovery ? <RecoveryNotice storageKey={recoveryKey} saving={saving} /> : null}
        <div className="practiceMetaRow">
          <div>
            <p className="practiceMetaSummary tnum">Exercise {session.completedCount + 1} of {session.targetCount}</p>
          </div>
          {saving || navigationMessage ? <p role="status" className="practiceMetaSummary">{navigationMessage ?? "Saving…"}</p> : null}
        </div>
        <PracticePrompt text={exercise.prompt} layout={exercise.promptLayout} />
        {actionError ? <ActionNotification id="custom-practice-error" title="Could not update session" message={actionError} /> : null}
        {reportedExerciseId ? <ActionNotification id={`custom-report-${reportedExerciseId}`} title="Report saved" tone="success" message="The exercise was removed. Your review schedule is unchanged." /> : null}
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
            <button className="primaryButton" type="button" onClick={handleSave} disabled={pending !== null || saving}>
              {pending === "save" ? "Saving" : session.mode === "PRACTICE_ONLY" ? "Save practice" : "Continue"}
            </button>
          </div>
        ) : null}
        <ExerciseReport key={exercise.itemKey + exercise.exerciseId} disabled={pending !== null || saving} onReport={async (reasons, note) => {
          setPending("flag");
          try {
            const result = await flagCustomPracticeExerciseAction({ sessionId: session.id, itemKey: exercise.itemKey, exerciseId: exercise.exerciseId, reasons, otherNote: note });
            if (result.status !== "flagged") return result.message;
            setPreloaded([]); preloadRequest.current = null;
            pendingDraft.current = undefined; deferredDraft.current = undefined;
            setReportedExerciseId(exercise.exerciseId);
            setView(result.next); setAnswer(""); setFeedback(null); setShowRecovery(false);
            setActionError(null); setManualRating(FsrsRating.GOOD);
            return null;
          } finally { setPending(null); }
        }} />
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
