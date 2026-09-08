import "server-only";

import {
  GenerationAuditDecision,
  GenerationFailureCategory,
  GenerationJobKind,
  GenerationJobStage,
  GenerationJobStatus,
  Prisma,
  SkillStatus,
} from "@/generated/prisma/client";
import { formatEnvError } from "@/lib/env";
import { DEFAULT_GEMINI_MODEL } from "@/lib/gemini";
import { getJobsEnvStatus } from "@/lib/jobs/config";
import {
  awsExerciseRefillEventSender,
  type ExerciseRefillEventPayload,
  type ExerciseRefillEventSender,
} from "@/lib/jobs/events";
import { getPrisma } from "@/lib/prisma";
import { checkExerciseRefillUsageLimit } from "@/lib/usage-limits";

import {
  DEFAULT_READY_EXACT_INPUT_TARGET,
  DEFAULT_READY_EXERCISE_TARGET,
  DEFAULT_READY_MATH_TARGET,
  GEMINI_PROVIDER,
  SKILL_EXACT_INPUT_PROMPT_VERSION,
  SKILL_MATH_PROMPT_VERSION,
  SKILL_MCQ_PROMPT_VERSION,
  countChoiceExerciseInventory,
  countExactInputExerciseInventory,
  countMathExerciseInventory,
  isExactInputUnlocked,
  refillChoiceExercisesForSkill,
  refillExactInputExercisesForSkill,
  refillMathExercisesForSkill,
  type ChoiceExerciseGenerator,
  type ChoiceExerciseVerifier,
  type ExactInputExerciseGenerator,
  type ExactInputExerciseVerifier,
  type ExactInputExerciseRefillResult,
  type MathExerciseGenerator,
  type MathExerciseRefillResult,
  type MathExerciseVerifier,
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
        | "quota-exceeded"
        | "skill-not-active";
      message: string;
      generationJobId?: string;
      readyExerciseCount?: number;
      targetReadyCount?: number;
    }
  | {
      status: "missing-jobs-env";
      message: string;
    }
  | {
      status: "not-found";
      reason: "skill-not-found";
      message: string;
    };

export type DeferredExerciseRefillEvent = {
  kind: "choice" | "exact-input" | "math";
  payload: ExerciseRefillEventPayload;
};

export type RefillQueueResultWithDeferredEvent = RefillQueueResult & {
  deferredEvent?: DeferredExerciseRefillEvent;
};

type QueueExerciseRefillInput = {
  userId: string;
  skillId: string;
  now: Date;
  targetReadyCount?: number;
  sender?: ExerciseRefillEventSender;
  model?: string;
  transaction?: Prisma.TransactionClient;
  deferEvent?: boolean;
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

type RunMathExerciseRefillJobInput = ExerciseRefillEventPayload & {
  now?: Date;
  generateMathExercises?: MathExerciseGenerator;
  verifyMathExercises?: MathExerciseVerifier;
  model?: string;
};

const ACTIVE_GENERATION_JOB_STATUSES = [
  GenerationJobStatus.PENDING,
  GenerationJobStatus.RUNNING,
] as const;

export async function queueChoiceExerciseRefillForSkill(
  input: QueueExerciseRefillInput,
): Promise<RefillQueueResultWithDeferredEvent> {
  const prisma = input.transaction ?? getPrisma();
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
    prisma,
  );

  if (activeJob) {
    return jobInProgress(activeJob.id, "Choice exercise preparation has already started.");
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
    eventKind: "choice",
  });
}

export async function queueExactInputExerciseRefillForSkill(
  input: QueueExerciseRefillInput,
): Promise<RefillQueueResultWithDeferredEvent> {
  const prisma = input.transaction ?? getPrisma();
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
      alreadyStudied: true,
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

  if (!isExactInputUnlocked(skill.repetitions, skill.alreadyStudied)) {
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
    prisma,
  );

  if (activeJob) {
    return jobInProgress(activeJob.id, "Exact-input exercise preparation has already started.");
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
    eventKind: "exact-input",
  });
}

