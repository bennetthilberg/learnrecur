import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/inngest/events", () => ({
  sendAgentConnectionRevocationRequested: vi.fn().mockResolvedValue(undefined),
  sendAgentSkillOperationRequested: vi.fn().mockResolvedValue(undefined),
}));

import {
  AgentConnectionStatus,
  AgentOperationKind,
  AgentOperationStatus,
  AgentRemoteRevocationStatus,
  AgentRevocationOutboxStatus,
  SkillStatus,
} from "@/generated/prisma/client";
import {
  disableAgentAccessForAccountDeletion,
  revokeAgentConnection,
} from "@/lib/agent-access/settings";
import {
  AgentOperationError,
  createAgentSpecOperation,
} from "@/lib/agent-access/operations";
import { reserveAgentActivation } from "@/lib/agent-access/worker";
import { getPrisma } from "@/lib/prisma";
import { getUserDataExport } from "@/lib/settings/data-export";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `agent_access_${randomUUID()}`;

describeDatabase("agent access persistence", () => {
  const prisma = getPrisma();
  const userIds: string[] = [];

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    await prisma.agentRevocationOutbox.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  async function createConnection(label: string) {
    const userId = `${runId}_${label}`;
    userIds.push(userId);
    await prisma.user.create({ data: { id: userId, email: `${label}@example.test` } });
    const identity = await prisma.workosIdentity.create({
      data: {
        userId,
        workosUserId: `workos_${label}_${runId}`,
        externalId: userId,
      },
    });
    const connection = await prisma.agentConnection.create({
      data: {
        userId,
        workosIdentityId: identity.id,
        workosSubject: identity.workosUserId,
        workosSessionId: `session_${label}_${runId}`,
        workosApplicationId: `application_${label}_${runId}`,
        clientId: `https://${label}.example.test/client.json`,
        clientName: `${label} agent`,
        clientDomain: `${label}.example.test`,
        resourceUrl: "https://learnrecur.com/mcp",
        scopes: ["skills:create"],
      },
    });
    return { userId, identity, connection };
  }

  it("revokes locally before queuing a durable remote revocation", async () => {
    const fixture = await createConnection("revoke");
    const now = new Date("2026-08-13T15:00:00.000Z");

    await expect(
      revokeAgentConnection({ userId: fixture.userId, connectionId: fixture.connection.id, now }),
    ).resolves.toMatchObject({ status: "revoked", alreadyRevoked: false });

    const connection = await prisma.agentConnection.findUniqueOrThrow({
      where: { id: fixture.connection.id },
    });
    expect(connection).toMatchObject({
      status: AgentConnectionStatus.REVOKED,
      remoteRevocationStatus: AgentRemoteRevocationStatus.PENDING,
      revokedAt: now,
    });
    await expect(
      prisma.agentRevocationOutbox.findUniqueOrThrow({
        where: { connectionId: fixture.connection.id },
      }),
    ).resolves.toMatchObject({
      userId: fixture.userId,
      workosUserId: fixture.identity.workosUserId,
      applicationId: fixture.connection.workosApplicationId,
      status: AgentRevocationOutboxStatus.PENDING,
    });
  });

  it("keeps remote revocation tombstones after account data cascades", async () => {
    const fixture = await createConnection("delete");
    await disableAgentAccessForAccountDeletion({
      userId: fixture.userId,
      now: new Date("2026-08-13T16:00:00.000Z"),
    });
    await prisma.user.delete({ where: { id: fixture.userId } });

    await expect(
      prisma.agentRevocationOutbox.findUniqueOrThrow({
        where: { connectionId: fixture.connection.id },
      }),
    ).resolves.toMatchObject({
      userId: fixture.userId,
      workosUserId: fixture.identity.workosUserId,
      applicationId: fixture.connection.workosApplicationId,
    });
  });

  it("enforces owned source links and exports safe agent provenance", async () => {
    const owner = await createConnection("owner");
    const other = await createConnection("other");
    const operation = await prisma.agentSkillOperation.create({
      data: {
        userId: owner.userId,
        connectionId: owner.connection.id,
        kind: AgentOperationKind.SPEC_BATCH,
        toolName: "skills.add_from_specs",
        status: AgentOperationStatus.SUCCEEDED,
        idempotencyKey: `idempotency-${runId}`,
        payloadHash: "a".repeat(64),
        requestedCount: 1,
        activeCount: 1,
        items: {
          create: {
            ordinal: 0,
            clientReference: "skill-1",
            proposedTitle: "A safe exported skill",
            proposedObjective: "Recall the bounded provenance contract.",
            status: "ACTIVE",
          },
        },
      },
    });
    const foreignSource = await prisma.sourceFile.create({
      data: { userId: other.userId, originalName: "private.pdf" },
    });
    await expect(
      prisma.agentOperationSource.create({
        data: {
          userId: owner.userId,
          operationId: operation.id,
          sourceFileId: foreignSource.id,
          ordinal: 0,
        },
      }),
    ).rejects.toBeDefined();

    const exported = await getUserDataExport({
      userId: owner.userId,
      generatedAt: new Date("2026-08-13T17:00:00.000Z"),
    });
    expect(exported.status).toBe("ready");
    if (exported.status !== "ready") return;
    expect(exported.export.agentConnections).toHaveLength(1);
    expect(exported.export.agentConnections[0]).not.toHaveProperty("workosSubject");
    expect(exported.export.agentOperations).toEqual([
      expect.objectContaining({ id: operation.id, payloadHash: "a".repeat(64) }),
    ]);
    expect(exported.export.agentOperations[0]).not.toHaveProperty("requestPayload");
    expect(exported.export.agentOperationItems).toEqual([
      expect.objectContaining({ proposedTitle: "A safe exported skill" }),
    ]);
  });

  it("replays identical operation keys and rejects changed bodies", async () => {
    const fixture = await createConnection("idempotency");
    const auth = {
      userId: fixture.userId,
      connectionId: fixture.connection.id,
      subject: fixture.identity.workosUserId,
      sessionId: fixture.connection.workosSessionId,
      clientId: fixture.connection.clientId,
      clientName: fixture.connection.clientName,
      clientDomain: fixture.connection.clientDomain,
      resourceUrl: fixture.connection.resourceUrl,
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
      scopes: ["skills:create" as const],
    };
    const request = {
      idempotency_key: "stable-request-key",
      items: [
        {
          client_reference: "item-1",
          skill: {
            title: "Binary search boundaries",
            objective: "Choose the correct binary-search boundary update.",
            rules: [],
            examples: [],
            exerciseConstraints: "",
            tags: ["algorithms"],
          },
        },
      ],
    };

    const concurrent = await Promise.all(
      Array.from({ length: 4 }, () => createAgentSpecOperation(auth, request)),
    );
    const [first] = concurrent;
    expect(new Set(concurrent.map((result) => result.operation_id))).toEqual(
      new Set([first.operation_id]),
    );
    await expect(
      createAgentSpecOperation(auth, {
        ...request,
        items: [{ ...request.items[0], client_reference: "changed-item" }],
      }),
    ).rejects.toMatchObject<Partial<AgentOperationError>>({ code: "idempotency_conflict" });
    await expect(
      prisma.agentSkillOperation.count({
        where: { connectionId: fixture.connection.id, toolName: "skills.add_from_specs" },
      }),
    ).resolves.toBe(1);
  });

  it("serializes active-skill reservations at the shared account limit", async () => {
    const fixture = await createConnection("quota");
    await prisma.skill.createMany({
      data: Array.from({ length: 99 }, (_, index) => ({
        userId: fixture.userId,
        title: `Active skill ${index + 1}`,
        objective: `Practice active skill number ${index + 1}.`,
        status: SkillStatus.ACTIVE,
      })),
    });
    const operation = await prisma.agentSkillOperation.create({
      data: {
        userId: fixture.userId,
        connectionId: fixture.connection.id,
        kind: AgentOperationKind.SPEC_BATCH,
        toolName: "skills.add_from_specs",
        idempotencyKey: `quota-${runId}`,
        payloadHash: "b".repeat(64),
        requestedCount: 2,
        items: {
          create: [
            { ordinal: 0, clientReference: "first" },
            { ordinal: 1, clientReference: "second" },
          ],
        },
      },
      include: { items: { orderBy: { ordinal: "asc" } } },
    });

    const reservations = await Promise.all(
      operation.items.map((item) =>
        reserveAgentActivation(fixture.userId, item.id, new Date("2026-08-13T18:00:00.000Z")),
      ),
    );
    expect(reservations.filter(Boolean)).toHaveLength(1);
  });
});
