"use server";

import { after } from "next/server";
import { queueDueRetentionPreparation } from "@/lib/skills/retention-preparation";

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
import {
  commitCustomPracticeAnswer,
  createCustomPracticeSession,
  presentCustomPracticeSessionItem,
  previewCustomPracticeAnswer,
  resumeCustomPracticeSession,
  stopCustomPracticeSession,
  type CustomPracticeCommitResult,
  type CustomPracticePreviewResult,
  type CustomPracticeSessionView,
} from "@/lib/practice/custom-session";
import {
  customPracticeSessionModeSchema,
  customPracticeSessionScopeSchema,
} from "@/lib/practice/custom-session-contracts";
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
import type {
  CustomPracticeClientCommitResult,
  CustomPracticeClientPreviewResult,
  CustomPracticeClientView,
  CustomPracticeSessionCreateResult,
} from "./types";

type PreviewPracticeAnswerInput = {
  exerciseId: string;
  submittedAnswer: string;
  responseMs: number;
  collectionId?: string | null;
};

type CommitPracticeReviewInput = PreviewPracticeAnswerInput & {
  attemptId: string;
  mixedReview?: boolean;
  reducedRuleCues?: boolean;
  manualRating?: FsrsRating | null;
};

type FlagChoicePracticeExerciseInput = {
  exerciseId: string;
  reasons: string[];
  otherNote?: string | null;
  collectionId?: string | null;
};

const flagChoicePracticeExerciseInputSchema = z.object({
  mixedReview: z.boolean().optional(),
  previousSkillId: z.string().min(1).max(200).optional(),
  exerciseId: z.string().min(1),
  reasons: z.array(z.enum(ExerciseFlagReason)).min(1),
  otherNote: z.string().trim().max(MAX_EXERCISE_FLAG_OTHER_NOTE_LENGTH).nullable().optional(),
  collectionId: z.string().min(1).nullable().optional(),
});

