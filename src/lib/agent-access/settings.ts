import "server-only";

import {
  AgentConnectionStatus,
  AgentOperationItemStatus,
  AgentOperationStatus,
  AgentRemoteRevocationStatus,
  AgentRevocationOutboxStatus,
  Prisma,
  SkillStatus,
} from "@/generated/prisma/client";
import { getAgentAccessConfig } from "@/lib/agent-access/auth";
import { sendAgentConnectionRevocationRequested, sendAgentSkillOperationRequested } from "@/lib/inngest/events";
import { getPrisma } from "@/lib/prisma";

export async function getAgentAccessOverview(userId: string) {
  const config = getAgentAccessConfig();
  if (!config.enabled) return { status: "disabled" as const };
  const prisma = getPrisma();
  const [connections, operations, preparing, needsReview] = await Promise.all([
    prisma.agentConnection.findMany({
      where: { userId },
      orderBy: [{ status: "asc" }, { connectedAt: "desc" }],
      select: {
        id: true,
        clientName: true,
        clientDomain: true,
        scopes: true,
        status: true,
        connectedAt: true,
        lastUsedAt: true,
        revokedAt: true,
        remoteRevocationStatus: true,
        _count: {
          select: {
            operations: {
              where: { status: AgentOperationStatus.SUCCEEDED },
            },
          },
        },
      },
    }),
    prisma.agentSkillOperation.findMany({
      where: { userId },
      orderBy: { updatedAt: "desc" },
      take: 8,
      select: {
        id: true,
        status: true,
        requestedCount: true,
        activeCount: true,
        reusedCount: true,
        failedCount: true,
        updatedAt: true,
        connection: { select: { clientName: true } },
      },
    }),
    prisma.agentSkillOperationItem.findMany({
      where: {
        userId,
        status: {
          in: [
            AgentOperationItemStatus.QUEUED,
            AgentOperationItemStatus.PLANNING,
            AgentOperationItemStatus.GENERATING,
            AgentOperationItemStatus.VERIFYING,
            AgentOperationItemStatus.ACTIVATING,
          ],
        },
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        status: true,
        proposedTitle: true,
        updatedAt: true,
        operation: { select: { connection: { select: { clientName: true } } } },
      },
    }),
    prisma.agentSkillOperationItem.findMany({
      where: { userId, status: AgentOperationItemStatus.NEEDS_REVIEW },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        proposedTitle: true,
        proposedObjective: true,
        duplicateConfidence: true,
        createdSkillId: true,
        resultSkillId: true,
        updatedAt: true,
        operation: { select: { connection: { select: { clientName: true } } } },
      },
    }),
  ]);
  return {
    status: "ready" as const,
    resourceUrl: config.resourceUrl,
    connections,
    operations,
    preparing,
    needsReview,
  };
}

