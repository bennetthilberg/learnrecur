import "server-only";

import {
  AgentOperationItemStatus,
  AgentOperationStatus,
  GenerationJobKind,
  GenerationJobStatus,
  SkillDraftBatchItemStatus,
  SkillStatus,
  SourceFileKind,
  type PrismaClient,
} from "@/generated/prisma/client";
import {
  DEFAULT_ACTIVE_SKILL_LIMIT,
  DEFAULT_SKILL_ACTIVATIONS_PER_UTC_DAY,
  ImportLimitConfigurationError,
  type ImportLimitConfig,
  MAX_PENDING_IMPORT_ITEMS,
  REFILL_DEFERRED_CHECKPOINT,
  resolveImportLimitConfig,
} from "@/lib/import-limits";
import { getPrisma } from "@/lib/prisma";

export const ALPHA_SOURCE_UPLOADS_PER_DAY = 10;
export const ALPHA_SOURCE_DRAFT_GENERATIONS_PER_DAY = 10;
export const ALPHA_SKILL_ACTIVATIONS_PER_DAY = DEFAULT_SKILL_ACTIVATIONS_PER_UTC_DAY;
export const ALPHA_EXERCISE_REFILL_JOBS_PER_DAY = 50;
export const ALPHA_ACTIVE_SKILLS = DEFAULT_ACTIVE_SKILL_LIMIT;
export const ALPHA_STORED_SOURCE_BYTES = 250 * 1024 * 1024;

const UTC_DAY_MS = 24 * 60 * 60 * 1_000;
const ACTIVATION_RESERVATION_STATUSES = [
  AgentOperationItemStatus.QUEUED,
  AgentOperationItemStatus.GENERATING,
  AgentOperationItemStatus.VERIFYING,
  AgentOperationItemStatus.ACTIVATING,
];
const ACTIVE_GENERATION_JOB_STATUSES = [
  GenerationJobStatus.PENDING,
  GenerationJobStatus.RUNNING,
];
const NONTERMINAL_OPERATION_STATUSES = [
  AgentOperationStatus.AWAITING_UPLOAD,
  AgentOperationStatus.QUEUED,
  AgentOperationStatus.PLANNING,
  AgentOperationStatus.NEEDS_INPUT,
  AgentOperationStatus.NEEDS_REVIEW,
  AgentOperationStatus.GENERATING,
  AgentOperationStatus.VERIFYING,
  AgentOperationStatus.ACTIVATING,
];
const REFILL_GENERATION_JOB_KINDS = [
  GenerationJobKind.CHOICE_EXERCISE_GENERATION,
  GenerationJobKind.EXACT_INPUT_EXERCISE_GENERATION,
  GenerationJobKind.MATH_EXERCISE_GENERATION,
];

export type UsageLimitConfig = ImportLimitConfig;
export const UsageLimitConfigurationError = ImportLimitConfigurationError;

export function resolveUsageLimitConfig(
  env: Record<string, string | undefined> = process.env,
): UsageLimitConfig {
  return resolveImportLimitConfig(env);
}

export type UsageLimitResult =
  | {
      status: "ok";
    }
  | {
      status: "limited";
      code:
        | "active-skill-limit"
        | "daily-activation-limit"
        | "daily-exercise-refill-limit"
        | "daily-source-draft-limit"
        | "daily-source-upload-limit"
        | "source-storage-limit";
      message: string;
      limit?: number;
      remaining?: number;
      resetAt?: string;
    };

type UsageLimitClient = Pick<PrismaClient, "generationJob" | "skill" | "sourceFile"> &
  Partial<Pick<PrismaClient, "agentSkillOperation" | "agentSkillOperationItem" | "skillDraftBatchItem">>;

export type SkillActivationUsage = {
  activeSkillCount: number;
  reservedSkillCount: number;
  countedSkillCount: number;
  activationJobsToday: number;
  unclaimedReservationsToday: number;
  activationsUsedToday: number;
  activeSkillLimit: number;
  dailyActivationLimit: number;
  nextUtcResetAt: Date;
};

