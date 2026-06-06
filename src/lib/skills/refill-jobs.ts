import "server-only";

import {
  GenerationJobKind,
  GenerationJobStatus,
  Prisma,
  SkillStatus,
} from "@/generated/prisma/client";
import { formatEnvError } from "@/lib/env";
import { getInngestEnvStatus } from "@/lib/inngest/client";
import {
  inngestExerciseRefillEventSender,
  type ExerciseRefillEventPayload,
  type ExerciseRefillEventSender,
} from "@/lib/inngest/events";
import { getPrisma } from "@/lib/prisma";

import {
  DEFAULT_READY_EXACT_INPUT_TARGET,
  DEFAULT_READY_EXERCISE_TARGET,
  GEMINI_PROVIDER,
  SKILL_EXACT_INPUT_PROMPT_VERSION,
  SKILL_MCQ_PROMPT_VERSION,
  countChoiceExerciseInventory,
  countExactInputExerciseInventory,
  isExactInputUnlocked,
  refillChoiceExercisesForSkill,
  refillExactInputExercisesForSkill,
  type ChoiceExerciseGenerator,
  type ChoiceExerciseVerifier,
  type ExactInputExerciseGenerator,
  type ExactInputExerciseVerifier,
  type ExactInputExerciseRefillResult,
  type SkillExerciseRefillResult,
} from ".";

export type RefillQueueResult =
  | {
      status: "queued";
      skillId: string;
      generationJobId: string;
      requestedCount: number;
      readyExerciseCount: number;
      targetReadyCount: number;
      message: string;
    }
  | {
      status: "not-queued";
      reason:
        | "already-at-target"
        | "event-send-failed"
        | "exact-input-locked"
        | "job-in-progress"
        | "skill-not-active";
      message: string;
      generationJobId?: string;
      readyExerciseCount?: number;
      targetReadyCount?: number;
    }
  | {
      status: "missing-inngest-env";
      message: string;
    }
  | {
      status: "not-found";
      reason: "skill-not-found";
      message: string;
    };

type QueueExerciseRefillInput = {
  userId: string;
  skillId: string;
  now: Date;
  targetReadyCount?: number;
  sender?: ExerciseRefillEventSender;
  model?: string;
};

type RunChoiceExerciseRefillJobInput = ExerciseRefillEventPayload & {
  now?: Date;
  generateChoiceExercises?: ChoiceExerciseGenerator;
  verifyChoiceExercises?: ChoiceExerciseVerifier;
  model?: string;
};

type RunExactInputExerciseRefillJobInput = ExerciseRefillEventPayload & {
  now?: Date;
  generateExactInputExercises?: ExactInputExerciseGenerator;
  verifyExactInputExercises?: ExactInputExerciseVerifier;
  model?: string;
};

const ACTIVE_GENERATION_JOB_STATUSES = [
  GenerationJobStatus.PENDING,
  GenerationJobStatus.RUNNING,
] as const;

export async function queueChoiceExerciseRefillForSkill(
  input: QueueExerciseRefillInput,
): Promise<RefillQueueResult> {
  const prisma = getPrisma();
  const targetReadyCount = normalizeQueueTarget(
    input.targetReadyCount,
    DEFAULT_READY_EXERCISE_TARGET,
  );
  const skill = await prisma.skill.findFirst({
    where: {
      id: input.skillId,
      userId: input.userId,
    },
    select: {
      id: true,
      status: true,
      exercises: {
        select: {
          answerKind: true,
          verificationStatus: true,
          retiredAt: true,
          choices: true,
        },
      },
    },
  });

  if (!skill) {
    return skillNotFound();
  }

  if (skill.status !== SkillStatus.ACTIVE) {
    return skillNotActive("Only active skills can queue more practice exercises.");
  }

  const activeJob = await findActiveGenerationJob(
    input.userId,
    skill.id,
    GenerationJobKind.CHOICE_EXERCISE_GENERATION,
  );

  if (activeJob) {
    return jobInProgress(activeJob.id, "Choice exercise generation is already queued or running.");
  }

  const inventory = countChoiceExerciseInventory(skill.exercises);

  if (inventory.readyExerciseCount >= targetReadyCount) {
    return alreadyAtTarget(
      "This skill already has enough ready practice exercises.",
      inventory.readyExerciseCount,
      targetReadyCount,
    );
  }

  return queueExerciseRefillJob({
    input,
    kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
    promptVersion: SKILL_MCQ_PROMPT_VERSION,
    requestedCount: targetReadyCount - inventory.readyExerciseCount,
    readyExerciseCount: inventory.readyExerciseCount,
    targetReadyCount,
    sendEvent: (sender, payload) => sender.sendChoiceRefillRequested(payload),
  });
}

