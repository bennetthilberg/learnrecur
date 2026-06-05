"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";

import { AnswerKind, ExerciseFlagReason, FsrsRating } from "@/generated/prisma/enums";

import {
  commitPracticeReviewAction,
  ensureDevPracticeSampleDataAction,
  flagPracticeExerciseAction,
  previewPracticeAnswerAction,
} from "./actions";
import type {
  ChoicePracticeSeedResult,
  PracticeItem,
  PracticePreviewResult,
} from "./types";

type PracticeClientProps = {
  initialItem: PracticeItem;
  canUseSampleData: boolean;
};

type PendingAction = "check" | "continue" | "flag" | "sample" | null;

const FLAG_REASON_OPTIONS: Array<{ reason: ExerciseFlagReason; label: string }> = [
  {
    reason: ExerciseFlagReason.INCORRECT_ANSWER,
    label: "Correct answer seems wrong",
  },
  {
    reason: ExerciseFlagReason.UNCLEAR_PROMPT,
    label: "Prompt is unclear",
  },
  {
    reason: ExerciseFlagReason.UNFAIR,
    label: "Feels unfair or tricky",
  },
  {
    reason: ExerciseFlagReason.STALE,
    label: "Stale or outdated",
  },
  {
    reason: ExerciseFlagReason.NOT_USEFUL,
    label: "Not useful for this skill",
  },
  {
    reason: ExerciseFlagReason.OFF_TOPIC,
    label: "Off topic",
  },
  {
    reason: ExerciseFlagReason.OTHER,
    label: "Something else",
  },
];