export type PendingImportUsage = {
  pendingItemCount: number;
  pendingItemLimit: number;
  remaining: number;
};

export type ExerciseRefillUsage = {
  jobsToday: number;
  jobLimit: number;
  remaining: number;
  nextUtcResetAt: Date;
};

export async function checkSourceUploadUsageLimit(input: {
  userId: string;
  byteSize: number;
  now: Date;
  prisma?: UsageLimitClient;
}): Promise<UsageLimitResult> {
  const prisma = input.prisma ?? getPrisma();
  const dayStart = startOfUtcDay(input.now);
  const [uploadsToday, storageLimit] = await Promise.all([
    prisma.sourceFile.count({
      where: {
        userId: input.userId,
        materialRevisionId: null,
        createdAt: {
          gte: dayStart,
        },
        kind: {
          in: [SourceFileKind.IMAGE, SourceFileKind.PDF],
        },
      },
    }),
    checkSourceStorageUsageLimit({ ...input, quickUploadsOnly: true }),
  ]);

  if (uploadsToday >= ALPHA_SOURCE_UPLOADS_PER_DAY) {
    return limited(
      "daily-source-upload-limit",
      `Alpha accounts can prepare ${ALPHA_SOURCE_UPLOADS_PER_DAY} uploads per UTC day.`,
    );
  }

  if (storageLimit.status === "limited") {
    return storageLimit;
  }

  return ok();
}

export async function checkSourceStorageUsageLimit(input: {
  userId: string;
  byteSize: number;
  quickUploadsOnly?: boolean;
  replaceSourceFileId?: string;
  prisma?: UsageLimitClient;
}): Promise<UsageLimitResult> {
  const prisma = input.prisma ?? getPrisma();
  const storage = await prisma.sourceFile.aggregate({
    where: {
      userId: input.userId,
      ...(input.quickUploadsOnly ? { materialRevisionId: null } : {}),
      storageKey: { not: null },
      ...(input.replaceSourceFileId ? { id: { not: input.replaceSourceFileId } } : {}),
    },
    _sum: { byteSize: true },
  });
  const storedBytes = storage._sum.byteSize ?? 0;

  if (storedBytes + input.byteSize > ALPHA_STORED_SOURCE_BYTES) {
    return limited(
      "source-storage-limit",
      `Alpha accounts can store up to ${formatBytes(ALPHA_STORED_SOURCE_BYTES)} of source uploads.`,
    );
  }

  return ok();
}

export async function checkPastedSourceDraftUsageLimit(input: {
  userId: string;
  now: Date;
  prisma?: UsageLimitClient;
}): Promise<UsageLimitResult> {
  const prisma = input.prisma ?? getPrisma();
  const draftsToday = await prisma.sourceFile.count({
    where: {
      userId: input.userId,
      kind: SourceFileKind.TEXT,
      createdAt: {
        gte: startOfUtcDay(input.now),
      },
    },
  });

  if (draftsToday >= ALPHA_SOURCE_DRAFT_GENERATIONS_PER_DAY) {
    return limited(
      "daily-source-draft-limit",
      `Alpha accounts can generate ${ALPHA_SOURCE_DRAFT_GENERATIONS_PER_DAY} pasted-source drafts per UTC day.`,
    );
  }

  return ok();
}

export async function checkSkillActivationUsageLimit(input: {
  userId: string;
  now: Date;
  prisma?: UsageLimitClient;
}): Promise<UsageLimitResult> {
  const usage = await getSkillActivationUsage(input);

  if (usage.countedSkillCount >= usage.activeSkillLimit) {
    return limited(
      "active-skill-limit",
      `The library limit is ${usage.activeSkillLimit} active or paused skills, including imports already reserved. Archive a skill before adding another.`,
      usage.activeSkillLimit,
      0,
    );
  }

  if (usage.activationsUsedToday >= usage.dailyActivationLimit) {
    return limited(
      "daily-activation-limit",
      `The activation limit of ${usage.dailyActivationLimit} attempts per UTC day has been reached. Try again after ${usage.nextUtcResetAt.toISOString()} UTC.`,
      usage.dailyActivationLimit,
      0,
      usage.nextUtcResetAt,
    );
  }

  return ok();
}