export async function queueExactInputExerciseRefillForSkill(
  input: QueueExerciseRefillInput,
): Promise<RefillQueueResult> {
  const prisma = getPrisma();
  const targetReadyCount = normalizeQueueTarget(
    input.targetReadyCount,
    DEFAULT_READY_EXACT_INPUT_TARGET,
  );
  const skill = await prisma.skill.findFirst({
    where: {
      id: input.skillId,
      userId: input.userId,
    },
    select: {
      id: true,
      status: true,
      repetitions: true,
      exercises: {
        select: {
          answerKind: true,
          verificationStatus: true,
          retiredAt: true,
          answerSpec: true,
        },
      },
    },
  });

  if (!skill) {
    return skillNotFound();
  }

  if (skill.status !== SkillStatus.ACTIVE) {
    return skillNotActive("Only active skills can queue exact-input practice.");
  }

  if (!isExactInputUnlocked(skill.repetitions)) {
    return {
      status: "not-queued",
      reason: "exact-input-locked",
      message: "Practice multiple-choice reviews first before queueing exact-input exercises.",
    };
  }

  const activeJob = await findActiveGenerationJob(
    input.userId,
    skill.id,
    GenerationJobKind.EXACT_INPUT_EXERCISE_GENERATION,
  );

  if (activeJob) {
    return jobInProgress(activeJob.id, "Exact-input generation is already queued or running.");
  }

  const inventory = countExactInputExerciseInventory(skill.exercises);

  if (inventory.readyExerciseCount >= targetReadyCount) {
    return alreadyAtTarget(
      "This skill already has enough ready exact-input exercises.",
      inventory.readyExerciseCount,
      targetReadyCount,
    );
  }

  return queueExerciseRefillJob({
    input,
    kind: GenerationJobKind.EXACT_INPUT_EXERCISE_GENERATION,
    promptVersion: SKILL_EXACT_INPUT_PROMPT_VERSION,
    requestedCount: targetReadyCount - inventory.readyExerciseCount,
    readyExerciseCount: inventory.readyExerciseCount,
    targetReadyCount,
    sendEvent: (sender, payload) => sender.sendExactInputRefillRequested(payload),
  });
}

export async function runChoiceExerciseRefillJob(
  input: RunChoiceExerciseRefillJobInput,
): Promise<SkillExerciseRefillResult> {
  return refillChoiceExercisesForSkill({
    userId: input.userId,
    skillId: input.skillId,
    generationJobId: input.generationJobId,
    targetReadyCount: input.targetReadyCount,
    now: input.now ?? new Date(),
    generateChoiceExercises: input.generateChoiceExercises,
    verifyChoiceExercises: input.verifyChoiceExercises,
    model: input.model,
  });
}

export async function runExactInputExerciseRefillJob(
  input: RunExactInputExerciseRefillJobInput,
): Promise<ExactInputExerciseRefillResult> {
  return refillExactInputExercisesForSkill({
    userId: input.userId,
    skillId: input.skillId,
    generationJobId: input.generationJobId,
    targetReadyCount: input.targetReadyCount,
    now: input.now ?? new Date(),
    generateExactInputExercises: input.generateExactInputExercises,
    verifyExactInputExercises: input.verifyExactInputExercises,
    model: input.model,
  });
}

