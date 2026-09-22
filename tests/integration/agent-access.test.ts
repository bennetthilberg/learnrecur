import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/events")>()),
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
  GenerationFailureCategory,
  GenerationJobKind,
  GenerationJobStage,
  GenerationJobStatus,
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
  continueAgentOperation,
  createAgentSpecOperation,
} from "@/lib/agent-access/operations";
import { recoverStaleAgentOperationItems } from "@/lib/agent-access/recovery";
import { listAgentMaterials } from "@/lib/agent-access/materials";
import { reserveAgentActivation, runAgentSkillOperationJob } from "@/lib/agent-access/worker";
import {
  sendAgentConnectionRevocationRequested,
  sendAgentSkillOperationRequested,
} from "@/lib/jobs/events";
import { getPrisma } from "@/lib/prisma";
import { getUserDataExport } from "@/lib/settings/data-export";
import * as refillJobs from "@/lib/skills/refill-jobs";
import { ALPHA_ACTIVE_SKILLS } from "@/lib/usage-limits";

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
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
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
    await expect(listAgentMaterials(auth, {})).rejects.toMatchObject({
      code: "rate_limited",
    });
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

  it("finishes expiry and revocation before retrying failed refill recovery", async () => {
    const fixture = await createConnection("maintenance-recovery-failure");
    const now = new Date("2026-08-13T10:11:00.000Z");
    // Earlier cases intentionally leave durable outbox rows for their own
    // assertions. Remove only this suite's earlier rows so the bounded
    // maintenance batch tests this fixture deterministically.
    await prisma.agentRevocationOutbox.deleteMany({
      where: { userId: { in: userIds.filter((userId) => userId !== fixture.userId) } },
    });
    const source = await prisma.sourceFile.create({
      data: {
        userId: fixture.userId,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.DRAFT,
        originalName: "recovery-failure.pdf",
        mimeType: "application/pdf",
        byteSize: 1_024,
        storageBucket: "staging-private",
        storageKey: `agent-test/${runId}/recovery-failure.pdf`,
      },
    });
    const operation = await prisma.agentSkillOperation.create({
      data: {
        userId: fixture.userId,
        connectionId: fixture.connection.id,
        kind: AgentOperationKind.QUICK_FILES,
        toolName: "skills.prepare_files",
        status: AgentOperationStatus.AWAITING_UPLOAD,
        idempotencyKey: `recovery-failure-${runId}`,
        payloadHash: "r".repeat(64),
        requestedCount: 1,
        createdAt: new Date("2026-08-13T10:00:00.000Z"),
        items: { create: { ordinal: 0, clientReference: "files-1" } },
        sources: { create: { sourceFileId: source.id, ordinal: 0 } },
      },
      include: { items: true },
    });
    await prisma.agentRevocationOutbox.create({
      data: {
        userId: fixture.userId,
        connectionId: fixture.connection.id,
        workosUserId: fixture.identity.workosUserId,
        applicationId: fixture.connection.workosApplicationId,
        status: AgentRevocationOutboxStatus.PENDING,
        nextAttemptAt: now,
      },
    });

    const recovery = vi
      .spyOn(refillJobs, "recoverPendingRefillEvents")
      .mockRejectedValueOnce(new Error("private database failure"));
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 404 }));
    // The CI database gate intentionally does not provision WorkOS credentials.
    // Supply a synthetic key so maintenance reaches the mocked remote delete.
    vi.stubEnv("WORKOS_API_KEY", "sk_test_agent_maintenance");
    try {
      await expect(runAgentAccessMaintenance(now)).rejects.toMatchObject({
        message: "Agent access maintenance could not recover refill events.",
        retryable: true,
      });
      expect(recovery).toHaveBeenCalledWith({ now });
      expect(fetch).toHaveBeenCalledTimes(1);
      await expect(
        prisma.agentSkillOperation.findUniqueOrThrow({ where: { id: operation.id } }),
      ).resolves.toMatchObject({
        status: AgentOperationStatus.CANCELED,
        errorCode: "UPLOAD_WINDOW_EXPIRED",
      });
      await expect(prisma.sourceFile.findUnique({ where: { id: source.id } })).resolves.toBeNull();
      await expect(
        prisma.agentRevocationOutbox.findUniqueOrThrow({ where: { connectionId: fixture.connection.id } }),
      ).resolves.toMatchObject({ status: AgentRevocationOutboxStatus.SUCCEEDED });
    } finally {
      vi.unstubAllEnvs();
      recovery.mockRestore();
      fetch.mockRestore();
    }
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
            workerClaimToken: "interrupted-token",
            workerClaimedAt: new Date("2026-08-13T11:00:00.000Z"),
            updatedAt: new Date("2026-08-13T11:00:00.000Z"),
          },
        },
      },
      include: { items: true },
    });

    const recoveryNow = new Date("2026-08-13T11:10:00.000Z");
    await expect(
      recoverStaleAgentOperationItems({
        userId: fixture.userId,
        operationId: operation.id,
        now: recoveryNow,
      }),
    ).resolves.toMatchObject({ requeued: 1, continuations: 1 });
    await expect(
      runAgentSkillOperationJob({
        userId: fixture.userId,
        operationId: operation.id,
        now: recoveryNow,
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

  it("fences stale activation recovery and preserves fresh generation work", async () => {
    const staleFixture = await createConnection("stale-activation");
    const staleNow = new Date("2026-08-13T12:00:00.000Z");
    const staleClaimedAt = new Date("2026-08-13T11:45:00.000Z");
    const staleSkill = await prisma.skill.create({
      data: {
        userId: staleFixture.userId,
        title: "Stale recovery draft",
        objective: "Practice a draft whose activation worker stopped.",
        status: SkillStatus.DRAFT,
      },
    });
    const staleJob = await prisma.generationJob.create({
      data: {
        userId: staleFixture.userId,
        skillId: staleSkill.id,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        status: GenerationJobStatus.RUNNING,
        stage: GenerationJobStage.GENERATING,
        provider: "google",
        model: "recovery-test-gemini",
        promptVersion: "recovery-test-v1",
        requestedCount: 3,
        startedAt: staleClaimedAt,
        updatedAt: staleClaimedAt,
      },
    });
    const staleOperation = await prisma.agentSkillOperation.create({
      data: {
        userId: staleFixture.userId,
        connectionId: staleFixture.connection.id,
        kind: AgentOperationKind.SPEC_BATCH,
        toolName: "skills.add_from_specs",
        status: AgentOperationStatus.ACTIVATING,
        idempotencyKey: `stale-activation-${runId}`,
        payloadHash: "2".repeat(64),
        requestedCount: 1,
        items: {
          create: {
            ordinal: 0,
            clientReference: "stale-activation-item",
            status: AgentOperationItemStatus.ACTIVATING,
            createdSkillId: staleSkill.id,
            activationReservedAt: staleClaimedAt,
            workerClaimToken: "stale-worker-token",
            workerClaimedAt: staleClaimedAt,
            updatedAt: staleClaimedAt,
          },
        },
      },
      include: { items: true },
    });

    vi.mocked(sendAgentSkillOperationRequested).mockClear();
    await expect(
      recoverStaleAgentOperationItems({
        userId: staleFixture.userId,
        operationId: staleOperation.id,
        now: staleNow,
      }),
    ).resolves.toMatchObject({ scanned: 1, requeued: 1, continuations: 1 });
    await expect(
      prisma.generationJob.findUniqueOrThrow({ where: { id: staleJob.id } }),
    ).resolves.toMatchObject({
      status: GenerationJobStatus.FAILED,
      stage: GenerationJobStage.FAILED,
      failureCategory: GenerationFailureCategory.TIMEOUT,
      completedAt: staleNow,
    });
    const staleItem = await prisma.agentSkillOperationItem.findUniqueOrThrow({
      where: { id: staleOperation.items[0].id },
    });
    expect(staleItem).toMatchObject({
      status: AgentOperationItemStatus.QUEUED,
      createdSkillId: staleSkill.id,
      activationReservedAt: null,
      workerClaimToken: null,
      errorCode: "TRANSIENT_WORKER_FAILURE",
      retryCount: 1,
    });
    expect(sendAgentSkillOperationRequested).toHaveBeenCalledWith({
      userId: staleFixture.userId,
      operationId: staleOperation.id,
      requestedAt: staleNow.toISOString(),
    });
    await expect(
      prisma.agentSkillOperation.findUniqueOrThrow({ where: { id: staleOperation.id } }),
    ).resolves.toMatchObject({ status: AgentOperationStatus.QUEUED });

    await expect(
      prisma.agentSkillOperationItem.updateMany({
        where: {
          id: staleItem.id,
          userId: staleFixture.userId,
          workerClaimToken: "stale-worker-token",
        },
        data: { status: AgentOperationItemStatus.ACTIVE },
      }),
    ).resolves.toMatchObject({ count: 0 });

    const freshFixture = await createConnection("fresh-activation");
    const freshClaimedAt = new Date("2026-08-13T11:45:00.000Z");
    const freshJobUpdatedAt = new Date("2026-08-13T11:59:00.000Z");
    const freshSkill = await prisma.skill.create({
      data: {
        userId: freshFixture.userId,
        title: "Fresh recovery draft",
        objective: "Keep a live activation owned by its current worker.",
        status: SkillStatus.DRAFT,
      },
    });
    const freshJob = await prisma.generationJob.create({
      data: {
        userId: freshFixture.userId,
        skillId: freshSkill.id,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        status: GenerationJobStatus.RUNNING,
        stage: GenerationJobStage.VERIFYING,
        provider: "google",
        model: "recovery-test-gemini",
        promptVersion: "recovery-test-v1",
        requestedCount: 3,
        startedAt: freshClaimedAt,
        updatedAt: freshJobUpdatedAt,
      },
    });
    const freshOperation = await prisma.agentSkillOperation.create({
      data: {
        userId: freshFixture.userId,
        connectionId: freshFixture.connection.id,
        kind: AgentOperationKind.SPEC_BATCH,
        toolName: "skills.add_from_specs",
        status: AgentOperationStatus.ACTIVATING,
        idempotencyKey: `fresh-activation-${runId}`,
        payloadHash: "3".repeat(64),
        requestedCount: 1,
        items: {
          create: {
            ordinal: 0,
            clientReference: "fresh-activation-item",
            status: AgentOperationItemStatus.ACTIVATING,
            createdSkillId: freshSkill.id,
            activationReservedAt: freshClaimedAt,
            workerClaimToken: "fresh-worker-token",
            workerClaimedAt: freshClaimedAt,
            updatedAt: freshClaimedAt,
          },
        },
      },
    });
    await expect(
      recoverStaleAgentOperationItems({
        userId: freshFixture.userId,
        operationId: freshOperation.id,
        now: staleNow,
      }),
    ).resolves.toMatchObject({ scanned: 1, waiting: 1, requeued: 0 });
    await expect(
      prisma.generationJob.findUniqueOrThrow({ where: { id: freshJob.id } }),
    ).resolves.toMatchObject({ status: GenerationJobStatus.RUNNING });
    await expect(
      prisma.agentSkillOperationItem.findFirstOrThrow({
        where: { operationId: freshOperation.id },
      }),
    ).resolves.toMatchObject({
      status: AgentOperationItemStatus.ACTIVATING,
      workerClaimToken: "fresh-worker-token",
      activationReservedAt: freshClaimedAt,
    });
  });

  it("finalizes an activation that published before recovery inspected it", async () => {
    const fixture = await createConnection("published-before-recovery");
    const now = new Date("2026-08-13T12:00:00.000Z");
    const claimedAt = new Date("2026-08-13T11:45:00.000Z");
    const skill = await prisma.skill.create({
      data: {
        userId: fixture.userId,
        title: "Published recovery skill",
        objective: "Reconcile an activation after publication committed.",
        status: SkillStatus.ACTIVE,
      },
    });
    const operation = await prisma.agentSkillOperation.create({
      data: {
        userId: fixture.userId,
        connectionId: fixture.connection.id,
        kind: AgentOperationKind.SPEC_BATCH,
        toolName: "skills.add_from_specs",
        status: AgentOperationStatus.ACTIVATING,
        idempotencyKey: `published-recovery-${runId}`,
        payloadHash: "4".repeat(64),
        requestedCount: 1,
        items: {
          create: {
            ordinal: 0,
            clientReference: "published-recovery-item",
            status: AgentOperationItemStatus.ACTIVATING,
            createdSkillId: skill.id,
            activationReservedAt: claimedAt,
            workerClaimToken: "published-worker-token",
            workerClaimedAt: claimedAt,
            updatedAt: claimedAt,
          },
        },
      },
    });

    await expect(
      recoverStaleAgentOperationItems({
        userId: fixture.userId,
        operationId: operation.id,
        now,
      }),
    ).resolves.toMatchObject({ scanned: 1, finalized: 1, continuations: 0 });
    await expect(
      prisma.agentSkillOperationItem.findFirstOrThrow({ where: { operationId: operation.id } }),
    ).resolves.toMatchObject({
      status: AgentOperationItemStatus.ACTIVE,
      resultSkillId: skill.id,
      activationReservedAt: null,
      workerClaimToken: null,
      completedAt: now,
    });
    await expect(
      prisma.agentSkillOperation.findUniqueOrThrow({ where: { id: operation.id } }),
    ).resolves.toMatchObject({ status: AgentOperationStatus.SUCCEEDED, activeCount: 1 });
  });

  it("keeps concurrent deliveries waiting on one running activation without duplicating records", async () => {
    const fixture = await createConnection("concurrent-worker-wait");
    const now = new Date("2026-08-13T13:00:00.000Z");
    const skill = await prisma.skill.create({
      data: {
        userId: fixture.userId,
        title: "Concurrent activation draft",
        objective: "Wait for a single existing activation before publishing.",
        status: SkillStatus.DRAFT,
      },
    });
    const job = await prisma.generationJob.create({
      data: {
        userId: fixture.userId,
        skillId: skill.id,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        status: GenerationJobStatus.RUNNING,
        stage: GenerationJobStage.PUBLISHING,
        provider: "google",
        model: "recovery-test-gemini",
        promptVersion: "recovery-test-v1",
        requestedCount: 5,
        startedAt: now,
        updatedAt: now,
      },
    });
    const operation = await prisma.agentSkillOperation.create({
      data: {
        userId: fixture.userId,
        connectionId: fixture.connection.id,
        kind: AgentOperationKind.SPEC_BATCH,
        toolName: "skills.add_from_specs",
        status: AgentOperationStatus.QUEUED,
        idempotencyKey: "concurrent-worker-wait-" + runId,
        payloadHash: "5".repeat(64),
        requestedCount: 1,
        items: {
          create: {
            ordinal: 0,
            clientReference: "concurrent-wait-item",
            status: AgentOperationItemStatus.QUEUED,
            createdSkillId: skill.id,
          },
        },
      },
      include: { items: true },
    });

    await expect(
      Promise.all([
        runAgentSkillOperationJob({ userId: fixture.userId, operationId: operation.id, now }),
        runAgentSkillOperationJob({ userId: fixture.userId, operationId: operation.id, now }),
      ]),
    ).resolves.toEqual([
      { status: "processed", operationId: operation.id },
      { status: "processed", operationId: operation.id },
    ]);

    await expect(
      prisma.agentSkillOperationItem.findUniqueOrThrow({ where: { id: operation.items[0].id } }),
    ).resolves.toMatchObject({
      status: AgentOperationItemStatus.ACTIVATING,
      errorCode: "ACTIVATION_WAITING",
      workerClaimToken: null,
      workerClaimedAt: null,
      activationReservedAt: now,
      retryCount: 0,
    });
    await expect(
      prisma.agentSkillOperation.findUniqueOrThrow({ where: { id: operation.id } }),
    ).resolves.toMatchObject({
      status: AgentOperationStatus.ACTIVATING,
      activeCount: 0,
      reusedCount: 0,
      failedCount: 0,
      completedAt: null,
    });
    await expect(
      prisma.generationJob.count({
        where: { userId: fixture.userId, skillId: skill.id, kind: GenerationJobKind.SKILL_ACTIVATION },
      }),
    ).resolves.toBe(1);
    await expect(
      prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({ status: GenerationJobStatus.RUNNING });
    await expect(prisma.skill.count({ where: { userId: fixture.userId } })).resolves.toBe(1);
    await expect(prisma.exercise.count({ where: { userId: fixture.userId } })).resolves.toBe(0);
  });

  it("recovers stale legacy ACTIVATION_IN_PROGRESS failures and reconciles reservations", async () => {
    const fixture = await createConnection("legacy-activation-wait");
    const now = new Date("2026-08-13T14:00:00.000Z");
    const staleAt = new Date(now.getTime() - 10 * 60_000);
    const skill = await prisma.skill.create({
      data: {
        userId: fixture.userId,
        title: "Legacy activation draft",
        objective: "Resume a draft whose older worker marked activation as failed.",
        status: SkillStatus.DRAFT,
      },
    });
    const job = await prisma.generationJob.create({
      data: {
        userId: fixture.userId,
        skillId: skill.id,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        status: GenerationJobStatus.RUNNING,
        stage: GenerationJobStage.PUBLISHING,
        provider: "google",
        model: "recovery-test-gemini",
        promptVersion: "recovery-test-v1",
        requestedCount: 5,
        startedAt: staleAt,
        updatedAt: staleAt,
      },
    });
    const operation = await prisma.agentSkillOperation.create({
      data: {
        userId: fixture.userId,
        connectionId: fixture.connection.id,
        kind: AgentOperationKind.SPEC_BATCH,
        toolName: "skills.add_from_specs",
        status: AgentOperationStatus.QUEUED,
        idempotencyKey: "legacy-activation-wait-" + runId,
        payloadHash: "6".repeat(64),
        requestedCount: 1,
        items: {
          create: {
            ordinal: 0,
            clientReference: "legacy-wait-item",
            status: AgentOperationItemStatus.FAILED,
            errorCode: "ACTIVATION_IN_PROGRESS",
            errorMessage: "The previous worker observed another activation in progress.",
            createdSkillId: skill.id,
            activationReservedAt: staleAt,
            updatedAt: staleAt,
          },
        },
      },
      include: { items: true },
    });

    await expect(
      recoverStaleAgentOperationItems({
        userId: fixture.userId,
        operationId: operation.id,
        now,
      }),
    ).resolves.toMatchObject({ scanned: 1, requeued: 1, continuations: 1 });

    await expect(
      prisma.generationJob.findUniqueOrThrow({ where: { id: job.id } }),
    ).resolves.toMatchObject({
      status: GenerationJobStatus.FAILED,
      stage: GenerationJobStage.FAILED,
      failureCategory: GenerationFailureCategory.TIMEOUT,
      completedAt: now,
    });
    await expect(
      prisma.agentSkillOperationItem.findUniqueOrThrow({ where: { id: operation.items[0].id } }),
    ).resolves.toMatchObject({
      status: AgentOperationItemStatus.QUEUED,
      errorCode: "TRANSIENT_WORKER_FAILURE",
      activationReservedAt: null,
      workerClaimToken: null,
      workerClaimedAt: null,
      retryCount: 1,
      completedAt: null,
    });
    await expect(
      prisma.agentSkillOperation.findUniqueOrThrow({ where: { id: operation.id } }),
    ).resolves.toMatchObject({
      status: AgentOperationStatus.QUEUED,
      activeCount: 0,
      failedCount: 0,
      completedAt: null,
    });
    expect(sendAgentSkillOperationRequested).toHaveBeenCalledWith({
      userId: fixture.userId,
      operationId: operation.id,
      requestedAt: now.toISOString(),
    });
    await expect(prisma.skill.count({ where: { userId: fixture.userId } })).resolves.toBe(1);
    await expect(prisma.exercise.count({ where: { userId: fixture.userId } })).resolves.toBe(0);
  });

  it("does not reopen a stale child of a terminal operation", async () => {
    const fixture = await createConnection("terminal-recovery");
    const claimedAt = new Date("2026-08-13T13:45:00.000Z");
    const skill = await prisma.skill.create({
      data: {
        userId: fixture.userId,
        title: "Terminal recovery draft",
        objective: "Keep terminal operations closed during stale recovery.",
        status: SkillStatus.DRAFT,
      },
    });
    const operation = await prisma.agentSkillOperation.create({
      data: {
        userId: fixture.userId,
        connectionId: fixture.connection.id,
        kind: AgentOperationKind.SPEC_BATCH,
        toolName: "skills.add_from_specs",
        status: AgentOperationStatus.FAILED,
        idempotencyKey: `terminal-recovery-${runId}`,
        payloadHash: "terminal".repeat(8),
        requestedCount: 1,
        items: {
          create: {
            ordinal: 0,
            clientReference: "terminal-recovery-item",
            status: AgentOperationItemStatus.ACTIVATING,
            createdSkillId: skill.id,
            workerClaimToken: "terminal-worker-token",
            workerClaimedAt: claimedAt,
            updatedAt: claimedAt,
          },
        },
      },
      include: { items: true },
    });

    vi.mocked(sendAgentSkillOperationRequested).mockClear();
    await expect(
      recoverStaleAgentOperationItems({
        userId: fixture.userId,
        operationId: operation.id,
        now: new Date("2026-08-13T14:00:00.000Z"),
      }),
    ).resolves.toMatchObject({ scanned: 0, continuations: 0 });
    await expect(
      prisma.agentSkillOperationItem.findUniqueOrThrow({ where: { id: operation.items[0].id } }),
    ).resolves.toMatchObject({
      status: AgentOperationItemStatus.ACTIVATING,
      workerClaimToken: "terminal-worker-token",
    });
    expect(sendAgentSkillOperationRequested).not.toHaveBeenCalled();
  });

  it("serializes active-skill reservations at the shared account limit", async () => {
    const fixture = await createConnection("quota");
    await prisma.skill.createMany({
      data: Array.from({ length: ALPHA_ACTIVE_SKILLS - 1 }, (_, index) => ({
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
