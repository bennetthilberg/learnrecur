"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { z } from "zod";

import { ExerciseFlagReason, FsrsRating } from "@/generated/prisma/client";
import {
  commitPracticeReview,
  flagPracticeExerciseAndQueueRefill,
  MAX_EXERCISE_FLAG_OTHER_NOTE_LENGTH,
  previewPracticeAnswer,
  type PracticeSubmittedAnswer,
  type PracticeFlagRefillResult,
} from "@/lib/practice";
import { ensureDevPracticeSampleData } from "@/lib/practice/sample-data";
import { ensureDatabaseUser } from "@/lib/users";

import {
  getNextChoicePracticeItemForUser,
  getNextPracticeItemForUser,
  resolvePracticeScopeForUser,
  type PracticeScopeInput,
} from "./queries";
import type {
  ChoicePracticeCommitResult,
  ChoicePracticeFlagResult,
  ChoicePracticePreviewResult,
  ChoicePracticeSeedResult,
  PracticeCommitResult,
  PracticeFlagResult,
  PracticePreviewResult,
} from "./types";

type PreviewPracticeAnswerInput = {
  exerciseId: string;
  submittedAnswer: string;
  responseMs: number;
  collectionId?: string | null;
};

type CommitPracticeReviewInput = PreviewPracticeAnswerInput & {
  attemptId: string;
  manualRating?: FsrsRating | null;
};

type FlagChoicePracticeExerciseInput = {
  exerciseId: string;
  reasons: string[];
  otherNote?: string | null;
  collectionId?: string | null;
};

const flagChoicePracticeExerciseInputSchema = z.object({
  exerciseId: z.string().min(1),
  reasons: z.array(z.enum(ExerciseFlagReason)).min(1),
  otherNote: z.string().trim().max(MAX_EXERCISE_FLAG_OTHER_NOTE_LENGTH).nullable().optional(),
  collectionId: z.string().min(1).nullable().optional(),
});

export async function previewChoicePracticeAnswerAction(
  input: {
    exerciseId: string;
    selectedChoiceId: string;
    responseMs: number;
    collectionId?: string | null;
  },
): Promise<ChoicePracticePreviewResult> {
  return previewPracticeAnswerAction({
    exerciseId: input.exerciseId,
    submittedAnswer: input.selectedChoiceId,
    responseMs: input.responseMs,
    collectionId: input.collectionId,
  });
}

export async function previewPracticeAnswerAction(
  input: PreviewPracticeAnswerInput,
): Promise<PracticePreviewResult> {
  const practiceUser = await requirePracticeUserId();

  if (practiceUser.status !== "ready") {
    return {
      status: "not-found",
      message: practiceUser.message,
    };
  }

  const userId = practiceUser.userId;
  const scope = await resolveActivePracticeScope(userId, input);

  if (scope.status === "unavailable") {
    return {
      status: "not-found",
      message: scope.message,
    };
  }

  const result = await previewPracticeAnswer({
    userId,
    exerciseId: input.exerciseId,
    submittedAnswer: toSubmittedAnswer(input.submittedAnswer),
    responseMs: input.responseMs,
    now: new Date(),
    collectionId: scope.collectionId,
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
  input: {
    exerciseId: string;
    selectedChoiceId: string;
    responseMs: number;
    attemptId: string;
    manualRating?: FsrsRating | null;
    collectionId?: string | null;
  },
): Promise<ChoicePracticeCommitResult> {
  return commitPracticeReviewAction({
    exerciseId: input.exerciseId,
    submittedAnswer: input.selectedChoiceId,
    responseMs: input.responseMs,
    attemptId: input.attemptId,
    manualRating: input.manualRating,
    collectionId: input.collectionId,
  });
}

export async function commitPracticeReviewAction(
  input: CommitPracticeReviewInput,
): Promise<PracticeCommitResult> {
  const practiceUser = await requirePracticeUserId();

  if (practiceUser.status !== "ready") {
    return {
      status: "not-found",
      message: practiceUser.message,
    };
  }

  const userId = practiceUser.userId;
  const reviewedAt = new Date();
  const scope = await resolveActivePracticeScope(userId, input);

  if (scope.status === "unavailable") {
    return {
      status: "not-found",
      message: scope.message,
    };
  }

  const result = await commitPracticeReview({
    userId,
    exerciseId: input.exerciseId,
    attemptId: input.attemptId,
    submittedAnswer: toSubmittedAnswer(input.submittedAnswer),
    responseMs: input.responseMs,
    manualRating: normalizeManualRating(input.manualRating),
    reviewedAt,
    collectionId: scope.collectionId,
  });

  if (result.status === "committed") {
    return {
      status: "committed",
      idempotent: result.idempotent,
      finalRating: result.finalRating,
      nextItem: await getNextPracticeItemForUser(userId, reviewedAt, {
        collectionId: scope.collectionId,
      }),
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
  return flagPracticeExerciseAction(input);
}

export async function flagPracticeExerciseAction(
  input: unknown,
): Promise<PracticeFlagResult> {
  const practiceUser = await requirePracticeUserId();

  if (practiceUser.status !== "ready") {
    return {
      status: "not-found",
      message: practiceUser.message,
    };
  }

  const parsedInput = flagChoicePracticeExerciseInputSchema.safeParse(input);

  if (!parsedInput.success) {
    return {
      status: "not-flagged",
      message: "Choose a valid report reason and keep notes under 500 characters.",
    };
  }

  const flagInput = parsedInput.data;
  const userId = practiceUser.userId;
  const flaggedAt = new Date();
  const scope = await resolveActivePracticeScope(userId, flagInput);

  if (scope.status === "unavailable") {
    return {
      status: "not-found",
      message: scope.message,
    };
  }

  const result = await flagPracticeExerciseAndQueueRefill({
    userId,
    exerciseId: flagInput.exerciseId,
    reasons: flagInput.reasons,
    otherNote: flagInput.otherNote,
    flaggedAt,
    collectionId: scope.collectionId,
  });

  if (result.status === "flagged") {
    return {
      status: "flagged",
      message: formatFlagMessage(result.message, result.refill),
      nextItem: await getNextPracticeItemForUser(userId, flaggedAt, {
        collectionId: scope.collectionId,
      }),
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

async function requirePracticeUserId(): Promise<
  | {
      status: "ready";
      userId: string;
    }
  | {
      status: "error";
      message: string;
    }
> {
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

  return {
    status: "ready",
    userId,
  };
}

async function resolveActivePracticeScope(
  userId: string,
  input: PracticeScopeInput,
): ReturnType<typeof resolvePracticeScopeForUser> {
  return resolvePracticeScopeForUser(userId, {
    collectionId: input.collectionId,
  });
}

function toSubmittedAnswer(answer: string): PracticeSubmittedAnswer {
  return answer;
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

function formatFlagMessage(flagMessage: string, refill: PracticeFlagRefillResult): string {
  return `${flagMessage} ${formatFlagRefillMessage(refill)}`;
}

function formatFlagRefillMessage(refill: PracticeFlagRefillResult): string {
  if (refill.status === "queued") {
    return "A replacement exercise is being prepared.";
  }

  switch (refill.reason) {
    case "already-at-target":
      return "This skill already has enough replacement exercises ready.";
    case "exact-input-locked":
      return "Replacement exercises start after more multiple-choice practice.";
    case "job-in-progress":
      return "A replacement exercise is already being prepared.";
    case "unsupported-answer-kind":
      return "Replacement exercises are not available for this answer type yet.";
    default:
      return "Replacement preparation could not start.";
  }
}