/**
 * Read the shared activation ledger. Callers that are reserving capacity must
 * invoke this while holding the user's row lock, then create their reservation
 * in the same transaction.
 */
export async function getSkillActivationUsage(input: {
  userId: string;
  now: Date;
  prisma?: UsageLimitClient;
}): Promise<SkillActivationUsage> {
  const prisma = input.prisma ?? getPrisma();
  const config = resolveUsageLimitConfig();
  const dayStart = startOfUtcDay(input.now);
  const dayEnd = new Date(dayStart.getTime() + UTC_DAY_MS);

  const [
    activeSkillCount,
    activationJobsToday,
    agentReservedSkillCount,
    nativeReservedSkillCount,
    standaloneReservedSkillCount,
    unclaimedReservationsToday,
  ] = await Promise.all([
    prisma.skill.count({
      where: {
        userId: input.userId,
        status: { in: [SkillStatus.ACTIVE, SkillStatus.PAUSED] },
      },
    }),
    prisma.generationJob.count({
      where: {
        userId: input.userId,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        createdAt: { gte: dayStart, lt: dayEnd },
      },
    }),
    countAgentActivationReservations(prisma, input.userId),
    countNativeActivationReservations(prisma, input.userId),
    prisma.generationJob.count({
      where: {
        userId: input.userId,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        status: { in: ACTIVE_GENERATION_JOB_STATUSES },
        skill: {
          userId: input.userId,
          status: SkillStatus.DRAFT,
          draftBatchItems: {
            none: {
              userId: input.userId,
              status: SkillDraftBatchItemStatus.ACTIVATING,
            },
          },
          agentCreatedItems: {
            none: {
              userId: input.userId,
              activationReservedAt: { not: null },
              status: { in: ACTIVATION_RESERVATION_STATUSES },
            },
          },
        },
      },
    }),
    countUnclaimedAgentActivationReservations(
      prisma,
      input.userId,
      dayStart,
      dayEnd,
    ),
  ]);

  const reservedSkillCount =
    agentReservedSkillCount + nativeReservedSkillCount + standaloneReservedSkillCount;
  return {
    activeSkillCount,
    reservedSkillCount,
    countedSkillCount: activeSkillCount + reservedSkillCount,
    activationJobsToday,
    unclaimedReservationsToday,
    activationsUsedToday: activationJobsToday + unclaimedReservationsToday,
    activeSkillLimit: config.activeSkillLimit,
    dailyActivationLimit: config.skillActivationsPerUtcDay,
    nextUtcResetAt: dayEnd,
  };
}

export async function getPendingImportUsage(input: {
  userId: string;
  prisma?: UsageLimitClient;
}): Promise<PendingImportUsage> {
  const prisma = input.prisma ?? getPrisma();
  const [nonterminalItems, unmaterializedOperations] = await Promise.all([
    prisma.agentSkillOperationItem?.count({
      where: {
        userId: input.userId,
        status: {
          in: [
            AgentOperationItemStatus.QUEUED,
            AgentOperationItemStatus.PLANNING,
            AgentOperationItemStatus.NEEDS_INPUT,
            AgentOperationItemStatus.NEEDS_REVIEW,
            AgentOperationItemStatus.GENERATING,
            AgentOperationItemStatus.VERIFYING,
            AgentOperationItemStatus.ACTIVATING,
          ],
        },
      },
    }) ?? Promise.resolve(0),
    prisma.agentSkillOperation?.findMany({
      where: {
        userId: input.userId,
        status: { in: NONTERMINAL_OPERATION_STATUSES },
        items: { none: {} },
      },
      select: { requestedCount: true },
    }) ?? Promise.resolve([]),
  ]);
  const unmaterializedCount = unmaterializedOperations.reduce(
    (total, operation) => total + operation.requestedCount,
    0,
  );
  const pendingItemCount = nonterminalItems + unmaterializedCount;
  return {
    pendingItemCount,
    pendingItemLimit: MAX_PENDING_IMPORT_ITEMS,
    remaining: Math.max(0, MAX_PENDING_IMPORT_ITEMS - pendingItemCount),
  };
}

