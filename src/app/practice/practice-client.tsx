"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { appendPracticeBuffer, PRACTICE_BUFFER_SIZE, PRACTICE_BUFFER_LOW_WATER } from "@/lib/practice/buffer";
import { writeRecovery, type NormalDraft, type Recovery } from "@/lib/practice/recovery";
import { confirmReviewSave, useReviewSaveGuard } from "./use-review-save-guard";
import { getInstantPracticeFeedback } from "@/lib/practice/instant-feedback";
import { CheckCircle, Flag } from "@phosphor-icons/react";

import { AnswerKind, ExerciseFlagReason, FsrsRating } from "@/generated/prisma/enums";
import {
  MAX_MATH_EXPRESSION_LENGTH,
  MAX_NUMERIC_ANSWER_LENGTH,
  MAX_TEXT_ANSWER_LENGTH,
} from "@/lib/answer-limits";
import { formatFsrsState } from "@/lib/formatters";
import {
  getPracticeShortcutIntent,
  type PracticeShortcutTargetRole,
} from "@/lib/practice-shortcuts";

import {
  preloadPracticeBufferAction,
  commitPracticeReviewAction,
  ensureDevPracticeSampleDataAction,
  flagPracticeExerciseAction,
} from "./actions";
import { MathText } from "./math-text";
import { RecoveryNotice } from "./recovery-notice";
import { PracticePrompt } from "./practice-prompt";
import type {
  ChoicePracticeSeedResult,
  PracticeItem,
  PracticePreviewResult,
  PracticeScope,
} from "./types";

type PracticeClientProps = {
  recoveryKey?: string;
  initialRecovery?: Recovery<NormalDraft> | null;
  initialItem: PracticeItem;
  canUseSampleData: boolean;
};

type PendingAction = "check" | "continue" | "flag" | "sample" | null;
type PracticeStatusTone = "neutral" | "saved" | "error";
type PracticeStatusNotice = {
  message: string;
  tone: PracticeStatusTone;
};

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

const REVIEW_SAVED_MESSAGES = new Set(["Review saved.", "Review already saved."]);