// Selecting the first exercise writes an introduction marker, so do this only
// after Practice mounts in a visible tab, never during route rendering/prefetch.
export async function loadPracticeItemAction(rawInput: unknown) {
  const input = z.object({ collectionId: z.string().min(1).max(200).nullable(), mixedReview: z.boolean() }).parse(rawInput);
  const user = await requirePracticeUserId();
  if (user.status !== "ready") return { status: "unavailable" as const, message: user.message };
  const item = await getNextPracticeItemForUser(user.userId, new Date(), input);
  if (item.status !== "unavailable") after(async () => { await queueDueRetentionPreparation({ userId: user.userId, collectionId: input.collectionId, now: new Date() }); });
  return item;
}

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
    mixedReview: input.mixedReview === true,
    reducedRuleCues: input.mixedReview === true && input.reducedRuleCues === true,
    collectionId: scope.collectionId,
  });

  if (result.status === "committed") {
    after(async () => { await queueDueRetentionPreparation({userId,collectionId:scope.collectionId,now:new Date()}); });
    return {
      status: "committed",
      idempotent: result.idempotent,
      finalRating: result.finalRating,
      nextItem: await getNextPracticeItemForUser(userId, reviewedAt, {
        collectionId: scope.collectionId,
        mixedReview: input.mixedReview === true,
        previousSkillId: result.skill.id,
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

const customPracticeSessionActionInputSchema = z.strictObject({
  mode: customPracticeSessionModeSchema.optional(),
  targetCount: z.number().int().min(1).max(100).optional(),
  scope: customPracticeSessionScopeSchema,
});

export async function createCustomPracticeSessionAction(
  rawInput: unknown,
): Promise<CustomPracticeSessionCreateResult> {
  const practiceUser = await requirePracticeUserId();
  if (practiceUser.status !== "ready") {
    return { status: "unavailable", message: practiceUser.message };
  }

  const parsed = customPracticeSessionActionInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      status: "unavailable",
      message: "Choose a valid scope and an exercise count from 1 to 100.",
    };
  }

  const result = await createCustomPracticeSession({
    userId: practiceUser.userId,
    mode: parsed.data.mode,
    targetCount: parsed.data.targetCount,
    scope: parsed.data.scope,
  });
  if (result.status === "unavailable") return result;
  return {
    status: result.status,
    sessionId: result.session.id,
    message: "message" in result ? result.message : undefined,
  };
}

export async function loadCustomPracticeSessionItemAction(input: {
  sessionId: string;
}): Promise<CustomPracticeClientView> {
  const practiceUser = await requirePracticeUserId();
  if (practiceUser.status !== "ready") {
    return { status: "unavailable", message: practiceUser.message };
  }
  const sessionId = z.string().min(1).max(200).parse(input.sessionId);
  return toCustomPracticeClientView(
    await presentCustomPracticeSessionItem({
      userId: practiceUser.userId,
      sessionId,
    }),
  );
}

export async function previewCustomPracticeAnswerAction(input: {
  sessionId: string;
  itemKey: string;
  exerciseId: string;
  submittedAnswer: string;
  responseMs?: number | null;
}): Promise<CustomPracticeClientPreviewResult> {
  const practiceUser = await requirePracticeUserId();
  if (practiceUser.status !== "ready") {
    return { status: "unavailable", message: practiceUser.message };
  }
  const parsed = z
    .strictObject({
      sessionId: z.string().min(1).max(200),
      itemKey: z.string().regex(/^item-[0-9]{1,3}$/),
      exerciseId: z.string().min(1).max(200),
      submittedAnswer: z.string().max(10_000),
      responseMs: z.number().int().min(0).max(86_400_000).nullable().optional(),
    })
    .parse(input);
  const result = await previewCustomPracticeAnswer({
    userId: practiceUser.userId,
    ...parsed,
    submittedAnswer: parsed.submittedAnswer,
  });
  return toCustomPracticeClientPreviewResult(result);
}

export async function commitCustomPracticeAnswerAction(input: {
  sessionId: string;
  itemKey: string;
  exerciseId: string;
  submittedAnswer: string;
  responseMs?: number | null;
  manualRating?: FsrsRating | null;
  reducedRuleCues?: boolean;
}): Promise<CustomPracticeClientCommitResult> {
  const practiceUser = await requirePracticeUserId();
  if (practiceUser.status !== "ready") {
    return { status: "unavailable", message: practiceUser.message };
  }
  const parsed = z
    .strictObject({
      sessionId: z.string().min(1).max(200),
      itemKey: z.string().regex(/^item-[0-9]{1,3}$/),
      exerciseId: z.string().min(1).max(200),
      submittedAnswer: z.string().max(10_000),
      responseMs: z.number().int().min(0).max(86_400_000).nullable().optional(),
      manualRating: z.nativeEnum(FsrsRating).nullable().optional(),
      reducedRuleCues: z.boolean().optional(),
    })
    .parse(input);
  const result = await commitCustomPracticeAnswer({
    userId: practiceUser.userId,
    ...parsed,
    submittedAnswer: parsed.submittedAnswer,
  });
  return toCustomPracticeClientCommitResult(result);
}

export async function stopCustomPracticeSessionAction(input: {
  sessionId: string;
}): Promise<CustomPracticeClientView | { status: "unavailable"; message: string }> {
  return mutateCustomPracticeSessionAction(input, stopCustomPracticeSession);
}

export async function resumeCustomPracticeSessionAction(input: {
  sessionId: string;
}): Promise<CustomPracticeClientView | { status: "unavailable"; message: string }> {
  return mutateCustomPracticeSessionAction(input, resumeCustomPracticeSession);
}

async function mutateCustomPracticeSessionAction(
  input: { sessionId: string },
  mutation: typeof stopCustomPracticeSession,
): Promise<CustomPracticeClientView | { status: "unavailable"; message: string }> {
  const practiceUser = await requirePracticeUserId();
  if (practiceUser.status !== "ready") {
    return { status: "unavailable", message: practiceUser.message };
  }
  const sessionId = z.string().min(1).max(200).parse(input.sessionId);
  const result = await mutation({ userId: practiceUser.userId, sessionId });
  if (result.status !== "updated") {
    return { status: "unavailable", message: result.message };
  }
  return toCustomPracticeClientView(
    await presentCustomPracticeSessionItem({
      userId: practiceUser.userId,
      sessionId,
    }),
  );
}

function toCustomPracticeClientView(view: CustomPracticeSessionView): CustomPracticeClientView {
  if (view.status !== "ready") {
    return {
      status: view.status,
      session: view.session
        ? {
            id: view.session.id,
            mode: view.session.mode,
            mixedReview: view.session.scope.mixedReview,
            status: view.session.status,
            targetCount: view.session.targetCount,
            completedCount: view.session.completedCount,
          }
        : undefined,
      message: view.message,
    };
  }
  return {
    status: "ready",
    session: {
      id: view.session.id,
      mode: view.session.mode,
      mixedReview: view.session.scope.mixedReview,
      status: view.session.status,
      targetCount: view.session.targetCount,
      completedCount: view.session.completedCount,
    },
    item: {
      itemKey: view.sessionItem.itemKey,
      exerciseId: view.exercise.id,
      skillId: view.skill.id,
      skillTitle: view.skill.title,
      answerKind: view.exercise.answerKind,
      prompt: view.exercise.prompt,
      choices: toChoiceOptions(view.exercise.choices),
      difficulty: view.exercise.difficulty,
      expectedSeconds: view.exercise.expectedSeconds,
    },
  };
}

function toCustomPracticeClientPreviewResult(
  result: CustomPracticePreviewResult,
): CustomPracticeClientPreviewResult {
  if (result.status !== "checked") return result;
  return result;
}

function toCustomPracticeClientCommitResult(
  result: CustomPracticeCommitResult,
): CustomPracticeClientCommitResult {
  if (result.status !== "committed") return result;
  return {
    status: "committed",
    idempotent: result.idempotent,
    completedCount: result.completedCount,
    targetCount: result.targetCount,
    next: toCustomPracticeClientView(result.next),
  };
}

function toChoiceOptions(choices: unknown): Array<{ id: string; label: string }> {
  if (!Array.isArray(choices)) return [];
  return choices.flatMap((choice) => {
    if (
      typeof choice === "object" &&
      choice !== null &&
      !Array.isArray(choice) &&
      typeof choice.id === "string" &&
      typeof choice.label === "string"
    ) {
      return [{ id: choice.id, label: choice.label }];
    }
    return [];
  });
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
        mixedReview: flagInput.mixedReview,
        previousSkillId: flagInput.previousSkillId,
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
