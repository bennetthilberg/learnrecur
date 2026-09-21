import "server-only";

import { randomUUID } from "node:crypto";

import {
  AgentOperationItemStatus,
  AgentOperationKind,
  GenerationFailureCategory,
  GenerationJobKind,
  GenerationJobStage,
  GenerationJobStatus,
  Prisma,
  SkillStatus,
} from "@/generated/prisma/client";
import { sendAgentSkillOperationRequested } from "@/lib/jobs/events";
import { getPrisma } from "@/lib/prisma";
import {
  AGENT_OPERATION_STALE_AFTER_MS,
  isAgentOperationClaimStale,
} from "./recovery-policy";
import { reconcileAgentOperation } from "./reconciliation";

const RECOVERY_BATCH_LIMIT = 25;
const RECOVERABLE_OPERATION_KINDS = [
  AgentOperationKind.SPEC_BATCH,
  AgentOperationKind.TEXT_SOURCE,
  AgentOperationKind.QUICK_FILES,
] as const;
const IN_FLIGHT_ITEM_STATUSES = [
  AgentOperationItemStatus.GENERATING,
  AgentOperationItemStatus.VERIFYING,
  AgentOperationItemStatus.ACTIVATING,
] as const;
// Older workers incorrectly persisted this wait condition as FAILED. Keep a
// narrow compatibility branch for those rows; all newly produced wait states
// remain ACTIVATING and are handled by the in-flight branch above.
const LEGACY_ACTIVATION_WAIT_ERROR = "ACTIVATION_IN_PROGRESS";
const STALE_RECOVERY_ERROR = "TRANSIENT_WORKER_FAILURE";
const STALE_RECOVERY_MESSAGE =
  "The activation worker stopped before completion. The item was returned to the queue.";
const STALE_GENERATION_MESSAGE =
  "The activation worker lease expired before completion. The generation attempt can be retried.";

type RecoveryCandidate = {
  id: string;
  userId: string;
  operationId: string;
  status: AgentOperationItemStatus;
  workerClaimToken: string | null;
  workerClaimedAt: Date | null;
  updatedAt: Date;
  createdSkillId: string | null;
  resultSkillId: string | null;
};

type RecoveryResult = "requeued" | "finalized" | "waiting" | "promoted" | "unchanged";

