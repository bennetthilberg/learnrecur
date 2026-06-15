"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { CheckCircle } from "@phosphor-icons/react";

import { AnswerKind, ExerciseFlagReason, FsrsRating } from "@/generated/prisma/enums";
import { formatFsrsState } from "@/lib/formatters";
import {
  getPracticeShortcutIntent,
  type PracticeShortcutTargetRole,
} from "@/lib/practice-shortcuts";

import {
  commitPracticeReviewAction,
  ensureDevPracticeSampleDataAction,
  flagPracticeExerciseAction,
  previewPracticeAnswerAction,
} from "./actions";
import { MathText } from "./math-text";
import type {
  ChoicePracticeSeedResult,
  PracticeItem,
  PracticePreviewResult,
  PracticeScope,
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

const RATING_OPTIONS: Array<{ rating: FsrsRating; shortcut: string }> = [
  { rating: FsrsRating.HARD, shortcut: "2" },
  { rating: FsrsRating.GOOD, shortcut: "3" },
  { rating: FsrsRating.EASY, shortcut: "4" },
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
  const answerInputRef = useRef<HTMLInputElement>(null);
  const continueButtonRef = useRef<HTMLButtonElement>(null);
  const firstFlagReasonRef = useRef<HTMLInputElement>(null);
  const practiceFrameRef = useRef<HTMLElement>(null);
  const reportToggleRef = useRef<HTMLButtonElement>(null);

  const timer = useVisibleElapsedMs(attemptId, item.status === "ready" && feedback === null);
  const checkedFeedback = feedback?.status === "checked" ? feedback : null;
  const isCorrect = checkedFeedback?.answerCheck.isCorrect === true;
  const isIncorrect = checkedFeedback?.answerCheck.isCorrect === false;
  const selectedOtherFlag = selectedFlagReasons.includes(ExerciseFlagReason.OTHER);
  const canSubmitFlag =
    selectedFlagReasons.length > 0 && (!selectedOtherFlag || otherFlagNote.trim().length > 0);
  const scopedCollectionId = getScopedCollectionId(item);

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
        collectionId: scopedCollectionId,
      });

      setPendingAction(null);

      if (isTerminalPreviewResult(result)) {
        setFeedback(result);

        if (result.answerCheck.isCorrect) {
          setManualRating(result.proposedRating ?? FsrsRating.GOOD);
        } else {
          setManualRating(FsrsRating.AGAIN);
        }
      } else {
        setFeedback(null);
        setManualRating(null);

        if (result.status === "not-found") {
          setItem({
            status: "unavailable",
            message: result.message,
            scope: item.scope,
          });
        }

        setStatusMessage(getPreviewStatusMessage(result));
      }
    });
  }, [answerValue, item, pendingAction, scopedCollectionId, timer, startTransition]);

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
        collectionId: scopedCollectionId,
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
    scopedCollectionId,
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
        collectionId: scopedCollectionId,
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
    scopedCollectionId,
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

  useEffect(() => {
    if (item.status !== "ready") {
      return;
    }

    const focusTarget = window.requestAnimationFrame(() => {
      if (item.exercise.answerKind === AnswerKind.CHOICE) {
        practiceFrameRef.current?.focus({ preventScroll: true });
      } else {
        answerInputRef.current?.focus({ preventScroll: true });
      }
    });

    return () => window.cancelAnimationFrame(focusTarget);
  }, [attemptId, item]);

  useEffect(() => {
    if (!checkedFeedback) {
      return;
    }

    const focusTarget = window.requestAnimationFrame(() => {
      continueButtonRef.current?.focus();
    });

    return () => window.cancelAnimationFrame(focusTarget);
  }, [checkedFeedback]);

  useEffect(() => {
    if (!flagFormOpen) {
      return;
    }

    const focusTarget = window.requestAnimationFrame(() => {
      firstFlagReasonRef.current?.focus({ preventScroll: true });
    });

    return () => window.cancelAnimationFrame(focusTarget);
  }, [flagFormOpen]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (item.status !== "ready") {
        return;
      }

      const choiceCount =
        item.exercise.answerKind === AnswerKind.CHOICE ? item.exercise.choices.length : 0;
      const intent = getPracticeShortcutIntent({
        answerKind: item.exercise.answerKind,
        answerReady: isAnswerReady(answerValue),
        choiceCount,
        feedbackVisible: feedback !== null,
        flagFormOpen,
        key: event.key,
        pending: pendingAction !== null,
        ratingAvailable: isCorrect,
        targetRole: getShortcutTargetRole(event.target, answerInputRef.current),
      });

      if (intent.type === "none") {
        return;
      }

      event.preventDefault();

      if (intent.type === "select-choice" && item.exercise.answerKind === AnswerKind.CHOICE) {
        const choice = item.exercise.choices[intent.choiceIndex];

        if (choice) {
          setAnswerValue(choice.id);
        }

        return;
      }

      if (intent.type === "check-answer") {
        handleCheck();
        return;
      }

      if (intent.type === "continue") {
        handleContinue();
        return;
      }

      if (intent.type === "set-rating") {
        setManualRating(shortcutRatingToFsrs(intent.rating));
        return;
      }

      if (intent.type === "close-report") {
        setFlagFormOpen(false);
        window.requestAnimationFrame(() => {
          reportToggleRef.current?.focus({ preventScroll: true });
        });
      }
    };

    window.addEventListener("keydown", handleKeyDown);

    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [answerValue, feedback, flagFormOpen, handleCheck, handleContinue, isCorrect, item, pendingAction]);

  if (item.status !== "ready") {
    const scoped = item.scope?.kind === "collection";

    return (
      <>
        <PracticeScopeBar scope={item.scope} />
        {item.status === "none-due" ? (
          <PracticeCompleteState
            canUseSampleData={canUseSampleData && !scoped}
            message={item.message}
            onSampleData={handleSampleData}
            pendingSample={pendingAction === "sample"}
            scoped={scoped}
            statusMessage={statusMessage}
          />
        ) : (
          <section className="practiceFrame practiceEmpty" aria-labelledby="practice-empty-title">
            <p className="eyebrow">Due practice</p>
            <h1 id="practice-empty-title">Practice is unavailable.</h1>
            <p>{item.message}</p>
            <PracticeEmptyDetails scoped={scoped} status={item.status} />
            <PracticeEmptyActions scoped={scoped} />
            {canUseSampleData && !scoped ? (
              <button
                className="secondaryButton"
                type="button"
                onClick={handleSampleData}
                disabled={pendingAction === "sample"}
              >
                {pendingAction === "sample" ? "Preparing sample" : "Create sample practice"}
              </button>
            ) : null}
            <PracticeStatusMessage message={statusMessage} />
          </section>
        )}
      </>
    );
  }

  const exercise = item.exercise;
  const isNumericExercise = exercise.answerKind === AnswerKind.NUMERIC;
  const isMathExercise = exercise.answerKind === AnswerKind.MATH;
  const practiceModeLabel =
    exercise.answerKind === AnswerKind.CHOICE
      ? "Multiple choice"
      : isMathExercise
        ? "Math input"
        : "Exact input";

  return (
    <>
      <PracticeScopeBar scope={item.scope} />
      <section
        ref={practiceFrameRef}
        className="practiceFrame"
        aria-labelledby="practice-title"
        tabIndex={-1}
      >
        <div className="practiceMetaRow">
          <div>
            <p className="eyebrow">{practiceModeLabel}</p>
            <h1 id="practice-title">{item.skill.title}</h1>
          </div>
          <dl className="practiceSessionFacts" aria-label="Practice status">
            <div data-priority="primary">
              <dt>Memory stage</dt>
              <dd>{formatFsrsState(item.skill.fsrsState)}</dd>
            </div>
            <div>
              <dt>Time</dt>
              <dd>{formatElapsed(timer.elapsedMs)}</dd>
            </div>
          </dl>
        </div>

      <article className="practicePromptPanel">
        {exercise.difficulty ? (
          <div className="practicePromptHeader" role="group" aria-label="Exercise details">
            <span>Level {exercise.difficulty}</span>
          </div>
        ) : null}
        <p>
          <MathText text={exercise.prompt} />
        </p>
      </article>

      {exercise.answerKind === AnswerKind.CHOICE ? (
        <div className="choiceGrid" role="radiogroup" aria-label="Answer choices">
          {exercise.choices.map((choice, index) => {
            const selected = answerValue === choice.id;
            const checked = feedback?.status === "checked";
            const correctChoice = checkedFeedback?.correctChoiceId === choice.id;
            const tone =
              checked && (selected || correctChoice)
                ? checkedFeedback?.answerCheck.isCorrect
                  ? "correct"
                  : correctChoice
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
                aria-label={`Choice ${index + 1}: ${choice.label}`}
                disabled={feedback !== null || pendingAction !== null}
                onClick={() => setAnswerValue(choice.id)}
              >
                <span className="choiceIndex" aria-hidden="true">
                  {index + 1}
                </span>
                <span>{choice.label}</span>
              </button>
            );
          })}
        </div>
      ) : (
        <label className="exactAnswerField">
          <span>Your answer</span>
          <input
            ref={answerInputRef}
            value={answerValue}
            inputMode="text"
            autoComplete="off"
            disabled={feedback !== null || pendingAction !== null}
            placeholder={
              isMathExercise
                ? "Enter a math expression"
                : isNumericExercise
                  ? "Enter a number or fraction"
                  : "Type your answer"
            }
            onChange={(event) => setAnswerValue(event.target.value)}
          />
        </label>
      )}

      {feedback === null ? (
        <div className="practiceActions">
          <button
            className="primaryButton"
            type="button"
            disabled={!isAnswerReady(answerValue) || pendingAction !== null}
            onClick={handleCheck}
          >
            <PendingButtonContent
              active={pendingAction === "check"}
              idleText="Check"
              pendingText="Checking"
            />
          </button>
        </div>
      ) : null}

      {checkedFeedback ? (
        <section
          className="practiceFeedback"
          data-tone={isCorrect ? "correct" : "incorrect"}
          aria-live="polite"
          role="status"
        >
          <h2>{isCorrect ? "Correct." : "Not quite."}</h2>
          <dl
            className="practiceFeedbackAnswer"
            aria-label={`Correct answer: ${checkedFeedback.correctAnswerDisplay}`}
          >
            <div>
              <dt>Correct answer</dt>
              <dd>
                <MathText text={checkedFeedback.correctAnswerDisplay} />
              </dd>
            </div>
          </dl>
          {checkedFeedback.explanation ? (
            <p>
              <MathText text={checkedFeedback.explanation} />
            </p>
          ) : null}
        </section>
      ) : null}

      {isCorrect ? (
        <fieldset className="ratingOverride">
          <legend>Review rating</legend>
          <p className="ratingOverrideHint">How hard was that?</p>
          <div role="radiogroup" aria-label="Review rating">
            {RATING_OPTIONS.map(({ rating, shortcut }) => (
              <button
                key={rating}
                role="radio"
                aria-checked={manualRating === rating}
                aria-label={`${formatRating(rating)} rating, shortcut ${shortcut}`}
                className="ratingButton"
                data-selected={manualRating === rating ? "true" : "false"}
                type="button"
                onClick={() => setManualRating(rating)}
              >
                <span>{formatRating(rating)}</span>
                <kbd aria-hidden="true">{shortcut}</kbd>
              </button>
            ))}
          </div>
        </fieldset>
      ) : null}

      {feedback !== null ? (
        <div className="practiceActions">
          <button
            className="primaryButton"
            type="button"
            disabled={pendingAction !== null || feedback.status !== "checked"}
            onClick={handleContinue}
            ref={continueButtonRef}
          >
            <PendingButtonContent
              active={pendingAction === "continue"}
              idleText="Continue"
              pendingText="Saving"
            />
          </button>
        </div>
      ) : null}

      {isIncorrect ? (
        <p className="practiceStatusLine" data-tone="attention">
          Review rating: Again.
        </p>
      ) : null}

      {checkedFeedback ? (
        <section className="flagExercisePanel" aria-labelledby="flag-exercise-title">
          <div className="flagExerciseHeader">
            <div>
              <h2 id="flag-exercise-title">Report an issue</h2>
              <p>Retire this exercise instead of saving the review.</p>
            </div>
            <button
              ref={reportToggleRef}
              className="secondaryButton"
              type="button"
              disabled={pendingAction !== null}
              aria-controls={flagFormOpen ? "practice-report-form" : undefined}
              aria-expanded={flagFormOpen}
              onClick={() => setFlagFormOpen((open) => !open)}
            >
              {flagFormOpen ? "Close report" : "Report issue"}
            </button>
          </div>

          {flagFormOpen ? (
            <div className="flagExerciseForm" id="practice-report-form">
              <fieldset>
                <legend>Issue type</legend>
                <div className="flagReasonGrid">
                  {FLAG_REASON_OPTIONS.map((option, index) => (
                    <label key={option.reason} className="flagReasonOption">
                      <input
                        ref={index === 0 ? firstFlagReasonRef : undefined}
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
                  <span>Note</span>
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

      <PracticeStatusMessage message={statusMessage} />
      </section>
    </>
  );
}

function PracticeScopeBar({ scope }: { scope?: PracticeScope }) {
  if (!scope || scope.kind !== "collection") {
    return null;
  }

  return (
    <div className="practiceScopeBar" aria-label="Practice scope">
      <span>Collection</span>
      <strong>{scope.collectionName}</strong>
      <Link href="/practice">All practice</Link>
    </div>
  );
}

function getScopedCollectionId(item: PracticeItem): string | null {
  return item.scope?.kind === "collection" ? item.scope.collectionId : null;
}

function PracticeCompleteState({
  canUseSampleData,
  message,
  onSampleData,
  pendingSample,
  scoped,
  statusMessage,
}: {
  canUseSampleData: boolean;
  message: string;
  onSampleData: () => void;
  pendingSample: boolean;
  scoped: boolean;
  statusMessage: string | null;
}) {
  return (
    <section
      className="practiceFrame practiceEmpty practiceComplete"
      aria-labelledby="practice-empty-title"
    >
      <div className="practiceCompleteIcon" aria-hidden="true">
        <CheckCircle size={28} weight="bold" />
      </div>
      <div className="practiceCompleteCopy">
        <p className="eyebrow">Due practice complete</p>
        <h1 id="practice-empty-title">Nice work. You&apos;re all caught up.</h1>
        <p>
          {scoped
            ? "Every due exercise in this collection is finished for now."
            : "Every due exercise is finished for now."}{" "}
          LearnRecur will bring skills back when the schedule says they are ready.
        </p>
      </div>
      <div className="practiceCompleteSummary" aria-label="Practice completion summary">
        <div>
          <span>Queue</span>
          <strong>Clear for now</strong>
        </div>
        <div>
          <span>Schedule</span>
          <strong>{message}</strong>
        </div>
      </div>
      <PracticeCompleteActions scoped={scoped} />
      {statusMessage ? (
        <p className="practiceCompleteStatus" aria-live="polite" role="status">
          <CheckCircle size={16} weight="bold" aria-hidden="true" />
          <span>{statusMessage}</span>
        </p>
      ) : null}
      {canUseSampleData ? (
        <div className="practiceCompleteDevAction">
          <span>Development mode</span>
          <button
            className="secondaryButton"
            type="button"
            onClick={onSampleData}
            disabled={pendingSample}
          >
            {pendingSample ? "Preparing sample" : "Create sample practice"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function PracticeCompleteActions({ scoped }: { scoped: boolean }) {
  return (
    <div className="practiceCompleteActions" aria-label="Practice next actions">
      {scoped ? (
        <>
          <Link className="primaryButton" href="/practice">
            Try all practice
          </Link>
          <Link className="secondaryButton" href="/dashboard">
            Dashboard
          </Link>
        </>
      ) : (
        <>
          <Link className="primaryButton" href="/dashboard">
            Dashboard
          </Link>
          <Link className="secondaryButton" href="/skills">
            Review skills
          </Link>
        </>
      )}
    </div>
  );
}

function PracticeEmptyActions({ scoped }: { scoped: boolean }) {
  return (
    <div className="practiceEmptyActions" aria-label="Practice next actions">
      <div className="practiceEmptyPrimaryActions">
        {scoped ? (
          <Link className="primaryButton" href="/practice">
            All practice
          </Link>
        ) : null}
        <Link className={scoped ? "secondaryButton" : "primaryButton"} href="/dashboard">
          Dashboard
        </Link>
      </div>
      <div className="practiceEmptyUtilityLinks">
        <Link href="/skills">Skills</Link>
        <Link href="/skills/new">Add skill</Link>
      </div>
    </div>
  );
}

function PracticeEmptyDetails({
  scoped,
  status,
}: {
  scoped: boolean;
  status: Exclude<PracticeItem["status"], "ready">;
}) {
  const details =
    status === "none-due"
      ? scoped
        ? [
            ["Scope", "Only active skills in this collection are checked."],
            ["Ready exercise", "A due skill with verified exercises."],
          ]
        : [
            ["Schedule", "No active skill is due right now."],
            ["Ready exercise", "A due skill with verified exercises."],
          ]
      : [
          [
            "Scope",
            scoped
              ? "This collection cannot be selected for practice."
              : "No due exercise could be selected.",
          ],
          [
            "Next step",
            scoped
              ? "Try all practice or review the collection."
              : "Review skills and exercise inventory.",
          ],
        ];

  return (
    <dl className="practiceEmptyDetails" aria-label="Practice availability checks">
      {details.map(([label, detail]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{detail}</dd>
        </div>
      ))}
    </dl>
  );
}

function PracticeStatusMessage({ message }: { message: string | null }) {
  if (!message) {
    return null;
  }

  return (
    <p className="practiceStatusLine" aria-live="polite" role="status">
      {message}
    </p>
  );
}

function getShortcutTargetRole(
  target: EventTarget | null,
  answerInput: HTMLInputElement | null,
): PracticeShortcutTargetRole {
  if (!(target instanceof HTMLElement)) {
    return "document";
  }

  if (answerInput && target === answerInput) {
    return "answer-input";
  }

  if (
    target instanceof HTMLButtonElement ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLTextAreaElement ||
    target.isContentEditable
  ) {
    return "form-control";
  }

  return "document";
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

function formatRating(rating: FsrsRating): string {
  return rating.charAt(0) + rating.slice(1).toLowerCase();
}

function shortcutRatingToFsrs(rating: "hard" | "good" | "easy"): FsrsRating {
  return {
    hard: FsrsRating.HARD,
    good: FsrsRating.GOOD,
    easy: FsrsRating.EASY,
  }[rating];
}

function PendingButtonContent({
  active,
  idleText,
  pendingText,
}: {
  active: boolean;
  idleText: string;
  pendingText: string;
}) {
  return (
    <span className="buttonPendingContent">
      {active ? <span className="buttonSpinner" aria-hidden="true" /> : null}
      <span>{active ? pendingText : idleText}</span>
    </span>
  );
}

function isAnswerReady(answer: string): boolean {
  return answer.trim().length > 0;
}

function isTerminalPreviewResult(
  result: PracticePreviewResult,
): result is Extract<PracticePreviewResult, { status: "checked" }> {
  return (
    result.status === "checked" &&
    (result.answerCheck.status === "correct" || result.answerCheck.status === "incorrect")
  );
}

function getPreviewStatusMessage(result: PracticePreviewResult): string {
  if (result.status === "not-found") {
    return result.message;
  }

  return result.answerCheck.message ?? "Check your answer and try again.";
}
