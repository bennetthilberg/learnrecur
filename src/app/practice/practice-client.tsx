"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { FsrsRating } from "@/generated/prisma/enums";

import {
  commitChoicePracticeReviewAction,
  ensureDevPracticeSampleDataAction,
  previewChoicePracticeAnswerAction,
} from "./actions";
import type {
  ChoicePracticeItem,
  ChoicePracticePreviewResult,
  ChoicePracticeSeedResult,
} from "./types";

type PracticeClientProps = {
  initialItem: ChoicePracticeItem;
  canUseSampleData: boolean;
};

type PendingAction = "check" | "continue" | "sample" | null;

export function PracticeClient({ initialItem, canUseSampleData }: PracticeClientProps) {
  const [item, setItem] = useState(initialItem);
  const [selectedChoiceId, setSelectedChoiceId] = useState<string | null>(null);
  const [attemptId, setAttemptId] = useState(() => crypto.randomUUID());
  const [feedback, setFeedback] = useState<ChoicePracticePreviewResult | null>(null);
  const [manualRating, setManualRating] = useState<FsrsRating | null>(null);
  const [submittedResponseMs, setSubmittedResponseMs] = useState<number | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const itemKey = item.status === "ready" ? item.exercise.id : "none";
  const timer = useVisibleElapsedMs(itemKey, item.status === "ready" && feedback === null);
  const checkedFeedback = feedback?.status === "checked" ? feedback : null;
  const isCorrect = checkedFeedback?.answerCheck.isCorrect === true;
  const isIncorrect = checkedFeedback?.answerCheck.isCorrect === false;

  const resetAttemptState = useCallback(() => {
    setSelectedChoiceId(null);
    setAttemptId(crypto.randomUUID());
    setFeedback(null);
    setManualRating(null);
    setSubmittedResponseMs(null);
    setPendingAction(null);
    setStatusMessage(null);
  }, []);

  const handleCheck = useCallback(() => {
    if (item.status !== "ready" || !selectedChoiceId || pendingAction !== null) {
      return;
    }

    const responseMs = timer.getElapsedMs();
    setSubmittedResponseMs(responseMs);
    setPendingAction("check");
    setStatusMessage(null);

    startTransition(async () => {
      const result = await previewChoicePracticeAnswerAction({
        exerciseId: item.exercise.id,
        selectedChoiceId,
        responseMs,
      });

      setPendingAction(null);

      if (result.status === "checked") {
        setFeedback(result);

        if (result.answerCheck.isCorrect) {
          setManualRating(result.proposedRating ?? FsrsRating.GOOD);
        } else {
          setManualRating(FsrsRating.AGAIN);
        }
      } else {
        setStatusMessage(result.message);
      }
    });
  }, [item, pendingAction, selectedChoiceId, timer, startTransition]);

  const handleContinue = useCallback(() => {
    if (
      item.status !== "ready" ||
      !selectedChoiceId ||
      feedback?.status !== "checked" ||
      pendingAction !== null
    ) {
      return;
    }

    setPendingAction("continue");
    setStatusMessage(null);

    startTransition(async () => {
      const result = await commitChoicePracticeReviewAction({
        exerciseId: item.exercise.id,
        selectedChoiceId,
        responseMs: submittedResponseMs ?? timer.getElapsedMs(),
        attemptId,
        manualRating: feedback.answerCheck.isCorrect ? manualRating : null,
      });

      setPendingAction(null);

      if (result.status === "committed") {
        setItem(result.nextItem);
        resetAttemptState();
        setStatusMessage(result.idempotent ? "Review already saved." : "Review saved.");
      } else {
        setStatusMessage(result.message);
      }
    });
  }, [
    attemptId,
    feedback,
    item,
    manualRating,
    pendingAction,
    resetAttemptState,
    selectedChoiceId,
    submittedResponseMs,
    timer,
    startTransition,
  ]);

  const handleSampleData = useCallback(() => {
    if (pendingAction !== null) {
      return;
    }

    setPendingAction("sample");
    setStatusMessage(null);

    startTransition(async () => {
      const result: ChoicePracticeSeedResult = await ensureDevPracticeSampleDataAction();
      setPendingAction(null);

      if (result.status === "ready") {
        setItem(result.nextItem);
        resetAttemptState();
      }

      setStatusMessage(result.message);
    });
  }, [pendingAction, resetAttemptState, startTransition]);

  if (item.status === "none-due") {
    return (
      <section className="practiceFrame practiceEmpty" aria-labelledby="practice-empty-title">
        <p className="eyebrow">Practice queue</p>
        <h1 id="practice-empty-title">All caught up.</h1>
        <p>{item.message}</p>
        {canUseSampleData ? (
          <button
            className="primaryButton"
            type="button"
            onClick={handleSampleData}
            disabled={pendingAction === "sample"}
          >
            {pendingAction === "sample" ? "Preparing sample" : "Create sample practice"}
          </button>
        ) : null}
        {statusMessage ? <p className="practiceStatusLine">{statusMessage}</p> : null}
      </section>
    );
  }

  return (
    <section className="practiceFrame" aria-labelledby="practice-title">
      <div className="practiceMetaRow">
        <div>
          <p className="eyebrow">Multiple choice</p>
          <h1 id="practice-title">{item.skill.title}</h1>
        </div>
        <div className="practiceMetricCluster" aria-label="Practice status">
          <span className="practiceChip">{formatFsrsState(item.skill.fsrsState)}</span>
          <span className="practiceChip">{formatElapsed(timer.elapsedMs)}</span>
        </div>
      </div>

      <article className="practicePromptPanel">
        <div className="practicePromptHeader">
          <span>Exercise</span>
          {item.exercise.difficulty ? <span>Level {item.exercise.difficulty}</span> : null}
        </div>
        <p>{item.exercise.prompt}</p>
      </article>

      <div className="choiceGrid" role="radiogroup" aria-label="Answer choices">
        {item.exercise.choices.map((choice) => {
          const selected = selectedChoiceId === choice.id;
          const checked = feedback?.status === "checked";
          const tone =
            checked && selected
              ? checkedFeedback?.answerCheck.isCorrect
                ? "correct"
                : "incorrect"
              : "neutral";

          return (
            <button
              key={choice.id}
              className="choiceCard"
              data-selected={selected ? "true" : "false"}
              data-tone={tone}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={feedback !== null || pendingAction !== null}
              onClick={() => setSelectedChoiceId(choice.id)}
            >
              <span>{choice.label}</span>
            </button>
          );
        })}
      </div>

      {checkedFeedback ? (
        <section
          className="practiceFeedback"
          data-tone={isCorrect ? "correct" : "incorrect"}
          aria-live="polite"
        >
          <h2>{isCorrect ? "Correct." : "Not quite."}</h2>
          <p>
            Correct answer: <strong>{checkedFeedback.correctAnswerDisplay}</strong>
          </p>
          {checkedFeedback.explanation ? <p>{checkedFeedback.explanation}</p> : null}
        </section>
      ) : null}

      {isCorrect ? (
        <fieldset className="ratingOverride">
          <legend>Schedule rating</legend>
          <div>
            {[FsrsRating.HARD, FsrsRating.GOOD, FsrsRating.EASY].map((rating) => (
              <button
                key={rating}
                className="ratingButton"
                data-selected={manualRating === rating ? "true" : "false"}
                type="button"
                onClick={() => setManualRating(rating)}
              >
                {formatRating(rating)}
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}

      {isIncorrect ? (
        <p className="practiceStatusLine">This review will be scheduled as Again.</p>
      ) : null}

      <div className="practiceActions">
        {feedback === null ? (
          <button
            className="primaryButton"
            type="button"
            disabled={!selectedChoiceId || pendingAction !== null}
            onClick={handleCheck}
          >
            {pendingAction === "check" ? "Checking" : "Check"}
          </button>
        ) : (
          <button
            className="primaryButton"
            type="button"
            disabled={pendingAction !== null || feedback.status !== "checked"}
            onClick={handleContinue}
          >
            {pendingAction === "continue" ? "Saving" : "Continue"}
          </button>
        )}
      </div>

      {statusMessage ? <p className="practiceStatusLine">{statusMessage}</p> : null}
    </section>
  );
}

function useVisibleElapsedMs(key: string, active: boolean) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const accumulatedMsRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);

  const pause = useCallback(() => {
    if (startedAtRef.current !== null) {
      accumulatedMsRef.current += performance.now() - startedAtRef.current;
      startedAtRef.current = null;
    }

    setElapsedMs(Math.round(accumulatedMsRef.current));
  }, []);

  const resume = useCallback(() => {
    if (active && document.visibilityState === "visible" && startedAtRef.current === null) {
      startedAtRef.current = performance.now();
    }
  }, [active]);

  const getElapsedMs = useCallback(() => {
    if (startedAtRef.current === null) {
      return Math.round(accumulatedMsRef.current);
    }

    return Math.round(accumulatedMsRef.current + performance.now() - startedAtRef.current);
  }, []);

  useEffect(() => {
    accumulatedMsRef.current = 0;
    startedAtRef.current = null;
    const resetTimer = window.setTimeout(() => setElapsedMs(0), 0);

    if (active && document.visibilityState === "visible") {
      startedAtRef.current = performance.now();
    }

    return () => window.clearTimeout(resetTimer);
  }, [active, key]);

  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        resume();
      } else {
        pause();
      }
    };

    window.addEventListener("focus", resume);
    window.addEventListener("blur", pause);
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      window.removeEventListener("focus", resume);
      window.removeEventListener("blur", pause);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [pause, resume]);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setElapsedMs(getElapsedMs());
    }, 250);

    return () => window.clearInterval(interval);
  }, [getElapsedMs]);

  useEffect(() => {
    if (!active) {
      pause();
    } else {
      resume();
    }
  }, [active, pause, resume]);

  return {
    elapsedMs,
    getElapsedMs,
  };
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;

  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function formatFsrsState(state: string): string {
  return state.charAt(0) + state.slice(1).toLowerCase();
}

function formatRating(rating: FsrsRating): string {
  return rating.charAt(0) + rating.slice(1).toLowerCase();
}
