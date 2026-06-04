"use server";

import { auth, currentUser } from "@clerk/nextjs/server";

import { AnswerKind, ExerciseFlagReason, FsrsRating } from "@/generated/prisma/client";
import {
  commitPracticeReview,
  flagPracticeExercise,
  previewPracticeAnswer,
  type PracticeSubmittedAnswer,
} from "@/lib/practice";
import { ensureDevPracticeSampleData } from "@/lib/practice/sample-data";
import { ensureDatabaseUser } from "@/lib/users";

import { getNextChoicePracticeItemForUser } from "./queries";
import type {
  ChoicePracticeCommitResult,
  ChoicePracticeFlagResult,
  ChoicePracticePreviewResult,
  ChoicePracticeSeedResult,
} from "./types";

type PreviewChoicePracticeAnswerInput = {
  exerciseId: string;
  selectedChoiceId: string;
  responseMs: number;
};

type CommitChoicePracticeReviewInput = PreviewChoicePracticeAnswerInput & {
  attemptId: string;
  manualRating?: FsrsRating | null;
};

type FlagChoicePracticeExerciseInput = {
  exerciseId: string;
  reasons: string[];
  otherNote?: string | null;
};

export async function previewChoicePracticeAnswerAction(
  input: PreviewChoicePracticeAnswerInput,
): Promise<ChoicePracticePreviewResult> {
  const userId = await requirePracticeUserId();
  const result = await previewPracticeAnswer({
    userId,
    exerciseId: input.exerciseId,
    submittedAnswer: toSubmittedChoice(input.selectedChoiceId),
    responseMs: input.responseMs,
    answerKinds: [AnswerKind.CHOICE],
    now: new Date(),
  });

  if (result.status === "not-found") {
    return {
      status: "not-found",
      message: result.message,
    };
  }

  return result;
}

export async function commitChoicePracticeReviewAction(
  input: CommitChoicePracticeReviewInput,
): Promise<ChoicePracticeCommitResult> {
  const userId = await requirePracticeUserId();
  const reviewedAt = new Date();
  const result = await commitPracticeReview({
    userId,
    exerciseId: input.exerciseId,
    attemptId: input.attemptId,
    submittedAnswer: toSubmittedChoice(input.selectedChoiceId),
    responseMs: input.responseMs,
    manualRating: normalizeManualRating(input.manualRating),
    reviewedAt,
    answerKinds: [AnswerKind.CHOICE],
  });

  if (result.status === "committed") {
    return {
      status: "committed",
      idempotent: result.idempotent,
      finalRating: result.finalRating,
      nextItem: await getNextChoicePracticeItemForUser(userId, reviewedAt),
    };
  }

  if (result.status === "not-committed") {
    return {
      status: "not-committed",
      answerCheck: result.answerCheck,
      message: result.message,
    };
  }

  if (result.status === "conflict") {
    return {
      status: "conflict",
      message: result.message,
    };
  }

  return {
    status: "not-found",
    message: result.message,
  };
}

export async function flagChoicePracticeExerciseAction(
  input: FlagChoicePracticeExerciseInput,
): Promise<ChoicePracticeFlagResult> {
  const userId = await requirePracticeUserId();
  const flaggedAt = new Date();
  const reasons = input.reasons.filter(isExerciseFlagReason);

  if (reasons.length !== input.reasons.length) {
    return {
      status: "not-flagged",
      message: "Choose a valid report reason.",
    };
  }

  const result = await flagPracticeExercise({
    userId,
    exerciseId: input.exerciseId,
    reasons,
    otherNote: input.otherNote,
    flaggedAt,
  });

  if (result.status === "flagged") {
    return {
      status: "flagged",
      message: result.message,
      nextItem: await getNextChoicePracticeItemForUser(userId, flaggedAt),
    };
  }

  if (result.status === "not-flagged") {
    return {
      status: "not-flagged",
      message: result.message,
    };
  }

  return {
    status: "not-found",
    message: result.message,
  };
}

export async function ensureDevPracticeSampleDataAction(): Promise<ChoicePracticeSeedResult> {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();

  if (!clerkUser) {
    return {
      status: "error",
      message: "Could not load the signed-in Clerk user.",
    };
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);

  if (databaseUser.status !== "ready") {
    return {
      status: "error",
      message: databaseUser.message,
    };
  }

  const now = new Date();
  const result = await ensureDevPracticeSampleData({ userId, now });

  if (result.status === "disabled") {
    return result;
  }

  return {
    status: "ready",
    message: result.message,
    skillCount: result.skillCount,
    exerciseCount: result.exerciseCount,
    nextItem: await getNextChoicePracticeItemForUser(userId, now),
  };
}

async function requirePracticeUserId(): Promise<string> {
  const { userId } = await auth.protect();
  return userId;
}

function toSubmittedChoice(choiceId: string): PracticeSubmittedAnswer {
  return choiceId;
}

function normalizeManualRating(rating?: FsrsRating | null): FsrsRating | null {
  if (
    rating === FsrsRating.HARD ||
    rating === FsrsRating.GOOD ||
    rating === FsrsRating.EASY
  ) {
    return rating;
  }

  return null;
}

function isExerciseFlagReason(reason: string): reason is ExerciseFlagReason {
  return Object.values(ExerciseFlagReason).includes(reason as ExerciseFlagReason);
}