export async function revokeAgentConnection(input: { userId: string; connectionId: string; now: Date }) {
  const prisma = getPrisma();
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM "agent_connections"
      WHERE "id" = ${input.connectionId} AND "userId" = ${input.userId}
      FOR UPDATE
    `;
    const connection = await tx.agentConnection.findFirst({
      where: { id: input.connectionId, userId: input.userId },
      select: {
        id: true,
        status: true,
        workosApplicationId: true,
        workosIdentity: { select: { workosUserId: true } },
      },
    });
    if (!connection) return { status: "not-found" as const };
    if (connection.status === AgentConnectionStatus.REVOKED) {
      return { status: "revoked" as const, alreadyRevoked: true };
    }
    await tx.agentConnection.update({
      where: { id: connection.id },
      data: {
        status: AgentConnectionStatus.REVOKED,
        revokedAt: input.now,
        remoteRevocationStatus: AgentRemoteRevocationStatus.PENDING,
      },
    });
    await tx.agentRevocationOutbox.upsert({
      where: { connectionId: connection.id },
      create: {
        userId: input.userId,
        connectionId: connection.id,
        workosUserId: connection.workosIdentity.workosUserId,
        applicationId: connection.workosApplicationId,
      },
      update: {
        status: AgentRevocationOutboxStatus.PENDING,
        nextAttemptAt: input.now,
        errorCode: null,
      },
    });
    return { status: "revoked" as const, alreadyRevoked: false };
  });
  if (result.status === "revoked") {
    await sendAgentConnectionRevocationRequested({
      userId: input.userId,
      connectionId: input.connectionId,
      requestedAt: input.now.toISOString(),
    });
  }
  return result;
}

export async function disableAgentAccessForAccountDeletion(input: {
  userId: string;
  now: Date;
}) {
  const prisma = getPrisma();
  const connectionIds = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${input.userId} FOR UPDATE`;
    const connections = await tx.agentConnection.findMany({
      where: { userId: input.userId },
      select: {
        id: true,
        workosApplicationId: true,
        workosIdentity: { select: { workosUserId: true } },
      },
    });
    await tx.user.updateMany({
      where: { id: input.userId },
      data: { agentAccessDisabledAt: input.now },
    });
    await tx.agentConnection.updateMany({
      where: { userId: input.userId, status: AgentConnectionStatus.ACTIVE },
      data: {
        status: AgentConnectionStatus.REVOKED,
        revokedAt: input.now,
        remoteRevocationStatus: AgentRemoteRevocationStatus.PENDING,
      },
    });
    for (const connection of connections) {
      await tx.agentRevocationOutbox.upsert({
        where: { connectionId: connection.id },
        create: {
          userId: input.userId,
          connectionId: connection.id,
          workosUserId: connection.workosIdentity.workosUserId,
          applicationId: connection.workosApplicationId,
          nextAttemptAt: input.now,
        },
        update: {
          status: AgentRevocationOutboxStatus.PENDING,
          nextAttemptAt: input.now,
          errorCode: null,
        },
      });
    }
    return connections.map((connection) => connection.id);
  });
  await Promise.all(
    connectionIds.map((connectionId) =>
      sendAgentConnectionRevocationRequested({
        userId: input.userId,
        connectionId,
        requestedAt: input.now.toISOString(),
      }),
    ),
  );
  return { status: "disabled" as const, connectionCount: connectionIds.length };
}

export async function pauseSkillsFromAgent(input: { userId: string; connectionId: string }) {
  const prisma = getPrisma();
  const connection = await prisma.agentConnection.findFirst({
    where: { id: input.connectionId, userId: input.userId },
    select: { id: true },
  });
  if (!connection) return { status: "not-found" as const };
  const skills = await prisma.skill.findMany({
    where: {
      userId: input.userId,
      status: SkillStatus.ACTIVE,
      agentCreatedItems: { some: { userId: input.userId, operation: { connectionId: input.connectionId } } },
    },
    select: { id: true },
  });
  const updated = await prisma.skill.updateMany({
    where: { id: { in: skills.map((skill) => skill.id) }, userId: input.userId, status: SkillStatus.ACTIVE },
    data: { status: SkillStatus.PAUSED },
  });
  return { status: "paused" as const, count: updated.count };
}

export async function resolveAgentDuplicateReview(input: {
  userId: string;
  itemId: string;
  decision: "use-existing" | "create-separately";
  now: Date;
}) {
  const prisma = getPrisma();
  const item = await prisma.agentSkillOperationItem.findFirst({
    where: { id: input.itemId, userId: input.userId, status: AgentOperationItemStatus.NEEDS_REVIEW },
    select: { id: true, operationId: true, createdSkillId: true, resultSkillId: true },
  });
  if (!item?.resultSkillId) return { status: "not-found" as const };
  if (input.decision === "use-existing") {
    await prisma.$transaction(async (tx) => {
      if (item.createdSkillId) {
        await tx.skill.deleteMany({ where: { id: item.createdSkillId, userId: input.userId, status: SkillStatus.DRAFT } });
      }
      await tx.agentSkillOperationItem.update({
        where: { id: item.id },
        data: {
          status: AgentOperationItemStatus.REUSED,
          activationReservedAt: null,
          completedAt: input.now,
        },
      });
    });
  } else {
    await prisma.agentSkillOperationItem.update({
      where: { id: item.id },
      data: {
        status: AgentOperationItemStatus.QUEUED,
        duplicateOverrideApprovedAt: input.now,
        activationReservedAt: null,
      },
    });
  }
  await sendAgentSkillOperationRequested({
    userId: input.userId,
    operationId: item.operationId,
    requestedAt: input.now.toISOString(),
  });
  return { status: "saved" as const };
}

