import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs/events", () => ({
  sendAgentConnectionRevocationRequested: vi.fn().mockResolvedValue(undefined),
  sendAgentSkillOperationRequested: vi.fn().mockResolvedValue(undefined),
}));

import {
  AgentConnectionStatus,
  AgentOperationKind,
  AgentOperationItemStatus,
  AgentOperationStatus,
  AgentRateLimitKind,
  AgentRemoteRevocationStatus,
  AgentRevocationOutboxStatus,
  SourceFileKind,
  SourceFileStatus,
  SkillStatus,
} from "@/generated/prisma/client";
import {
  disableAgentAccessForAccountDeletion,
  pauseSkillsFromAgent,
  resolveAgentDuplicateReview,
  revokeAgentConnection,
  runAgentAccessMaintenance,
} from "@/lib/agent-access/settings";
import {
  AgentOperationError,
  continueAgentOperation,
  createAgentSpecOperation,
} from "@/lib/agent-access/operations";
import { listAgentMaterials } from "@/lib/agent-access/materials";
import { reserveAgentActivation, runAgentSkillOperationJob } from "@/lib/agent-access/worker";
import {
  sendAgentConnectionRevocationRequested,
  sendAgentSkillOperationRequested,
} from "@/lib/jobs/events";
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
        workosSubject: identity.externalId,
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
    vi.mocked(sendAgentConnectionRevocationRequested).mockRejectedValueOnce(
      new Error("temporary event dispatch failure"),
    );

    await expect(
      revokeAgentConnection({ userId: fixture.userId, connectionId: fixture.connection.id, now }),
    ).resolves.toMatchObject({ status: "revoked", alreadyRevoked: false });
    expect(sendAgentConnectionRevocationRequested).toHaveBeenCalledWith({
      userId: fixture.userId,
      connectionId: fixture.connection.id,
      requestedAt: now.toISOString(),
    });

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

  it("revokes every local connection covered by one WorkOS grant", async () => {
    const fixture = await createConnection("grant-revoke");
    const sibling = await prisma.agentConnection.create({
      data: {
        userId: fixture.userId,
        workosIdentityId: fixture.identity.id,
        workosSubject: fixture.identity.externalId,
        workosSessionId: `session_grant_sibling_${runId}`,
        workosApplicationId: fixture.connection.workosApplicationId,
        clientId: fixture.connection.clientId,
        clientName: fixture.connection.clientName,
        clientDomain: fixture.connection.clientDomain,
        resourceUrl: fixture.connection.resourceUrl,
        scopes: ["skills:create"],
      },
    });
    const now = new Date("2026-08-13T15:30:00.000Z");

    await expect(
      revokeAgentConnection({ userId: fixture.userId, connectionId: fixture.connection.id, now }),
    ).resolves.toMatchObject({ status: "revoked", alreadyRevoked: false });
    await expect(
      prisma.agentConnection.findMany({
        where: { id: { in: [fixture.connection.id, sibling.id] } },
        select: { status: true, revokedAt: true, remoteRevocationStatus: true },
      }),
    ).resolves.toEqual([
      {
        status: AgentConnectionStatus.REVOKED,
        revokedAt: now,
        remoteRevocationStatus: AgentRemoteRevocationStatus.PENDING,
      },
      {
        status: AgentConnectionStatus.REVOKED,
        revokedAt: now,
        remoteRevocationStatus: AgentRemoteRevocationStatus.PENDING,
      },
    ]);
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
      subject: fixture.identity.externalId,
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

    vi.mocked(sendAgentSkillOperationRequested).mockClear();
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
    expect(sendAgentSkillOperationRequested).toHaveBeenCalledTimes(1);
  });

  it("rate-limits material reads through the shared connection bucket", async () => {
    const fixture = await createConnection("material-read-limit");
    const auth = {
      userId: fixture.userId,
      connectionId: fixture.connection.id,
      subject: fixture.identity.externalId,
      sessionId: fixture.connection.workosSessionId,
      clientId: fixture.connection.clientId,
      clientName: fixture.connection.clientName,
      clientDomain: fixture.connection.clientDomain,
      resourceUrl: fixture.connection.resourceUrl,
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
      scopes: ["materials:read" as const],
    };

    await prisma.agentRateLimitBucket.create({
      data: {
        userId: fixture.userId,
        connectionId: fixture.connection.id,
        kind: AgentRateLimitKind.READ,
        windowStart: new Date(Math.floor(Date.now() / 60_000) * 60_000),
        count: 60,
      },
    });
    await expect(listAgentMaterials(auth, {})).rejects.toMatchObject<
      Partial<AgentOperationError>
    >({ code: "rate_limited" });
  });

  it("preserves a material request while recording its clarification", async () => {
    const fixture = await createConnection("material-clarification");
    const operation = await prisma.agentSkillOperation.create({
      data: {
        userId: fixture.userId,
        connectionId: fixture.connection.id,
        kind: AgentOperationKind.MATERIAL_BATCH,
        toolName: "skills.add_from_material",
        status: AgentOperationStatus.NEEDS_INPUT,
        idempotencyKey: `clarification-${runId}`,
        payloadHash: "e".repeat(64),
        requestPayload: {
          instruction: "Cover the proof techniques in this chapter.",
          maxSkills: 3,
        },
        requestedCount: 3,
      },
    });
    const auth = {
      userId: fixture.userId,
      connectionId: fixture.connection.id,
      subject: fixture.identity.externalId,
      sessionId: fixture.connection.workosSessionId,
      clientId: fixture.connection.clientId,
      clientName: fixture.connection.clientName,
      clientDomain: fixture.connection.clientDomain,
      resourceUrl: fixture.connection.resourceUrl,
      expiresAt: Math.floor(Date.now() / 1_000) + 300,
      scopes: ["skills:create" as const],
    };

    await continueAgentOperation(auth, {
      operation_id: operation.id,
      idempotency_key: "continue-material-request",
      instruction: "Focus on induction and contradiction.",
    });

    await expect(
      prisma.agentSkillOperation.findUniqueOrThrow({
        where: { id: operation.id },
        select: { requestPayload: true },
      }),
    ).resolves.toEqual({
      requestPayload: {
        instruction: "Cover the proof techniques in this chapter.",
        clarification: "Focus on induction and contradiction.",
        maxSkills: 3,
      },
    });
  });

  it("cancels expired upload operations and removes their draft sources", async () => {
    const fixture = await createConnection("upload-expiry");
    const source = await prisma.sourceFile.create({
      data: {
        userId: fixture.userId,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.DRAFT,
        originalName: "abandoned.pdf",
        mimeType: "application/pdf",
        byteSize: 1_024,
        storageBucket: "staging-private",
        storageKey: `agent-test/${runId}/abandoned.pdf`,
      },
    });
    const operation = await prisma.agentSkillOperation.create({
      data: {
        userId: fixture.userId,
        connectionId: fixture.connection.id,
        kind: AgentOperationKind.QUICK_FILES,
        toolName: "skills.prepare_files",
        status: AgentOperationStatus.AWAITING_UPLOAD,
        idempotencyKey: `upload-expiry-${runId}`,
        payloadHash: "f".repeat(64),
        requestedCount: 1,
        createdAt: new Date("2026-08-13T10:00:00.000Z"),
        items: { create: { ordinal: 0, clientReference: "files-1" } },
        sources: { create: { sourceFileId: source.id, ordinal: 0 } },
      },
      include: { items: true },
    });

    await expect(
      runAgentAccessMaintenance(new Date("2026-08-13T10:11:00.000Z")),
    ).resolves.toMatchObject({ expiredUploadOperations: 1 });
    await expect(
      prisma.agentSkillOperation.findUniqueOrThrow({ where: { id: operation.id } }),
    ).resolves.toMatchObject({
      status: AgentOperationStatus.CANCELED,
      errorCode: "UPLOAD_WINDOW_EXPIRED",
    });
    await expect(
      prisma.agentSkillOperationItem.findUniqueOrThrow({ where: { id: operation.items[0].id } }),
    ).resolves.toMatchObject({
      status: AgentOperationItemStatus.CANCELED,
      errorCode: "UPLOAD_WINDOW_EXPIRED",
    });
    await expect(prisma.sourceFile.findUnique({ where: { id: source.id } })).resolves.toBeNull();
  });

  it("reclaims interrupted text items and resumes their stored draft", async () => {
    const fixture = await createConnection("worker-recovery");
    const [source, staleDraft] = await Promise.all([
      prisma.sourceFile.create({
        data: {
          userId: fixture.userId,
          kind: SourceFileKind.TEXT,
          status: SourceFileStatus.READY,
          originalName: "agent text",
          extractedText: "A sufficiently long source passage for an interrupted text operation.",
        },
      }),
      prisma.skill.create({
        data: {
          userId: fixture.userId,
          title: "Interrupted draft",
          objective: "Practice recovering a previously created agent skill draft.",
          status: SkillStatus.ARCHIVED,
        },
      }),
    ]);
    const operation = await prisma.agentSkillOperation.create({
      data: {
        userId: fixture.userId,
        connectionId: fixture.connection.id,
        kind: AgentOperationKind.TEXT_SOURCE,
        toolName: "skills.add_from_text",
        status: AgentOperationStatus.ACTIVATING,
        idempotencyKey: `worker-recovery-${runId}`,
        payloadHash: "1".repeat(64),
        sourceFileId: source.id,
        requestedCount: 1,
        items: {
          create: {
            ordinal: 0,
            clientReference: "text-1",
            status: AgentOperationItemStatus.ACTIVATING,
            createdSkillId: staleDraft.id,
            activationReservedAt: new Date("2026-08-13T11:00:00.000Z"),
          },
        },
      },
      include: { items: true },
    });

    await expect(
      runAgentSkillOperationJob({
        userId: fixture.userId,
        operationId: operation.id,
        now: new Date("2026-08-13T11:05:00.000Z"),
      }),
    ).resolves.toMatchObject({ status: "processed" });
    await expect(
      prisma.agentSkillOperationItem.findUniqueOrThrow({ where: { id: operation.items[0].id } }),
    ).resolves.toMatchObject({
      status: AgentOperationItemStatus.FAILED,
      createdSkillId: staleDraft.id,
      errorCode: "DRAFT_NOT_FOUND",
      activationReservedAt: null,
    });
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

  it("pauses only active skills created through the selected connection", async () => {
    const fixture = await createConnection("pause");
    const [agentSkill, browserSkill] = await Promise.all([
      prisma.skill.create({
        data: {
          userId: fixture.userId,
          title: "Agent-created limits",
          objective: "Recall the limits attached to an agent-created skill.",
          status: SkillStatus.ACTIVE,
        },
      }),
      prisma.skill.create({
        data: {
          userId: fixture.userId,
          title: "Browser-created limits",
          objective: "Recall the limits attached to a browser-created skill.",
          status: SkillStatus.ACTIVE,
        },
      }),
    ]);
    await prisma.agentSkillOperation.create({
      data: {
        userId: fixture.userId,
        connectionId: fixture.connection.id,
        kind: AgentOperationKind.SPEC_BATCH,
        toolName: "skills.add_from_specs",
        status: AgentOperationStatus.SUCCEEDED,
        idempotencyKey: `pause-${runId}`,
        payloadHash: "c".repeat(64),
        requestedCount: 1,
        activeCount: 1,
        items: {
          create: {
            ordinal: 0,
            clientReference: "pause-skill",
            status: AgentOperationItemStatus.ACTIVE,
            createdSkillId: agentSkill.id,
            resultSkillId: agentSkill.id,
            completedAt: new Date("2026-08-13T18:30:00.000Z"),
          },
        },
      },
    });

    await expect(
      pauseSkillsFromAgent({ userId: fixture.userId, connectionId: fixture.connection.id }),
    ).resolves.toEqual({ status: "paused", count: 1 });
    await expect(
      prisma.skill.findMany({
        where: { id: { in: [agentSkill.id, browserSkill.id] } },
        orderBy: { title: "asc" },
        select: { title: true, status: true },
      }),
    ).resolves.toEqual([
      { title: "Agent-created limits", status: SkillStatus.PAUSED },
      { title: "Browser-created limits", status: SkillStatus.ACTIVE },
    ]);
  });

  it("resolves duplicate review without letting the agent choose the outcome", async () => {
    const fixture = await createConnection("duplicate-review");
    const existingSkill = await prisma.skill.create({
      data: {
        userId: fixture.userId,
        title: "Existing boundary checks",
        objective: "Practice the boundary checks already stored in the library.",
        status: SkillStatus.ACTIVE,
      },
    });
    const proposedDraft = await prisma.skill.create({
      data: {
        userId: fixture.userId,
        title: "Proposed boundary checks",
        objective: "Practice a proposed set of overlapping boundary checks.",
        status: SkillStatus.DRAFT,
      },
    });
    const operation = await prisma.agentSkillOperation.create({
      data: {
        userId: fixture.userId,
        connectionId: fixture.connection.id,
        kind: AgentOperationKind.SPEC_BATCH,
        toolName: "skills.add_from_specs",
        status: AgentOperationStatus.NEEDS_REVIEW,
        idempotencyKey: `review-${runId}`,
        payloadHash: "d".repeat(64),
        requestedCount: 1,
        items: {
          create: {
            ordinal: 0,
            clientReference: "duplicate-skill",
            status: AgentOperationItemStatus.NEEDS_REVIEW,
            createdSkillId: proposedDraft.id,
            resultSkillId: existingSkill.id,
          },
        },
      },
      include: { items: true },
    });
    const item = operation.items[0];

    await expect(
      resolveAgentDuplicateReview({
        userId: fixture.userId,
        itemId: item.id,
        decision: "use-existing",
        now: new Date("2026-08-13T19:00:00.000Z"),
      }),
    ).resolves.toEqual({ status: "saved" });
    await expect(prisma.skill.findUnique({ where: { id: proposedDraft.id } })).resolves.toBeNull();
    await expect(
      prisma.agentSkillOperationItem.findUniqueOrThrow({ where: { id: item.id } }),
    ).resolves.toMatchObject({
      status: AgentOperationItemStatus.REUSED,
      resultSkillId: existingSkill.id,
    });
  });
});
