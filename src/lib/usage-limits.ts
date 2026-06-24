import "server-only";

import {
  GenerationJobKind,
  SkillStatus,
  SourceFileKind,
  SourceFileStatus,
  type PrismaClient,
} from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";

export const ALPHA_SOURCE_UPLOADS_PER_DAY = 10;
export const ALPHA_SOURCE_DRAFT_GENERATIONS_PER_DAY = 10;
export const ALPHA_SKILL_ACTIVATIONS_PER_DAY = 10;
export const ALPHA_EXERCISE_REFILL_JOBS_PER_DAY = 50;
export const ALPHA_ACTIVE_SKILLS = 100;
export const ALPHA_STORED_SOURCE_BYTES = 250 * 1024 * 1024;

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
    };

type UsageLimitClient = Pick<PrismaClient, "generationJob" | "skill" | "sourceFile">;

export async function checkSourceUploadUsageLimit(input: {
  userId: string;
  byteSize: number;
  now: Date;
  prisma?: UsageLimitClient;
}): Promise<UsageLimitResult> {
  const prisma = input.prisma ?? getPrisma();
  const dayStart = startOfUtcDay(input.now);
  const [uploadsToday, storage] = await Promise.all([
    prisma.sourceFile.count({
      where: {
        userId: input.userId,
        createdAt: {
          gte: dayStart,
        },
        storageKey: {
          not: null,
        },
      },
    }),
    prisma.sourceFile.aggregate({
      where: {
        userId: input.userId,
        storageKey: {
          not: null,
        },
        status: {
          not: SourceFileStatus.FAILED,
        },
      },
      _sum: {
        byteSize: true,
      },
    }),
  ]);

  if (uploadsToday >= ALPHA_SOURCE_UPLOADS_PER_DAY) {
    return limited(
      "daily-source-upload-limit",
      `Alpha accounts can prepare ${ALPHA_SOURCE_UPLOADS_PER_DAY} uploads per UTC day.`,
    );
  }

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
  const prisma = input.prisma ?? getPrisma();
  const dayStart = startOfUtcDay(input.now);
  const [activeSkillCount, activationsToday] = await Promise.all([
    prisma.skill.count({
      where: {
        userId: input.userId,
        status: {
          in: [SkillStatus.ACTIVE, SkillStatus.PAUSED],
        },
      },
    }),
    prisma.generationJob.count({
      where: {
        userId: input.userId,
        kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
        createdAt: {
          gte: dayStart,
        },
      },
    }),
  ]);

  if (activeSkillCount >= ALPHA_ACTIVE_SKILLS) {
    return limited(
      "active-skill-limit",
      `Alpha accounts can keep ${ALPHA_ACTIVE_SKILLS} active or paused skills.`,
    );
  }

  if (activationsToday >= ALPHA_SKILL_ACTIVATIONS_PER_DAY) {
    return limited(
      "daily-activation-limit",
      `Alpha accounts can activate ${ALPHA_SKILL_ACTIVATIONS_PER_DAY} skills per UTC day.`,
    );
  }

  return ok();
}

export async function checkExerciseRefillUsageLimit(input: {
  userId: string;
  now: Date;
  prisma?: UsageLimitClient;
}): Promise<UsageLimitResult> {
  const prisma = input.prisma ?? getPrisma();
  const refillJobsToday = await prisma.generationJob.count({
    where: {
      userId: input.userId,
      createdAt: {
        gte: startOfUtcDay(input.now),
      },
      kind: {
        in: [
          GenerationJobKind.CHOICE_EXERCISE_GENERATION,
          GenerationJobKind.EXACT_INPUT_EXERCISE_GENERATION,
          GenerationJobKind.MATH_EXERCISE_GENERATION,
        ],
      },
    },
  });

  if (refillJobsToday >= ALPHA_EXERCISE_REFILL_JOBS_PER_DAY) {
    return limited(
      "daily-exercise-refill-limit",
      `Alpha accounts can start ${ALPHA_EXERCISE_REFILL_JOBS_PER_DAY} exercise generation jobs per UTC day.`,
    );
  }

  return ok();
}

export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function ok(): UsageLimitResult {
  return {
    status: "ok",
  };
}

function limited(code: Extract<UsageLimitResult, { status: "limited" }>["code"], message: string) {
  return {
    status: "limited" as const,
    code,
    message,
  };
}

function formatBytes(bytes: number): string {
  const megabytes = bytes / (1024 * 1024);
  return `${Math.round(megabytes)} MB`;
}
