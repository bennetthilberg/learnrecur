import "server-only";

import {
  ExerciseFlagStatus,
  GenerationJobStatus,
  ReminderSendStatus,
  SourceFileStatus,
} from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import { SOURCE_PROCESSING_STALE_AFTER_MS } from "@/lib/skills/uploads";
import { startOfUtcDay } from "@/lib/usage-limits";

export type OpsOverview = {
  generatedAt: Date;
  recentUsers: Array<{
    id: string;
    email: string | null;
    createdAt: Date;
    lastSeenAt: Date | null;
  }>;
  failedGenerationJobs: Array<{
    id: string;
    userId: string;
    skillId: string;
    kind: string;
    model: string;
    errorMessage: string | null;
    updatedAt: Date;
  }>;
  staleSourceFiles: Array<{
    id: string;
    userId: string;
    originalName: string;
    status: SourceFileStatus;
    updatedAt: Date;
  }>;
  failedReminderSends: Array<{
    id: string;
    userId: string;
    localDate: string;
    email: string | null;
    errorMessage: string | null;
    updatedAt: Date;
  }>;
  openExerciseFlags: Array<{
    id: string;
    userId: string;
    exerciseId: string;
    reason: string;
    createdAt: Date;
  }>;
  dailyGenerationUsage: Array<{
    userId: string;
    count: number;
  }>;
  dailySourceUsage: Array<{
    userId: string;
    count: number;
  }>;
};

export async function getOpsOverview(input: { now: Date }): Promise<OpsOverview> {
  const prisma = getPrisma();
  const dayStart = startOfUtcDay(input.now);
  const staleBefore = new Date(input.now.getTime() - SOURCE_PROCESSING_STALE_AFTER_MS);

  const [
    recentUsers,
    failedGenerationJobs,
    staleSourceFiles,
    failedReminderSends,
    openExerciseFlags,
    dailyGenerationUsage,
    dailySourceUsage,
  ] = await Promise.all([
    prisma.user.findMany({
      orderBy: {
        createdAt: "desc",
      },
      take: 10,
      select: {
        id: true,
        email: true,
        createdAt: true,
        lastSeenAt: true,
      },
    }),
    prisma.generationJob.findMany({
      where: {
        status: GenerationJobStatus.FAILED,
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 20,
      select: {
        id: true,
        userId: true,
        skillId: true,
        kind: true,
        model: true,
        errorMessage: true,
        updatedAt: true,
      },
    }),
    prisma.sourceFile.findMany({
      where: {
        status: SourceFileStatus.PROCESSING,
        updatedAt: {
          lt: staleBefore,
        },
      },
      orderBy: {
        updatedAt: "asc",
      },
      take: 20,
      select: {
        id: true,
        userId: true,
        originalName: true,
        status: true,
        updatedAt: true,
      },
    }),
    prisma.reminderSendLog.findMany({
      where: {
        status: ReminderSendStatus.FAILED,
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 20,
      select: {
        id: true,
        userId: true,
        localDate: true,
        email: true,
        errorMessage: true,
        updatedAt: true,
      },
    }),
    prisma.exerciseFlag.findMany({
      where: {
        status: ExerciseFlagStatus.OPEN,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 20,
      select: {
        id: true,
        userId: true,
        exerciseId: true,
        reason: true,
        createdAt: true,
      },
    }),
    prisma.generationJob.groupBy({
      by: ["userId"],
      where: {
        createdAt: {
          gte: dayStart,
        },
      },
      _count: {
        _all: true,
      },
      orderBy: {
        _count: {
          userId: "desc",
        },
      },
      take: 10,
    }),
    prisma.sourceFile.groupBy({
      by: ["userId"],
      where: {
        createdAt: {
          gte: dayStart,
        },
      },
      _count: {
        _all: true,
      },
      orderBy: {
        _count: {
          userId: "desc",
        },
      },
      take: 10,
    }),
  ]);

  return {
    generatedAt: input.now,
    recentUsers,
    failedGenerationJobs: failedGenerationJobs.map((job) => ({
      ...job,
      kind: job.kind,
      errorMessage: truncate(job.errorMessage, 180),
    })),
    staleSourceFiles,
    failedReminderSends: failedReminderSends.map((send) => ({
      ...send,
      errorMessage: truncate(send.errorMessage, 180),
    })),
    openExerciseFlags: openExerciseFlags.map((flag) => ({
      ...flag,
      reason: flag.reason,
    })),
    dailyGenerationUsage: dailyGenerationUsage.map((usage) => ({
      userId: usage.userId,
      count: usage._count._all,
    })),
    dailySourceUsage: dailySourceUsage.map((usage) => ({
      userId: usage.userId,
      count: usage._count._all,
    })),
  };
}

function truncate(value: string | null, maxLength: number): string | null {
  if (!value || value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}