export async function recoverStaleAgentOperationItems(input: {
  now: Date;
  userId?: string;
  operationId?: string;
  limit?: number;
}) {
  const prisma = getPrisma();
  const staleBefore = new Date(input.now.getTime() - AGENT_OPERATION_STALE_AFTER_MS);
  const candidates = await prisma.agentSkillOperationItem.findMany({
    where: {
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.operationId ? { operationId: input.operationId } : {}),
      operation: { kind: { in: [...RECOVERABLE_OPERATION_KINDS] } },
      OR: [
        {
          status: { in: [...IN_FLIGHT_ITEM_STATUSES] },
          OR: [
            { workerClaimedAt: { lte: staleBefore } },
            { workerClaimedAt: null, updatedAt: { lte: staleBefore } },
          ],
        },
        {
          status: AgentOperationItemStatus.FAILED,
          errorCode: LEGACY_ACTIVATION_WAIT_ERROR,
          updatedAt: { lte: staleBefore },
        },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: Math.min(input.limit ?? RECOVERY_BATCH_LIMIT, RECOVERY_BATCH_LIMIT),
    select: {
      id: true,
      userId: true,
      operationId: true,
      status: true,
      workerClaimToken: true,
      workerClaimedAt: true,
      updatedAt: true,
      createdSkillId: true,
      resultSkillId: true,
    },
  });

  const changedOperations = new Set<string>();
  const counts = {
    scanned: candidates.length,
    requeued: 0,
    finalized: 0,
    waiting: 0,
    unchanged: 0,
    legacyPromoted: 0,
    continuations: 0,
  };

  for (const candidate of candidates) {
    const result = await recoverCandidate({ candidate, now: input.now });
    if (result === "requeued") counts.requeued += 1;
    if (result === "finalized") counts.finalized += 1;
    if (result === "waiting") counts.waiting += 1;
    if (result === "promoted") {
      counts.waiting += 1;
      counts.legacyPromoted += 1;
    }
    if (result === "unchanged") counts.unchanged += 1;
    if (result !== "unchanged" && result !== "waiting") {
      changedOperations.add(candidate.operationId);
    }
  }

  for (const operationId of changedOperations) {
    const candidate = candidates.find((item) => item.operationId === operationId);
    if (!candidate) continue;
    await reconcileAgentOperation({
      operationId,
      userId: candidate.userId,
      now: input.now,
    });
    const queued = await prisma.agentSkillOperationItem.count({
      where: {
        operationId,
        userId: candidate.userId,
        status: AgentOperationItemStatus.QUEUED,
      },
    });
    if (queued > 0) {
      await sendAgentSkillOperationRequested({
        userId: candidate.userId,
        operationId,
        requestedAt: input.now.toISOString(),
      });
      counts.continuations += 1;
    }
  }

  return counts;
}

async function recoverCandidate(input: {
  candidate: RecoveryCandidate;
  now: Date;
}): Promise<RecoveryResult> {
  const prisma = getPrisma();
  const recoveryToken = randomUUID();
  const isLegacyCandidate = input.candidate.status === AgentOperationItemStatus.FAILED;
  const claimWhere: Prisma.AgentSkillOperationItemWhereInput = {
    id: input.candidate.id,
    userId: input.candidate.userId,
    ...(isLegacyCandidate
      ? { status: AgentOperationItemStatus.FAILED, errorCode: LEGACY_ACTIVATION_WAIT_ERROR }
      : { status: { in: [...IN_FLIGHT_ITEM_STATUSES] } }),
    ...(input.candidate.workerClaimToken
      ? { workerClaimToken: input.candidate.workerClaimToken }
      : { workerClaimToken: null }),
    ...(input.candidate.workerClaimedAt
      ? { workerClaimedAt: input.candidate.workerClaimedAt }
      : { workerClaimedAt: null, updatedAt: input.candidate.updatedAt }),
  };
  const claimed = await prisma.agentSkillOperationItem.updateMany({
    where: claimWhere,
    data: { workerClaimToken: recoveryToken, workerClaimedAt: input.now },
  });
  if (claimed.count !== 1) return "unchanged";

  const current = await prisma.agentSkillOperationItem.findFirst({
    where: { id: input.candidate.id, userId: input.candidate.userId },
    select: {
      id: true,
      createdSkillId: true,
      resultSkillId: true,
      status: true,
      errorCode: true,
      operationId: true,
    },
  });
  const isLegacyWaiting =
    current?.status === AgentOperationItemStatus.FAILED &&
    current.errorCode === LEGACY_ACTIVATION_WAIT_ERROR;
  if (
    !current ||
    (!IN_FLIGHT_ITEM_STATUSES.includes(current.status as (typeof IN_FLIGHT_ITEM_STATUSES)[number]) &&
      !isLegacyWaiting)
  ) {
    return "unchanged";
  }

  const skillIds = [current.createdSkillId, current.resultSkillId].filter(
    (value): value is string => Boolean(value),
  );
  const publishedSkill = skillIds.length
    ? await prisma.skill.findFirst({
        where: {
          id: { in: skillIds },
          userId: input.candidate.userId,
          status: { in: [SkillStatus.ACTIVE, SkillStatus.PAUSED] },
        },
        select: { id: true },
      })
    : null;
  if (publishedSkill) {
    return finalizePublishedItem({
      itemId: input.candidate.id,
      userId: input.candidate.userId,
      recoveryToken,
      skillId: publishedSkill.id,
      now: input.now,
    });
  }

  const generationJob = current.createdSkillId
    ? await prisma.generationJob.findFirst({
        where: {
          userId: input.candidate.userId,
          skillId: current.createdSkillId,
          kind: GenerationJobKind.SKILL_ACTIVATION,
          status: {
            in: [
              GenerationJobStatus.PENDING,
              GenerationJobStatus.RUNNING,
              GenerationJobStatus.SUCCEEDED,
              GenerationJobStatus.FAILED,
            ],
          },
        },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
        select: { id: true, status: true, updatedAt: true },
      })
    : null;

  if (
    generationJob &&
    (generationJob.status === GenerationJobStatus.PENDING ||
      generationJob.status === GenerationJobStatus.RUNNING) &&
    !isAgentOperationClaimStale(generationJob.updatedAt, input.now)
  ) {
    if (isLegacyWaiting) {
      return promoteLegacyActivationWait({
        itemId: input.candidate.id,
        userId: input.candidate.userId,
        recoveryToken,
        now: input.now,
      });
    }
    await releaseRecoveryClaim({
      candidate: input.candidate,
      recoveryToken,
      now: input.now,
    });
    return "waiting";
  }

  if (
    generationJob &&
    (generationJob.status === GenerationJobStatus.PENDING ||
      generationJob.status === GenerationJobStatus.RUNNING)
  ) {
    const failed = await prisma.generationJob.updateMany({
      where: {
        id: generationJob.id,
        userId: input.candidate.userId,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        status: generationJob.status,
        updatedAt: generationJob.updatedAt,
      },
      data: {
        status: GenerationJobStatus.FAILED,
        stage: GenerationJobStage.FAILED,
        failureCategory: GenerationFailureCategory.TIMEOUT,
        errorMessage: STALE_GENERATION_MESSAGE,
        completedAt: input.now,
      },
    });
    if (failed.count === 0) {
      const currentJob = await prisma.generationJob.findUnique({
        where: { id: generationJob.id },
        select: { status: true, updatedAt: true },
      });
      if (
        currentJob?.status === GenerationJobStatus.PENDING ||
        currentJob?.status === GenerationJobStatus.RUNNING
      ) {
        if (!isAgentOperationClaimStale(currentJob.updatedAt, input.now)) {
          if (isLegacyWaiting) {
            return promoteLegacyActivationWait({
              itemId: input.candidate.id,
              userId: input.candidate.userId,
              recoveryToken,
              now: input.now,
            });
          }
          await releaseRecoveryClaim({
            candidate: input.candidate,
            recoveryToken,
            now: input.now,
          });
          return "waiting";
        }
      }
    }
  }

  const publishedAfterJobRace = current.createdSkillId
    ? await prisma.skill.findFirst({
        where: {
          id: current.createdSkillId,
          userId: input.candidate.userId,
          status: { in: [SkillStatus.ACTIVE, SkillStatus.PAUSED] },
        },
        select: { id: true },
      })
    : null;
  if (publishedAfterJobRace) {
    return finalizePublishedItem({
      itemId: input.candidate.id,
      userId: input.candidate.userId,
      recoveryToken,
      skillId: publishedAfterJobRace.id,
      now: input.now,
    });
  }

  const requeued = await prisma.agentSkillOperationItem.updateMany({
    where: {
      id: input.candidate.id,
      userId: input.candidate.userId,
      workerClaimToken: recoveryToken,
      OR: [
        { status: { in: [...IN_FLIGHT_ITEM_STATUSES] } },
        { status: AgentOperationItemStatus.FAILED, errorCode: LEGACY_ACTIVATION_WAIT_ERROR },
      ],
    },
    data: {
      status: AgentOperationItemStatus.QUEUED,
      activationReservedAt: null,
      errorCode: STALE_RECOVERY_ERROR,
      errorMessage: STALE_RECOVERY_MESSAGE,
      retryCount: { increment: 1 },
      completedAt: null,
      workerClaimToken: null,
      workerClaimedAt: null,
    },
  });
  return requeued.count === 1 ? "requeued" : "unchanged";
}

async function promoteLegacyActivationWait(input: {
  itemId: string;
  userId: string;
  recoveryToken: string;
  now: Date;
}): Promise<RecoveryResult> {
  const promoted = await getPrisma().agentSkillOperationItem.updateMany({
    where: {
      id: input.itemId,
      userId: input.userId,
      workerClaimToken: input.recoveryToken,
      status: AgentOperationItemStatus.FAILED,
      errorCode: LEGACY_ACTIVATION_WAIT_ERROR,
    },
    data: {
      status: AgentOperationItemStatus.ACTIVATING,
      errorCode: "ACTIVATION_WAITING",
      errorMessage: "Another activation worker is still completing this draft.",
      completedAt: null,
      workerClaimToken: null,
      workerClaimedAt: null,
    },
  });
  return promoted.count === 1 ? "promoted" : "unchanged";
}

async function finalizePublishedItem(input: {
  itemId: string;
  userId: string;
  recoveryToken: string;
  skillId: string;
  now: Date;
}): Promise<RecoveryResult> {
  const finalized = await getPrisma().agentSkillOperationItem.updateMany({
    where: {
      id: input.itemId,
      userId: input.userId,
      workerClaimToken: input.recoveryToken,
      OR: [
        { status: { in: [...IN_FLIGHT_ITEM_STATUSES] } },
        { status: AgentOperationItemStatus.FAILED, errorCode: LEGACY_ACTIVATION_WAIT_ERROR },
      ],
    },
    data: {
      status: AgentOperationItemStatus.ACTIVE,
      resultSkillId: input.skillId,
      activationReservedAt: null,
      errorCode: null,
      errorMessage: null,
      completedAt: input.now,
      workerClaimToken: null,
      workerClaimedAt: null,
    },
  });
  return finalized.count === 1 ? "finalized" : "unchanged";
}

async function releaseRecoveryClaim(input: {
  candidate: RecoveryCandidate;
  recoveryToken: string;
  now: Date;
}) {
  await getPrisma().agentSkillOperationItem.updateMany({
    where: {
      id: input.candidate.id,
      userId: input.candidate.userId,
      workerClaimToken: input.recoveryToken,
      status: { in: [...IN_FLIGHT_ITEM_STATUSES] },
    },
    data: {
      workerClaimToken: input.candidate.workerClaimToken,
      workerClaimedAt: input.now,
    },
  });
}