export async function queueMathExerciseRefillForSkill(
  input: QueueExerciseRefillInput,
): Promise<RefillQueueResultWithDeferredEvent> {
  const prisma = input.transaction ?? getPrisma();
  const targetReadyCount = normalizeQueueTarget(
    input.targetReadyCount,
    DEFAULT_READY_MATH_TARGET,
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
      alreadyStudied: true,
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
    return skillNotActive("Only active skills can queue math practice.");
  }

  if (!isExactInputUnlocked(skill.repetitions, skill.alreadyStudied)) {
    return {
      status: "not-queued",
      reason: "exact-input-locked",
      message: "Practice multiple-choice reviews first before queueing math exercises.",
    };
  }

  const activeJob = await findActiveGenerationJob(
    input.userId,
    skill.id,
    GenerationJobKind.MATH_EXERCISE_GENERATION,
    prisma,
  );

  if (activeJob) {
    return jobInProgress(activeJob.id, "Math exercise preparation has already started.");
  }

  const inventory = countMathExerciseInventory(skill.exercises);

  if (inventory.readyExerciseCount >= targetReadyCount) {
    return alreadyAtTarget(
      "This skill already has enough ready math exercises.",
      inventory.readyExerciseCount,
      targetReadyCount,
    );
  }

  return queueExerciseRefillJob({
    input,
    kind: GenerationJobKind.MATH_EXERCISE_GENERATION,
    promptVersion: SKILL_MATH_PROMPT_VERSION,
    requestedCount: targetReadyCount - inventory.readyExerciseCount,
    readyExerciseCount: inventory.readyExerciseCount,
    targetReadyCount,
    sendEvent: (sender, payload) => sender.sendMathRefillRequested(payload),
    eventKind: "math",
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

export async function runMathExerciseRefillJob(
  input: RunMathExerciseRefillJobInput,
): Promise<MathExerciseRefillResult> {
  return refillMathExercisesForSkill({
    userId: input.userId,
    skillId: input.skillId,
    generationJobId: input.generationJobId,
    targetReadyCount: input.targetReadyCount,
    now: input.now ?? new Date(),
    generateMathExercises: input.generateMathExercises,
    verifyMathExercises: input.verifyMathExercises,
    model: input.model,
  });
}

export async function markRefillJobRetryableFailure(input: {
  userId: string;
  skillId: string;
  generationJobId: string;
  now: Date;
  error: unknown;
}): Promise<void> {
  const prisma = getPrisma();
  await prisma.$transaction(async (tx) => {
    const updated = await tx.generationJob.updateMany({
      where: {
        id: input.generationJobId,
        userId: input.userId,
        skillId: input.skillId,
        status: GenerationJobStatus.RUNNING,
      },
      data: {
        status: GenerationJobStatus.FAILED,
        stage: GenerationJobStage.FAILED,
        checkpoint: "retryable-exception",
        failureCategory: GenerationFailureCategory.UNKNOWN,
        errorMessage: `Unexpected refill failure: ${formatEnvError(input.error)}`,
        completedAt: input.now,
      },
    });
    if (updated.count !== 1) return;
    const job = await tx.generationJob.findUniqueOrThrow({
      where: { id: input.generationJobId },
      select: {
        id: true,
        userId: true,
        skillId: true,
        idempotencyKey: true,
        attemptCount: true,
        retryCount: true,
        provider: true,
        model: true,
        promptVersion: true,
        releaseTuple: true,
        contextManifest: true,
        contextManifestHash: true,
        degradedState: true,
        generationReleaseId: true,
        verifierReleaseId: true,
        requestedCount: true,
        acceptedCount: true,
        rejectedCount: true,
      },
    });
    await tx.generationAuditRecord.createMany({
      data: [{
        userId: job.userId,
        jobId: job.id,
        skillId: job.skillId,
        idempotencyKey: job.idempotencyKey ?? job.id,
        eventKey: `retryable-exception-${job.attemptCount}`,
        stage: GenerationJobStage.FAILED,
        checkpoint: "retryable-exception",
        attempt: job.attemptCount,
        retryCount: job.retryCount,
        releaseTuple: (job.releaseTuple ?? {
          provider: job.provider,
          model: job.model,
          generationPromptVersion: job.promptVersion,
        }) as Prisma.InputJsonValue,
        contextManifest: job.contextManifest as Prisma.InputJsonValue | undefined,
        contextManifestHash: job.contextManifestHash,
        stageMetrics: {
          requestedCount: job.requestedCount,
          acceptedCount: job.acceptedCount,
          rejectedCount: job.rejectedCount,
          attemptCount: job.attemptCount,
        },
        failureCategory: GenerationFailureCategory.UNKNOWN,
        degradedState: job.degradedState,
        decision: GenerationAuditDecision.FAILED,
        generationReleaseId: job.generationReleaseId,
        verifierReleaseId: job.verifierReleaseId,
      }],
      skipDuplicates: true,
    });
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
  eventKind,
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
  eventKind: DeferredExerciseRefillEvent["kind"];
}): Promise<RefillQueueResultWithDeferredEvent> {
  const envStatus = input.sender ? null : getJobsEnvStatus();

  if (envStatus?.status === "missing-env") {
    return {
      status: "missing-jobs-env",
      message: envStatus.message,
    };
  }

  const prisma = input.transaction ?? getPrisma();
  const sender = input.sender ?? awsExerciseRefillEventSender;
  const quota = await checkExerciseRefillUsageLimit({
    userId: input.userId,
    now: input.now,
    prisma,
  });

  if (quota.status === "limited") {
    return {
      status: "not-queued",
      reason: "quota-exceeded",
      message: quota.message,
      readyExerciseCount,
      targetReadyCount,
    };
  }

  const createJob = () =>
    createNewGenerationJob({
      prisma,
      userId: input.userId,
      skillId: input.skillId,
      kind,
      promptVersion,
      requestedCount,
      model: input.model,
      now: input.now,
    });
  let generationJob: { id: string };

  try {
    generationJob = await createJob();
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
    if (input.transaction) {
      // A failed write aborts the PostgreSQL transaction. Do not query the
      // transaction client after P2002; the guarded outer mutation can retry
      // the complete claim with fresh authorization instead.
      throw error;
    }

    const activeJob = await findActiveGenerationJob(
      input.userId,
      input.skillId,
      kind,
      prisma,
    );

    if (!activeJob) {
      try {
        generationJob = await createJob();
      } catch (retryError) {
        throw retryError;
      }
    } else {
      return jobInProgress(activeJob.id, "Exercise preparation has already started.");
    }
  }

  const payload: ExerciseRefillEventPayload = {
    userId: input.userId,
    skillId: input.skillId,
    generationJobId: generationJob.id,
    targetReadyCount,
    requestedAt: input.now.toISOString(),
  };

  // A serializable agent mutation may be retried from the beginning. Keep
  // provider delivery outside that callback so one committed job produces at
  // most one event, even when the database retries the transaction.
  if (input.transaction || input.deferEvent) {
    return {
      status: "queued",
      skillId: input.skillId,
      generationJobId: generationJob.id,
      requestedCount,
      readyExerciseCount,
      targetReadyCount,
      message: "Exercise preparation started. Refresh in a moment to see the updated inventory.",
      deferredEvent: { kind: eventKind, payload },
    };
  }

  try {
    await sendEvent(sender, payload);
  } catch {
    return markRefillEventFailure({
      result: {
        status: "queued",
        skillId: input.skillId,
        generationJobId: generationJob.id,
        requestedCount,
        readyExerciseCount,
        targetReadyCount,
        message: "Exercise preparation started. Refresh in a moment to see the updated inventory.",
      },
      now: input.now,
    });
  }

  return {
    status: "queued",
    skillId: input.skillId,
    generationJobId: generationJob.id,
    requestedCount,
    readyExerciseCount,
    targetReadyCount,
    message: "Exercise preparation started. Refresh in a moment to see the updated inventory.",
  };
}

export async function publishDeferredExerciseRefillEvent(input: {
  result: RefillQueueResultWithDeferredEvent;
  now: Date;
  sender?: ExerciseRefillEventSender;
}): Promise<RefillQueueResult> {
  const { result, sender = awsExerciseRefillEventSender } = input;
  if (result.status !== "queued" || !result.deferredEvent) {
    return withoutDeferredEvent(result);
  }

  try {
    switch (result.deferredEvent.kind) {
      case "choice":
        await sender.sendChoiceRefillRequested(result.deferredEvent.payload);
        break;
      case "exact-input":
        await sender.sendExactInputRefillRequested(result.deferredEvent.payload);
        break;
      case "math":
        await sender.sendMathRefillRequested(result.deferredEvent.payload);
        break;
    }
  } catch {
    return markRefillEventFailure({ result, now: input.now });
  }

  return withoutDeferredEvent(result);
}

type QueuedRefillResult = Extract<RefillQueueResultWithDeferredEvent, { status: "queued" }>;

async function markRefillEventFailure(input: {
  result: QueuedRefillResult;
  now: Date;
}): Promise<RefillQueueResult> {
  const message = "Exercise preparation could not be delivered. Retry the repair.";
  const update = await getPrisma().generationJob.updateMany({
    where: {
      id: input.result.generationJobId,
      status: GenerationJobStatus.PENDING,
    },
    data: {
      status: GenerationJobStatus.FAILED,
      stage: GenerationJobStage.FAILED,
      checkpoint: "event-send-failed",
      failureCategory: GenerationFailureCategory.TRANSPORT,
      errorMessage: message,
      completedAt: input.now,
    },
  });
  if (update.count === 1) {
    return {
      status: "not-queued",
      reason: "event-send-failed",
      message,
      generationJobId: input.result.generationJobId,
      readyExerciseCount: input.result.readyExerciseCount,
      targetReadyCount: input.result.targetReadyCount,
    };
  }

  const current = await getPrisma().generationJob.findUnique({
    where: { id: input.result.generationJobId },
    select: { status: true },
  });
  if (!current) {
    return {
      status: "not-queued",
      reason: "event-send-failed",
      message,
      generationJobId: input.result.generationJobId,
      readyExerciseCount: input.result.readyExerciseCount,
      targetReadyCount: input.result.targetReadyCount,
    };
  }

  const publicResult = withoutDeferredEvent(input.result);
  return {
    ...publicResult,
    message:
      current.status === GenerationJobStatus.RUNNING
        ? "Exercise preparation is already running."
        : current.status === GenerationJobStatus.SUCCEEDED
          ? "Exercise preparation completed."
          : current.status === GenerationJobStatus.FAILED
            ? "Exercise preparation failed. Retry the repair."
            : publicResult.message,
  };
}

function withoutDeferredEvent(
  result: RefillQueueResultWithDeferredEvent,
): RefillQueueResult {
  const publicResult = { ...result };
  delete publicResult.deferredEvent;
  return publicResult;
}

async function createNewGenerationJob({
  prisma,
  userId,
  skillId,
  kind,
  promptVersion,
  requestedCount,
  model,
  now,
}: {
  prisma: Pick<Prisma.TransactionClient, "generationJob">;
  userId: string;
  skillId: string;
  kind: GenerationJobKind;
  promptVersion: string;
  requestedCount: number;
  model?: string;
  now: Date;
}): Promise<{ id: string }> {
  return prisma.generationJob.create({
    data: {
      userId,
      skillId,
      kind,
      status: GenerationJobStatus.PENDING,
      stage: GenerationJobStage.QUEUED,
      checkpoint: "event-pending",
      idempotencyKey: `${kind}:${skillId}:${now.toISOString()}`,
      provider: GEMINI_PROVIDER,
      model: model?.trim() || process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL,
      promptVersion,
      requestedCount,
    },
    select: {
      id: true,
    },
  });
}

async function findActiveGenerationJob(
  userId: string,
  skillId: string,
  kind: GenerationJobKind,
  prisma: Pick<Prisma.TransactionClient, "generationJob"> = getPrisma(),
): Promise<{ id: string } | null> {
  return prisma.generationJob.findFirst({
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