export async function getAgentDuplicateReview(input: { userId: string; itemId: string }) {
  const prisma = getPrisma();
  return prisma.agentSkillOperationItem.findFirst({
    where: { id: input.itemId, userId: input.userId, status: AgentOperationItemStatus.NEEDS_REVIEW },
    select: {
      id: true,
      proposedTitle: true,
      proposedObjective: true,
      duplicateConfidence: true,
      createdSkillId: true,
      resultSkill: {
        select: { id: true, title: true, objective: true, tags: true, collection: { select: { name: true } } },
      },
      operation: { select: { connection: { select: { clientName: true } } } },
    },
  });
}

export async function runAgentConnectionRevocationJob(input: {
  userId: string;
  connectionId: string;
}) {
  const config = getAgentAccessConfig();
  const workosApiKey = config.enabled ? config.workosApiKey : process.env.WORKOS_API_KEY?.trim();
  if (!workosApiKey) throw new Error("WorkOS revocation credentials are unavailable.");
  const prisma = getPrisma();
  const revocationJob = await prisma.agentRevocationOutbox.findFirst({
    where: { connectionId: input.connectionId, userId: input.userId },
    select: {
      id: true,
      attemptCount: true,
      status: true,
      workosUserId: true,
      applicationId: true,
    },
  });
  if (!revocationJob) return { status: "not-found" as const };
  if (revocationJob.status === AgentRevocationOutboxStatus.SUCCEEDED) {
    return { status: "revoked" as const };
  }
  await prisma.agentRevocationOutbox.update({
    where: { id: revocationJob.id },
    data: { status: AgentRevocationOutboxStatus.RUNNING, attemptCount: { increment: 1 } },
  });
  const response = await fetch(
    `https://api.workos.com/user_management/users/${encodeURIComponent(revocationJob.workosUserId)}/authorized_applications/${encodeURIComponent(revocationJob.applicationId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${workosApiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok && response.status !== 404) {
    await prisma.$transaction([
      prisma.agentRevocationOutbox.update({
        where: { id: revocationJob.id },
        data: { status: AgentRevocationOutboxStatus.FAILED, errorCode: `WORKOS_${response.status}`, nextAttemptAt: new Date(Date.now() + 60_000) },
      }),
      prisma.agentConnection.updateMany({
        where: { id: input.connectionId, userId: input.userId },
        data: { remoteRevocationStatus: AgentRemoteRevocationStatus.FAILED },
      }),
    ]);
    throw new Error(`WorkOS authorized application deletion failed with HTTP ${response.status}.`);
  }
  await prisma.$transaction([
    prisma.agentRevocationOutbox.update({
      where: { id: revocationJob.id },
      data: { status: AgentRevocationOutboxStatus.SUCCEEDED, errorCode: null, completedAt: new Date(), nextAttemptAt: null },
    }),
    prisma.agentConnection.updateMany({
      where: { id: input.connectionId, userId: input.userId },
      data: { remoteRevocationStatus: AgentRemoteRevocationStatus.SUCCEEDED },
    }),
  ]);
  return { status: "revoked" as const };
}

export async function runAgentAccessMaintenance(now: Date) {
  const prisma = getPrisma();
  const [purged, rateBuckets, pending] = await Promise.all([
    prisma.agentSkillOperation.updateMany({
      where: { payloadExpiresAt: { lte: now }, requestPayload: { not: Prisma.DbNull } },
      data: { requestPayload: Prisma.DbNull, payloadExpiresAt: null },
    }),
    prisma.agentRateLimitBucket.deleteMany({
      where: { windowStart: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1_000) } },
    }),
    prisma.agentRevocationOutbox.findMany({
      where: {
        status: { in: [AgentRevocationOutboxStatus.PENDING, AgentRevocationOutboxStatus.FAILED] },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { createdAt: "asc" },
      take: 25,
      select: { userId: true, connectionId: true },
    }),
  ]);
  const revocations = await Promise.allSettled(
    pending.map((job) => runAgentConnectionRevocationJob(job)),
  );
  return {
    purgedPayloads: purged.count,
    purgedRateBuckets: rateBuckets.count,
    revocationsAttempted: pending.length,
    revocationsFailed: revocations.filter((result) => result.status === "rejected").length,
  };
}