async function queueExerciseRefillJob({
  input,
  kind,
  promptVersion,
  requestedCount,
  readyExerciseCount,
  targetReadyCount,
  sendEvent,
}: {
  input: QueueExerciseRefillInput;
  kind: GenerationJobKind;
  promptVersion: string;
  requestedCount: number;
  readyExerciseCount: number;
  targetReadyCount: number;
  sendEvent: (
    sender: ExerciseRefillEventSender,
    payload: ExerciseRefillEventPayload,
  ) => Promise<void>;
}): Promise<RefillQueueResult> {
  const envStatus = input.sender ? null : getInngestEnvStatus();

  if (envStatus?.status === "missing-env") {
    return {
      status: "missing-inngest-env",
      message: envStatus.message,
    };
  }

  const prisma = getPrisma();
  const sender = input.sender ?? inngestExerciseRefillEventSender;
  let generationJob: { id: string };

  try {
    generationJob = await prisma.generationJob.create({
      data: {
        userId: input.userId,
        skillId: input.skillId,
        kind,
        status: GenerationJobStatus.PENDING,
        provider: GEMINI_PROVIDER,
        model: input.model?.trim() || process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash",
        promptVersion,
        requestedCount,
      },
      select: {
        id: true,
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }

    const activeJob = await findActiveGenerationJob(input.userId, input.skillId, kind);

    if (!activeJob) {
      throw error;
    }

    return jobInProgress(activeJob.id, "Exercise generation is already queued or running.");
  }

  try {
    await sendEvent(sender, {
      userId: input.userId,
      skillId: input.skillId,
      generationJobId: generationJob.id,
      targetReadyCount,
      requestedAt: input.now.toISOString(),
    });
  } catch (error) {
    const message = `Inngest refill event failed: ${formatEnvError(error)}`;
    await prisma.generationJob.update({
      where: {
        id: generationJob.id,
      },
      data: {
        status: GenerationJobStatus.FAILED,
        errorMessage: message,
        completedAt: input.now,
      },
    });

    return {
      status: "not-queued",
      reason: "event-send-failed",
      message,
      generationJobId: generationJob.id,
      readyExerciseCount,
      targetReadyCount,
    };
  }

  return {
    status: "queued",
    skillId: input.skillId,
    generationJobId: generationJob.id,
    requestedCount,
    readyExerciseCount,
    targetReadyCount,
    message: "Refill queued. Refresh in a moment to see the updated exercise inventory.",
  };
}

async function findActiveGenerationJob(
  userId: string,
  skillId: string,
  kind: GenerationJobKind,
): Promise<{ id: string } | null> {
  return getPrisma().generationJob.findFirst({
    where: {
      userId,
      skillId,
      kind,
      status: {
        in: [...ACTIVE_GENERATION_JOB_STATUSES],
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      id: true,
    },
  });
}

function normalizeQueueTarget(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(1, Math.min(50, Math.trunc(value)));
}

function skillNotFound(): Extract<RefillQueueResult, { status: "not-found" }> {
  return {
    status: "not-found",
    reason: "skill-not-found",
    message: "Skill was not found.",
  };
}

function skillNotActive(message: string): Extract<RefillQueueResult, { status: "not-queued" }> {
  return {
    status: "not-queued",
    reason: "skill-not-active",
    message,
  };
}

function alreadyAtTarget(
  message: string,
  readyExerciseCount: number,
  targetReadyCount: number,
): Extract<RefillQueueResult, { status: "not-queued" }> {
  return {
    status: "not-queued",
    reason: "already-at-target",
    message,
    readyExerciseCount,
    targetReadyCount,
  };
}

function jobInProgress(
  generationJobId: string,
  message: string,
): Extract<RefillQueueResult, { status: "not-queued" }> {
  return {
    status: "not-queued",
    reason: "job-in-progress",
    message,
    generationJobId,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