export function PracticeClient({ initialItem, canUseSampleData }: PracticeClientProps) {
  const [item, setItem] = useState(initialItem);
  const [answerValue, setAnswerValue] = useState("");
  const [attemptId, setAttemptId] = useState(() => crypto.randomUUID());
  const [feedback, setFeedback] = useState<PracticePreviewResult | null>(null);
  const [manualRating, setManualRating] = useState<FsrsRating | null>(null);
  const [submittedResponseMs, setSubmittedResponseMs] = useState<number | null>(null);
  const [flagFormOpen, setFlagFormOpen] = useState(false);
  const [selectedFlagReasons, setSelectedFlagReasons] = useState<ExerciseFlagReason[]>([]);
  const [otherFlagNote, setOtherFlagNote] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const timer = useVisibleElapsedMs(attemptId, item.status === "ready" && feedback === null);
  const checkedFeedback = feedback?.status === "checked" ? feedback : null;
  const isCorrect = checkedFeedback?.answerCheck.isCorrect === true;
  const isIncorrect = checkedFeedback?.answerCheck.isCorrect === false;
  const selectedOtherFlag = selectedFlagReasons.includes(ExerciseFlagReason.OTHER);
  const canSubmitFlag =
    selectedFlagReasons.length > 0 && (!selectedOtherFlag || otherFlagNote.trim().length > 0);

  const resetAttemptState = useCallback(() => {
    setAnswerValue("");
    setAttemptId(crypto.randomUUID());
    setFeedback(null);
    setManualRating(null);
    setSubmittedResponseMs(null);
    setFlagFormOpen(false);
    setSelectedFlagReasons([]);
    setOtherFlagNote("");
    setPendingAction(null);
    setStatusMessage(null);
  }, []);

  const handleFlagReasonToggle = useCallback((reason: ExerciseFlagReason) => {
    setSelectedFlagReasons((current) =>
      current.includes(reason)
        ? current.filter((selectedReason) => selectedReason !== reason)
        : [...current, reason],
    );
  }, []);

  const handleCheck = useCallback(() => {
    if (item.status !== "ready" || !isAnswerReady(answerValue) || pendingAction !== null) {
      return;
    }

    const responseMs = timer.getElapsedMs();
    setSubmittedResponseMs(responseMs);
    setPendingAction("check");
    setStatusMessage(null);

    startTransition(async () => {
      const result = await previewPracticeAnswerAction({
        exerciseId: item.exercise.id,
        submittedAnswer: answerValue,
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
  }, [answerValue, item, pendingAction, timer, startTransition]);

  const handleContinue = useCallback(() => {
    if (
      item.status !== "ready" ||
      !isAnswerReady(answerValue) ||
      feedback?.status !== "checked" ||
      pendingAction !== null
    ) {
      return;
    }

    setPendingAction("continue");
    setStatusMessage(null);

    startTransition(async () => {
      const result = await commitPracticeReviewAction({
        exerciseId: item.exercise.id,
        submittedAnswer: answerValue,
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
    answerValue,
    feedback,
    item,
    manualRating,
    pendingAction,
    resetAttemptState,
    submittedResponseMs,
    timer,
    startTransition,
  ]);

  const handleFlagSubmit = useCallback(() => {
    if (
      item.status !== "ready" ||
      feedback?.status !== "checked" ||
      pendingAction !== null ||
      !canSubmitFlag
    ) {
      return;
    }

    setPendingAction("flag");
    setStatusMessage(null);

    startTransition(async () => {
      const result = await flagPracticeExerciseAction({
        exerciseId: item.exercise.id,
        reasons: selectedFlagReasons,
        otherNote: otherFlagNote,
      });

      setPendingAction(null);

      if (result.status === "flagged") {
        setItem(result.nextItem);
        resetAttemptState();
        setStatusMessage(result.message);
      } else {
        setStatusMessage(result.message);
      }
    });
  }, [
    canSubmitFlag,
    feedback,
    item,
    otherFlagNote,
    pendingAction,
    resetAttemptState,
    selectedFlagReasons,
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

  if (item.status !== "ready") {
    return (
      <section className="practiceFrame practiceEmpty" aria-labelledby="practice-empty-title">
        <p className="eyebrow">Practice queue</p>
        <h1 id="practice-empty-title">
          {item.status === "none-due" ? "All caught up." : "Practice unavailable."}
        </h1>
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

  const exercise = item.exercise;
  const isNumericExercise = exercise.answerKind === AnswerKind.NUMERIC;
  const practiceModeLabel =
    exercise.answerKind === AnswerKind.CHOICE ? "Multiple choice" : "Exact input";

  return (
    <section className="practiceFrame" aria-labelledby="practice-title">
      <div className="practiceMetaRow">
        <div>
          <p className="eyebrow">{practiceModeLabel}</p>
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
          {exercise.difficulty ? <span>Level {exercise.difficulty}</span> : null}
        </div>
        <p>{exercise.prompt}</p>
      </article>

      {exercise.answerKind === AnswerKind.CHOICE ? (
        <div className="choiceGrid" role="radiogroup" aria-label="Answer choices">
          {exercise.choices.map((choice) => {
            const selected = answerValue === choice.id;
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
                onClick={() => setAnswerValue(choice.id)}
              >
                <span>{choice.label}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <label className="exactAnswerField">
          <span>Your answer</span>
          <input
            value={answerValue}
            inputMode={isNumericExercise ? "decimal" : "text"}
            autoComplete="off"
            disabled={feedback !== null || pendingAction !== null}
            placeholder={isNumericExercise ? "Enter a number or fraction" : "Type your answer"}
            onChange={(event) => setAnswerValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && feedback === null && pendingAction === null) {
                handleCheck();
              }
            }}
          />
        </label>
      )}

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

      {checkedFeedback ? (
        <section className="flagExercisePanel" aria-labelledby="flag-exercise-title">
          <div className="flagExerciseHeader">
            <div>
              <h2 id="flag-exercise-title">Something wrong?</h2>
              <p>Report this exercise instead of saving the review.</p>
            </div>
            <button
              className="secondaryButton"
              type="button"
              disabled={pendingAction !== null}
              aria-expanded={flagFormOpen}
              onClick={() => setFlagFormOpen((open) => !open)}
            >
              {flagFormOpen ? "Close report" : "Report issue"}
            </button>
          </div>

          {flagFormOpen ? (
            <div className="flagExerciseForm">
              <fieldset>
                <legend>What should we fix?</legend>
                <div className="flagReasonGrid">
                  {FLAG_REASON_OPTIONS.map((option) => (
                    <label key={option.reason} className="flagReasonOption">
                      <input
                        type="checkbox"
                        checked={selectedFlagReasons.includes(option.reason)}
                        disabled={pendingAction !== null}
                        onChange={() => handleFlagReasonToggle(option.reason)}
                      />
                      <span>{option.label}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              {selectedOtherFlag ? (
                <label className="flagNoteField">
                  <span>What else?</span>
                  <textarea
                    value={otherFlagNote}
                    disabled={pendingAction !== null}
                    maxLength={500}
                    rows={3}
                    onChange={(event) => setOtherFlagNote(event.target.value)}
                  />
                </label>
              ) : null}

              <div className="flagActions">
                <button
                  className="secondaryButton"
                  type="button"
                  disabled={pendingAction !== null || !canSubmitFlag}
                  onClick={handleFlagSubmit}
                >
                  {pendingAction === "flag" ? "Reporting" : "Submit report"}
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <div className="practiceActions">
        {feedback === null ? (
          <button
            className="primaryButton"
            type="button"
            disabled={!isAnswerReady(answerValue) || pendingAction !== null}
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

function useVisibleElapsedMs(attemptKey: string, active: boolean) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const accumulatedMsRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);
  const activeRef = useRef(active);

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
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    accumulatedMsRef.current = 0;
    startedAtRef.current = null;
    const resetTimer = window.setTimeout(() => setElapsedMs(0), 0);

    if (activeRef.current && document.visibilityState === "visible") {
      startedAtRef.current = performance.now();
    }

    return () => window.clearTimeout(resetTimer);
  }, [attemptKey]);

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

function isAnswerReady(answer: string): boolean {
  return answer.trim().length > 0;
}
