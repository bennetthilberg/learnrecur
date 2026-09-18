import "server-only";

import { AnswerKind } from "@/generated/prisma/client";
import type { ExerciseRefillEventSender } from "@/lib/jobs/events";
import {
  queueChoiceExerciseRefillForSkill,
  queueExactInputExerciseRefillForSkill,
  queueMathExerciseRefillForSkill,
  type RefillQueueResultWithDeferredEvent,
} from "@/lib/skills/refill-jobs";
import { getPrisma } from "@/lib/prisma";

export type ExerciseReplacementResult =
  | {
      status: "queued";
      generationJobId: string;
      requestedCount: number;
      readyExerciseCount: number;
      targetReadyCount: number;
      message: string;
    }
  | {
      status: "deferred";
      generationJobId: string;
      readyExerciseCount: number;
      targetReadyCount: number;
      retryAt: string;
      message: string;
    }
  | {
      status: "already-ready";
      readyExerciseCount: number;
      targetReadyCount: number;
      message: string;
    }
  | {
      status: "in-progress";
      generationJobId: string;
      readyExerciseCount?: number;
      targetReadyCount?: number;
      message: string;
    }
  | {
      status: "unavailable";
      reason: "not-found" | "exact-input-locked" | "skill-not-active" | "unsupported-answer-kind";
      message: string;
    }
  | {
      status: "failed";
      message: string;
    };

/**
 * Start bounded replacement preparation after a confirmed quality decision.
 * This runs after the correction transaction commits so a transport or
 * provider failure cannot roll back the durable schedule repair.
 */
export async function queueExerciseReplacement(input: {
  userId: string;
  exerciseId: string;
  now: Date;
  sender?: ExerciseRefillEventSender;
  model?: string;
}): Promise<ExerciseReplacementResult> {
  try {
    const exercise = await getPrisma().exercise.findFirst({
      where: { id: input.exerciseId, userId: input.userId },
      select: { skillId: true, answerKind: true },
    });

    if (!exercise) {
      return {
        status: "unavailable",
        reason: "not-found",
        message: "The confirmed exercise is no longer available for replacement preparation.",
      };
    }

    const result = await queueForAnswerKind({
      userId: input.userId,
      skillId: exercise.skillId,
      answerKind: exercise.answerKind,
      now: input.now,
      sender: input.sender,
      model: input.model,
    });
    return toReplacementResult(result);
  } catch (error) {
    console.error("Replacement preparation failed", {
      exerciseId: input.exerciseId,
      error,
    });
    return {
      status: "failed",
      message: "The schedule correction succeeded, but replacement preparation could not start. Retry preparation from the skill later.",
    };
  }
}

async function queueForAnswerKind(input: {
  userId: string;
  skillId: string;
  answerKind: AnswerKind;
  now: Date;
  sender?: ExerciseRefillEventSender;
  model?: string;
}): Promise<RefillQueueResultWithDeferredEvent> {
  const common = {
    userId: input.userId,
    skillId: input.skillId,
    now: input.now,
    sender: input.sender,
    model: input.model,
  };

  switch (input.answerKind) {
    case AnswerKind.CHOICE:
      return queueChoiceExerciseRefillForSkill(common);
    case AnswerKind.TEXT:
    case AnswerKind.NUMERIC:
      return queueExactInputExerciseRefillForSkill(common);
    case AnswerKind.MATH:
      return queueMathExerciseRefillForSkill(common);
    default:
      throw new Error("This exercise type does not have a replacement preparation path.");
  }
}

function toReplacementResult(
  result: RefillQueueResultWithDeferredEvent,
): ExerciseReplacementResult {
  switch (result.status) {
    case "queued":
      return {
        status: "queued",
        generationJobId: result.generationJobId,
        requestedCount: result.requestedCount,
        readyExerciseCount: result.readyExerciseCount,
        targetReadyCount: result.targetReadyCount,
        message: result.message,
      };
    case "deferred":
      return {
        status: "deferred",
        generationJobId: result.generationJobId,
        readyExerciseCount: result.readyExerciseCount,
        targetReadyCount: result.targetReadyCount,
        retryAt: result.retryAt,
        message: result.message,
      };
    case "not-found":
      return {
        status: "unavailable",
        reason: "not-found",
        message: result.message,
      };
    case "missing-jobs-env":
      return {
        status: "failed",
        message: result.message,
      };
    case "not-queued":
      switch (result.reason) {
        case "already-at-target":
          return {
            status: "already-ready",
            readyExerciseCount: result.readyExerciseCount ?? 0,
            targetReadyCount: result.targetReadyCount ?? 0,
            message: result.message,
          };
        case "job-in-progress":
          return {
            status: "in-progress",
            generationJobId: result.generationJobId ?? "",
            readyExerciseCount: result.readyExerciseCount,
            targetReadyCount: result.targetReadyCount,
            message: result.message,
          };
        case "exact-input-locked":
          return {
            status: "unavailable",
            reason: "exact-input-locked",
            message: result.message,
          };
        case "skill-not-active":
          return {
            status: "unavailable",
            reason: "skill-not-active",
            message: result.message,
          };
        case "event-send-failed":
        case "quota-exceeded":
          return {
            status: "failed",
            message: result.message,
          };
      }
  }
}