export function PracticeClient({ initialItem, canUseSampleData, recoveryKey, initialRecovery }: PracticeClientProps) {
  const restored = initialRecovery?.pending ?? initialRecovery?.current;
  const [showRecovery, setShowRecovery] = useState(Boolean(initialRecovery));
  const [item, setItem] = useState(initialItem);
  const [answerValue, setAnswerValue] = useState(restored?.answer ?? "");
  const [attemptId, setAttemptId] = useState(() => restored?.attemptId ?? crypto.randomUUID());
  const [feedback, setFeedback] = useState<PracticePreviewResult | null>(() => restored?.checked ? getInstantPracticeFeedback(restored.item.exercise, restored.answer) : null);
  const [manualRating, setManualRating] = useState<FsrsRating | null>(restored?.rating ?? null);
  const [submittedResponseMs, setSubmittedResponseMs] = useState<number | null>(restored?.responseMs ?? null);
  const [flagFormOpen, setFlagFormOpen] = useState(false);
  const [selectedFlagReasons, setSelectedFlagReasons] = useState<ExerciseFlagReason[]>([]);
  const [otherFlagNote, setOtherFlagNote] = useState("");
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [statusNotice, setStatusNotice] = useState<PracticeStatusNotice | null>(null);
  const [, startTransition] = useTransition();
  const answerInputRef = useRef<HTMLInputElement>(null);
  const continueButtonRef = useRef<HTMLButtonElement>(null);
  const firstFlagReasonRef = useRef<HTMLInputElement>(null);
  const reportToggleRef = useRef<HTMLButtonElement>(null);
  const shouldFocusNextReadyAnswerRef = useRef(false);

  const timer = useVisibleElapsedMs(attemptId, item.status === "ready" && feedback === null);
  const checkedFeedback = feedback?.status === "checked" ? feedback : null;
  const isCorrect = checkedFeedback?.answerCheck.isCorrect === true;
  const selectedOtherFlag = selectedFlagReasons.includes(ExerciseFlagReason.OTHER);
  const canSubmitFlag =
    selectedFlagReasons.length > 0 && (!selectedOtherFlag || otherFlagNote.trim().length > 0);
  const scopedCollectionId = getScopedCollectionId(item);

  const [advancePending, setAdvancePending] = useState(false);
  const savingRef = useRef(false);
  const [preloaded, setPreloaded] = useState<Extract<PracticeItem, { status: "ready" }>[]>([]);
  const preloadRequest = useRef<{ key: string; promise: Promise<PracticeItem[]> } | null>(null);
  const pendingDraft = useRef<NormalDraft | undefined>(undefined);
  const deferredDraft = useRef<NormalDraft | undefined>(initialRecovery?.pending ? initialRecovery.current : initialRecovery?.deferred);
  const currentDraft = useRef<NormalDraft | undefined>(restored);
  const [protectedDraft, setProtectedDraft] = useState(true);
  const { finishSave, navigationMessage } = useReviewSaveGuard(advancePending, Boolean(answerValue) && !protectedDraft);
  useLayoutEffect(() => {
    const current: NormalDraft | undefined = item.status === "ready" ? { item, answer: answerValue, attemptId, checked: checkedFeedback !== null, rating: manualRating, responseMs: submittedResponseMs } : undefined;
    currentDraft.current = current;
    if (recoveryKey) setProtectedDraft(writeRecovery(recoveryKey, current && (current.answer || pendingDraft.current || deferredDraft.current) ? { current, pending: pendingDraft.current, deferred: deferredDraft.current } : null));
  }, [item, answerValue, attemptId, checkedFeedback, manualRating, submittedResponseMs, recoveryKey, advancePending]);
  useEffect(() => {
    if (item.status !== "ready" || advancePending || preloaded.length >= PRACTICE_BUFFER_LOW_WATER) return;
    let active = true;
    const key = [item.exercise.id, ...preloaded.map((next) => next.exercise.id)].join(":");
    if (preloadRequest.current?.key !== key) {
      preloadRequest.current = { key, promise: preloadPracticeBufferAction({
        collectionId: scopedCollectionId, skillId: item.skill.id,
        excludedSkillIds: preloaded.map((next) => next.skill.id), limit: PRACTICE_BUFFER_SIZE - preloaded.length,
      }) };
    }
    void preloadRequest.current.promise.then((items) => {
      const next = items.filter((candidate): candidate is Extract<PracticeItem, { status: "ready" }> => candidate.status === "ready");
      if (active && next.length) setPreloaded((current) => appendPracticeBuffer(current, next, (candidate) => candidate.exercise.id));
    }).catch(() => {});
    return () => { active = false; };
  }, [item, scopedCollectionId, advancePending, preloaded]);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") { preloadRequest.current = null; setPreloaded([]); } };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);

  const resetAttemptState = useCallback(() => {
    setShowRecovery(false);
    setAnswerValue("");
    setAttemptId(crypto.randomUUID());
    setFeedback(null);
    setManualRating(null);
    setSubmittedResponseMs(null);
    setFlagFormOpen(false);
    setSelectedFlagReasons([]);
    setOtherFlagNote("");
    setPendingAction(null);
    setStatusNotice(null);
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
    setStatusNotice(null);
    const result = getInstantPracticeFeedback(item.exercise, answerValue);
    if (isTerminalPreviewResult(result)) {
      setFeedback(result);
      setManualRating(result.proposedRating);
    } else {
      setFeedback(null);
      setManualRating(null);
      setStatusNotice(createStatusNotice(getPreviewStatusMessage(result)));
    }
  }, [answerValue, item, pendingAction, timer]);

  const handleContinue = useCallback(() => {
    if (
      item.status !== "ready" ||
      !isAnswerReady(answerValue) ||
      feedback?.status !== "checked" ||
      pendingAction !== null
    ) {
      return;
    }

    if (savingRef.current) return;
    savingRef.current = true;
    pendingDraft.current = currentDraft.current;
    if (recoveryKey && pendingDraft.current) writeRecovery(recoveryKey, { current: pendingDraft.current, pending: pendingDraft.current, deferred: deferredDraft.current });
    setAdvancePending(true);
    const next = preloaded[0] ?? null;
    setPreloaded((current) => current.slice(1));
    const restore = (message: string) => {
      if (currentDraft.current?.item.exercise.id !== item.exercise.id) deferredDraft.current = currentDraft.current;
      pendingDraft.current = undefined;
      finishSave(false);
      setShowRecovery(true);
      setPreloaded([]);
      preloadRequest.current = null;
      setItem(item);
      setAnswerValue(answerValue);
      setAttemptId(attemptId);
      setFeedback(feedback);
      setManualRating(manualRating);
      setSubmittedResponseMs(submittedResponseMs);
      setPendingAction(null);
      setStatusNotice(createStatusNotice(message));
    };
    if (next) {
      shouldFocusNextReadyAnswerRef.current = true;
      setItem(next);
      resetAttemptState();
    } else {
      setPendingAction("continue");
      setStatusNotice(null);
    }
    void confirmReviewSave(commitPracticeReviewAction({
      exerciseId: item.exercise.id, submittedAnswer: answerValue,
      responseMs: submittedResponseMs ?? timer.getElapsedMs(), attemptId,
      mixedReview: true, reducedRuleCues: true,
      manualRating: feedback.answerCheck.isCorrect ? manualRating : null,
      collectionId: scopedCollectionId,
    })).then((result) => {
      if (result.status !== "committed") { restore(result.message); return; }
      pendingDraft.current = undefined;
      finishSave(true);
      const recoveredNext = deferredDraft.current;
      if (recoveredNext && result.nextItem.status === "ready" && recoveredNext.item.exercise.id === result.nextItem.exercise.id) {
        setItem(result.nextItem); setAnswerValue(recoveredNext.answer); setAttemptId(recoveredNext.attemptId);
        setFeedback(recoveredNext.checked ? getInstantPracticeFeedback(result.nextItem.exercise, recoveredNext.answer) : null);
        setManualRating(recoveredNext.rating); setSubmittedResponseMs(recoveredNext.responseMs);
        deferredDraft.current = undefined;
        return;
      }
      deferredDraft.current = undefined;
      const same = next && result.nextItem.status === "ready" && result.nextItem.exercise.id === next.exercise.id;
      if (!same) {
        setPreloaded([]);
        preloadRequest.current = null;
        shouldFocusNextReadyAnswerRef.current = true;
        setItem(result.nextItem);
        resetAttemptState();
      }
      setStatusNotice(createStatusNotice(result.idempotent ? "Review already saved." : "Review saved."));
    }).catch(() => restore("Could not confirm the save. Your checked answer is restored. Press Continue to retry."))
      .finally(() => { savingRef.current = false; setAdvancePending(false); setPendingAction(null); });
  }, [attemptId, answerValue, feedback, item, manualRating, pendingAction, preloaded, resetAttemptState, scopedCollectionId, submittedResponseMs, timer, recoveryKey, finishSave]);

  const handleFlagSubmit = useCallback(() => {
    if (savingRef.current) return;
    if (
      item.status !== "ready" ||
      feedback?.status !== "checked" ||
      pendingAction !== null ||
      !canSubmitFlag
    ) {
      return;
    }

    setPendingAction("flag");
    setStatusNotice(null);

    startTransition(async () => {
      const result = await flagPracticeExerciseAction({
        mixedReview: true,
        previousSkillId: item.skill.id,
        exerciseId: item.exercise.id,
        reasons: selectedFlagReasons,
        otherNote: otherFlagNote,
        collectionId: scopedCollectionId,
      });

      setPendingAction(null);

      if (result.status === "flagged") {
        setPreloaded([]);
        preloadRequest.current = null;
        setItem(result.nextItem);
        resetAttemptState();
        setStatusNotice(createStatusNotice(result.message));
      } else {
        setStatusNotice(createStatusNotice(result.message));
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
    setStatusNotice(null);

    startTransition(async () => {
      const result: ChoicePracticeSeedResult = await ensureDevPracticeSampleDataAction();
      setPendingAction(null);

      if (result.status === "ready") {
        setItem(result.nextItem);
        resetAttemptState();
      }

      setStatusNotice(createStatusNotice(result.message, getSampleDataStatusTone(result.status)));
    });
  }, [pendingAction, resetAttemptState, startTransition]);

  useEffect(() => {
    const focusTarget = window.requestAnimationFrame(() => {
      if (checkedFeedback) {
        continueButtonRef.current?.focus();
        return;
      }

      if (!shouldFocusNextReadyAnswerRef.current) {
        return;
      }

      shouldFocusNextReadyAnswerRef.current = false;

      if (item.status === "ready" && item.exercise.answerKind !== AnswerKind.CHOICE) {
        answerInputRef.current?.focus({ preventScroll: true });
      }
    });

    return () => window.cancelAnimationFrame(focusTarget);
  }, [attemptId, checkedFeedback, item]);

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
            preparing={item.preparing}
            dailyLimitReached={item.dailyLimitReached}
            canUseSampleData={canUseSampleData && !scoped}
            message={item.message}
            onSampleData={handleSampleData}
            pendingSample={pendingAction === "sample"}
            scoped={scoped}
            statusNotice={statusNotice}
          />
        ) : (
          <section className="practiceFrame practiceEmpty" aria-labelledby="practice-empty-title">
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
            <PracticeStatusMessage notice={statusNotice} />
          </section>
        )}
      </>
    );
  }

  const exercise = item.exercise;
  const isNumericExercise = exercise.answerKind === AnswerKind.NUMERIC;
  const isMathExercise = exercise.answerKind === AnswerKind.MATH;

  return (
    <>
      <div className="practiceToolbar">
        <PracticeScopeBar scope={item.scope} />
      </div>
      <section className="practiceFrame" aria-label="Practice exercise" data-next-ready={preloaded.length > 0} data-buffered-count={preloaded.length}>
        {showRecovery ? <RecoveryNotice storageKey={recoveryKey} saving={advancePending} /> : null}
        <div className="practiceMetaRow">
          <div>
            <p className="practiceMetaSummary tnum">
              {formatFsrsState(item.skill.fsrsState)} · {formatElapsed(checkedFeedback ? submittedResponseMs ?? timer.elapsedMs : timer.elapsedMs)}
            </p>
          </div>
          {advancePending || navigationMessage ? <p role="status" className="practiceMetaSummary">{navigationMessage ?? "Saving…"}</p> : null}
        </div>

      <PracticePrompt text={exercise.prompt} />

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
            maxLength={
              isMathExercise
                ? MAX_MATH_EXPRESSION_LENGTH
                : isNumericExercise
                  ? MAX_NUMERIC_ANSWER_LENGTH
                  : MAX_TEXT_ANSWER_LENGTH
            }
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
              shortcut="Enter"
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
              <dd style={{ whiteSpace: "pre-wrap" }}>
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
                disabled={pendingAction !== null}
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
            disabled={advancePending || pendingAction !== null || feedback.status !== "checked"}
            onClick={handleContinue}
            ref={continueButtonRef}
          >
            <PendingButtonContent
              active={pendingAction === "continue"}
              idleText="Continue"
              pendingText="Saving"
              shortcut="Enter"
            />
          </button>
        </div>
      ) : null}

      {checkedFeedback && !flagFormOpen ? (
        <div className="flagExerciseInline">
          <button
            ref={reportToggleRef}
            className="quietButton"
            type="button"
            disabled={pendingAction !== null}
            aria-expanded={false}
            onClick={() => setFlagFormOpen(true)}
          >
            <Flag size={15} weight="regular" aria-hidden="true" />
            Report issue
          </button>
        </div>
      ) : null}

      {checkedFeedback && flagFormOpen ? (
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
              aria-controls="practice-report-form"
              aria-expanded={flagFormOpen}
              onClick={() => setFlagFormOpen((open) => !open)}
            >
              Close report
            </button>
          </div>

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
        </section>
      ) : null}
      <PracticeStatusMessage notice={statusNotice} />
      </section>
    </>
  );
}