export async function getExerciseRefillUsage(input: {
  userId: string;
  now: Date;
  prisma?: UsageLimitClient;
}): Promise<ExerciseRefillUsage> {
  const prisma = input.prisma ?? getPrisma();
  const dayStart = startOfUtcDay(input.now);
  const dayEnd = new Date(dayStart.getTime() + UTC_DAY_MS);
  const jobsToday = await prisma.generationJob.count({
    where: {
      userId: input.userId,
      createdAt: { gte: dayStart, lt: dayEnd },
      OR: [
        { checkpoint: { not: REFILL_DEFERRED_CHECKPOINT } },
        { checkpoint: null },
      ],
      kind: { in: REFILL_GENERATION_JOB_KINDS },
    },
  });
  return {
    jobsToday,
    jobLimit: ALPHA_EXERCISE_REFILL_JOBS_PER_DAY,
    remaining: Math.max(0, ALPHA_EXERCISE_REFILL_JOBS_PER_DAY - jobsToday),
    nextUtcResetAt: dayEnd,
  };
}

export async function checkExerciseRefillUsageLimit(input: {
  userId: string;
  now: Date;
  prisma?: UsageLimitClient;
}): Promise<UsageLimitResult> {
  const usage = await getExerciseRefillUsage(input);

  if (usage.jobsToday >= usage.jobLimit) {
    return limited(
      "daily-exercise-refill-limit",
      `The exercise preparation limit of ${usage.jobLimit} jobs per UTC day has been reached. Try again after ${usage.nextUtcResetAt.toISOString()} UTC.`,
      usage.jobLimit,
      0,
      usage.nextUtcResetAt,
    );
  }

  return ok();
}

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function countAgentActivationReservations(
  prisma: UsageLimitClient,
  userId: string,
) {
  if (!prisma.agentSkillOperationItem) return Promise.resolve(0);
  return prisma.agentSkillOperationItem.count({
    where: {
      userId,
      activationReservedAt: { not: null },
      status: { in: ACTIVATION_RESERVATION_STATUSES },
      OR: [
        { createdSkillId: null },
        { createdSkill: { status: SkillStatus.DRAFT } },
      ],
    },
  });
}

function countNativeActivationReservations(
  prisma: UsageLimitClient,
  userId: string,
) {
  if (!prisma.skillDraftBatchItem) return Promise.resolve(0);
  return prisma.skillDraftBatchItem.count({
    where: {
      userId,
      status: SkillDraftBatchItemStatus.ACTIVATING,
      skill: { status: SkillStatus.DRAFT },
    },
  });
}

function countUnclaimedAgentActivationReservations(
  prisma: UsageLimitClient,
  userId: string,
  dayStart: Date,
  dayEnd: Date,
) {
  if (!prisma.agentSkillOperationItem) return Promise.resolve(0);
  return prisma.agentSkillOperationItem.count({
    where: {
      userId,
      activationReservedAt: { gte: dayStart, lt: dayEnd },
      status: { in: ACTIVATION_RESERVATION_STATUSES },
      OR: [
        { createdSkillId: null },
        {
          createdSkill: {
            status: SkillStatus.DRAFT,
            generationJobs: {
              none: {
                userId,
                kind: GenerationJobKind.SKILL_ACTIVATION,
                createdAt: { gte: dayStart, lt: dayEnd },
              },
            },
          },
        },
      ],
    },
  });
}

function ok(): UsageLimitResult {
  return {
    status: "ok",
  };
}

function limited(
  code: Extract<UsageLimitResult, { status: "limited" }>["code"],
  message: string,
  limit?: number,
  remaining?: number,
  resetAt?: Date,
) {
  return {
    status: "limited" as const,
    code,
    message,
    ...(limit === undefined ? {} : { limit }),
    ...(remaining === undefined ? {} : { remaining }),
    ...(resetAt === undefined ? {} : { resetAt: resetAt.toISOString() }),
  };
}

function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${Math.round(megabytes)} MB`;
}