function PracticeScopeBar({ scope }: { scope?: PracticeScope }) {
  return (
    <div className="practiceScopeBar" aria-label="Practice scope">
      <div className="practiceScopeIdentity">
        {scope?.kind === "collection" ? (
          <Link href="/practice" aria-label="All practice" title="Return to all practice">
            <strong>All practice</strong>
          </Link>
        ) : <strong>All practice</strong>}
      </div>
      <div className="practiceScopeLinks">
        <Link href="/practice/custom">Custom session</Link>
        <Link href="/practice/attention">Needs attention</Link>

      </div>
    </div>
  );
}

function getScopedCollectionId(item: PracticeItem): string | null {
  return item.scope?.kind === "collection" ? item.scope.collectionId : null;
}

function PracticeCompleteState({
  preparing,
  dailyLimitReached,
  canUseSampleData,
  message,
  onSampleData,
  pendingSample,
  scoped,
  statusNotice,
}: {
  preparing?: boolean;
  dailyLimitReached?: boolean;
  canUseSampleData: boolean;
  message: string;
  onSampleData: () => void;
  pendingSample: boolean;
  scoped: boolean;
  statusNotice: PracticeStatusNotice | null;
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
        <h1 id="practice-empty-title">{preparing ? "Exercises need preparation." : dailyLimitReached ? "Daily new-skill limit reached." : "Nice work. You're all caught up."}</h1>
        <p>
          {preparing ? "Due skills are waiting for compatible exercises. Check their preparation status or refresh to try again." : dailyLimitReached ? "You can continue scheduled reviews or change your daily limit in Settings." : scoped
            ? "Every due exercise in this collection is finished for now."
            : "Every due exercise is finished for now."}{" "}
          LearnRecur will bring skills back when the schedule says they are ready.
        </p>
      </div>
      <div className="practiceCompleteSummary" aria-label="Practice completion summary">
        <div>
          <span>Queue</span>
          <strong>{preparing ? "Preparation pending" : dailyLimitReached ? "New skills paused" : "Clear for now"}</strong>
        </div>
        <div>
          <span>Schedule</span>
          <strong>{message}</strong>
        </div>
      </div>
      <PracticeCompleteActions scoped={scoped} dailyLimitReached={dailyLimitReached} />
      {statusNotice ? (
        <p
          className="practiceCompleteStatus"
          data-tone={statusNotice.tone}
          aria-live="polite"
          role="status"
        >
          {statusNotice.tone === "saved" ? (
            <CheckCircle size={16} weight="bold" aria-hidden="true" />
          ) : null}
          <span>{statusNotice.message}</span>
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

function PracticeCompleteActions({ scoped, dailyLimitReached }: { scoped: boolean; dailyLimitReached?: boolean }) {
  return (
    <div className="practiceCompleteActions" aria-label="Practice next actions">
      {scoped ? (
        <>
          <Link className="secondaryButton" href="/dashboard">
            Dashboard
          </Link>
          <Link className="primaryButton" href="/practice">
            Try all practice
          </Link>
        </>
      ) : (
        <>
          <Link className="secondaryButton" href="/skills">
            Review skills
          </Link>
          <Link className="primaryButton" href="/dashboard">
            Dashboard
          </Link>
        </>
      )}
      {dailyLimitReached ? <Link href="/settings" className="secondaryButton">Change daily limit</Link> : null}
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

function PracticeStatusMessage({ notice }: { notice: PracticeStatusNotice | null }) {
  if (!notice) {
    return null;
  }

  return (
    <p
      className="practiceStatusLine"
      data-tone={notice.tone}
      aria-live="polite"
      role="status"
    >
      {notice.tone === "saved" ? <CheckCircle size={17} weight="bold" aria-hidden="true" /> : null}
      <span>{notice.message}</span>
    </p>
  );
}

function createStatusNotice(
  message: string,
  tone: PracticeStatusTone = REVIEW_SAVED_MESSAGES.has(message) ? "saved" : "neutral",
): PracticeStatusNotice {
  return { message, tone };
}

function getSampleDataStatusTone(status: ChoicePracticeSeedResult["status"]): PracticeStatusTone {
  if (status === "ready") {
    return "saved";
  }

  return status === "error" ? "error" : "neutral";
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
  shortcut,
}: {
  active: boolean;
  idleText: string;
  pendingText: string;
  shortcut?: string;
}) {
  return (
    <span className="buttonPendingContent">
      {active ? <span className="buttonSpinner" aria-hidden="true" /> : null}
      <span>{active ? pendingText : idleText}</span>
      {!active && shortcut ? <kbd aria-hidden="true">{shortcut}</kbd> : null}
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
