import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/inngest/events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/inngest/events")>();
  return {
    ...actual,
    sendAgentConnectionRevocationRequested: vi.fn().mockResolvedValue(undefined),
  };
});

import {
  AccountDeletionJobStatus,
  AccountDeletionPhase,
  AgentConnectionStatus,
  AgentRemoteRevocationStatus,
  MaterialRevisionStatus,
  StudyMaterialKind,
} from "@/generated/prisma/client";
import {
  disableAgentAccessForAccountDeletion,
} from "@/lib/agent-access/settings";
import {
  ACCOUNT_DELETION_CONFIRMATION,
} from "@/lib/account-deletion/contracts";
import {
  buildAccountDeletionManifest,
  requestAccountDeletion,
  runAccountDeletionJob,
} from "@/lib/account-deletion";
import { getPrisma } from "@/lib/prisma";
import { prepareMaterialPdf } from "@/lib/materials/ingestion";
import { prepareSourceUpload } from "@/lib/skills/uploads";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `account_deletion_${randomUUID()}`;

describeDatabase("durable account deletion", () => {
  const prisma = getPrisma();
  const userIds: string[] = [];
  const jobIds: string[] = [];

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    await prisma.accountDeletionJob.deleteMany({ where: { id: { in: jobIds } } });
    await prisma.agentRevocationOutbox.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  async function createUser(label: string, input: { objects?: boolean; agent?: boolean } = {}) {
    const userId = `${runId}_${label}`;
    userIds.push(userId);
    await prisma.user.create({
      data: { id: userId, email: `${label}.${runId}@example.test` },
    });

    if (input.objects) {
      await prisma.sourceFile.createMany({
        data: [
          {
            userId,
            originalName: "source-a.pdf",
            storageBucket: "account-deletion-test-bucket",
            storageKey: `${runId}/${label}/a.pdf`,
          },
          {
            userId,
            originalName: "source-b.pdf",
            storageBucket: "account-deletion-test-bucket",
            storageKey: `${runId}/${label}/b.pdf`,
          },
        ],
      });
      const material = await prisma.studyMaterial.create({
        data: {
          userId,
          title: "Deletion fixture material",
          kind: StudyMaterialKind.PDF,
        },
      });
      await prisma.materialRevision.create({
        data: {
          userId,
          materialId: material.id,
          revisionNumber: 1,
          status: MaterialRevisionStatus.READY,
          storageBucket: "account-deletion-test-bucket",
          storageKey: `${runId}/${label}/revision.pdf`,
        },
      });
    }

    let connectionId: string | null = null;
    if (input.agent) {
      const identity = await prisma.workosIdentity.create({
        data: {
          userId,
          workosUserId: `${runId}_workos_${label}`,
          externalId: userId,
        },
      });
      const connection = await prisma.agentConnection.create({
        data: {
          userId,
          workosIdentityId: identity.id,
          workosSubject: identity.externalId,
          workosSessionId: `${runId}_session_${label}`,
          workosApplicationId: `${runId}_application_${label}`,
          clientId: `https://${label}.example.test/client.json`,
          clientName: `${label} fixture agent`,
          clientDomain: `${label}.example.test`,
          resourceUrl: "https://learnrecur.example.test/mcp",
          scopes: ["skills:create"],
        },
      });
      connectionId = connection.id;
    }

    return { userId, connectionId };
  }

  async function queueDeletion(userId: string, label: string) {
    const eventSender = {
      sendAccountDeletionRequested: vi.fn().mockResolvedValue(undefined),
    };
    const result = await requestAccountDeletion({
      userId,
      confirmation: ACCOUNT_DELETION_CONFIRMATION,
      now: new Date(`2026-09-03T${label === "success" ? "12" : "13"}:00:00.000Z`),
      eventSender,
    });
    expect(result.status).toBe("queued");
    if (result.status !== "queued") throw new Error("expected a queued deletion");
    jobIds.push(result.jobId);
    return { result, eventSender };
  }

  function safeClerk(deleteIdentity: () => Promise<void> = async () => undefined) {
    return {
      disableAccess: vi.fn().mockResolvedValue(undefined),
      deleteIdentity: vi.fn(deleteIdentity),
    };
  }

  function safeAgentDependencies() {
    return {
      agentAccessDisabler: vi.fn().mockResolvedValue(undefined),
      agentConnectionRevoker: vi.fn().mockResolvedValue({ status: "revoked" as const }),
      agentGrantRevoker: vi.fn().mockResolvedValue({ revoked: 0 }),
    };
  }

  it("creates one durable manifest and completes in the safe order", async () => {
    const fixture = await createUser("success", { objects: true, agent: true });
    const { result, eventSender } = await queueDeletion(fixture.userId, "success");
    const jobBefore = await prisma.accountDeletionJob.findUniqueOrThrow({
      where: { id: result.jobId },
    });
    expect(jobBefore).toMatchObject({
      status: AccountDeletionJobStatus.PENDING,
      phase: AccountDeletionPhase.DISABLE_ACCESS,
      objectCount: 3,
      agentConnectionCount: 1,
      deletedObjectCount: 0,
      revokedAgentConnectionCount: 0,
    });
    expect(jobBefore.manifest).toEqual(
      buildAccountDeletionManifest({
        sourceFiles: [
          { bucket: "account-deletion-test-bucket", key: `${runId}/success/a.pdf` },
          { bucket: "account-deletion-test-bucket", key: `${runId}/success/b.pdf` },
        ],
        materialRevisions: [
          { bucket: "account-deletion-test-bucket", key: `${runId}/success/revision.pdf` },
        ],
        agentConnections: [
          { id: fixture.connectionId! },
        ],
      }),
    );

    const duplicate = await requestAccountDeletion({
      userId: fixture.userId,
      confirmation: ACCOUNT_DELETION_CONFIRMATION,
      now: new Date("2026-09-03T12:01:00.000Z"),
      eventSender,
    });
    expect(duplicate).toMatchObject({ status: "queued", jobId: result.jobId, alreadyQueued: true });
    expect(eventSender.sendAccountDeletionRequested).toHaveBeenCalledTimes(2);

    const storage = {
      deleteObject: vi.fn().mockResolvedValue(undefined),
    };
    const clerk = safeClerk();
    const agent = safeAgentDependencies();
    const runResult = await runAccountDeletionJob({
      userId: fixture.userId,
      deletionJobId: result.jobId,
      now: new Date("2026-09-03T12:02:00.000Z"),
      storage,
      clerk,
      ...agent,
      agentAccessDisabler: vi.fn(async ({ userId, now }) => {
        await disableAgentAccessForAccountDeletion({ userId, now });
      }),
    });

    expect(runResult).toEqual({ status: "completed", jobId: result.jobId });
    expect(clerk.disableAccess).toHaveBeenCalledWith(fixture.userId);
    expect(clerk.deleteIdentity).toHaveBeenCalledWith(fixture.userId);
    expect(storage.deleteObject).toHaveBeenCalledTimes(3);
    expect(agent.agentConnectionRevoker).toHaveBeenCalledWith({
      userId: fixture.userId,
      connectionId: fixture.connectionId,
    });
    expect(agent.agentGrantRevoker).toHaveBeenCalledWith({ userId: fixture.userId });
    await expect(prisma.user.findUnique({ where: { id: fixture.userId } })).resolves.toBeNull();
    await expect(
      prisma.accountDeletionJob.findUniqueOrThrow({ where: { id: result.jobId } }),
    ).resolves.toMatchObject({
      status: AccountDeletionJobStatus.COMPLETE,
      phase: AccountDeletionPhase.COMPLETE,
      deletedObjectCount: 3,
      revokedAgentConnectionCount: 1,
      manifest: { version: 1, storageObjects: [], agentConnections: [] },
    });
    await expect(
      prisma.agentRevocationOutbox.findUnique({ where: { connectionId: fixture.connectionId! } }),
    ).resolves.toBeNull();
  });

  it("revokes remote grants even when no local agent connection was recorded", async () => {
    const fixture = await createUser("orphan-grant");
    await prisma.workosIdentity.create({
      data: {
        userId: fixture.userId,
        workosUserId: `${runId}_workos_orphan_grant`,
        externalId: fixture.userId,
      },
    });
    const { result } = await queueDeletion(fixture.userId, "orphan-grant");
    const agent = safeAgentDependencies();

    await expect(
      runAccountDeletionJob({
        userId: fixture.userId,
        deletionJobId: result.jobId,
        clerk: safeClerk(),
        ...agent,
      }),
    ).resolves.toEqual({ status: "completed", jobId: result.jobId });

    expect(agent.agentConnectionRevoker).not.toHaveBeenCalled();
    expect(agent.agentGrantRevoker).toHaveBeenCalledWith({ userId: fixture.userId });
  });

  it("keeps relational data retryable when remote grant cleanup fails", async () => {
    const fixture = await createUser("grant-retry", { agent: true });
    const { result } = await queueDeletion(fixture.userId, "grant-retry");
    const agent = safeAgentDependencies();
    agent.agentGrantRevoker
      .mockRejectedValueOnce(new Error("fixture WorkOS failure"))
      .mockResolvedValueOnce({ revoked: 1 });

    await expect(
      runAccountDeletionJob({
        userId: fixture.userId,
        deletionJobId: result.jobId,
        clerk: safeClerk(),
        ...agent,
      }),
    ).rejects.toMatchObject({ code: "AGENT_GRANT_REVOCATION_FAILED" });
    await expect(prisma.user.findUnique({ where: { id: fixture.userId } })).resolves.not.toBeNull();

    await expect(
      runAccountDeletionJob({
        userId: fixture.userId,
        deletionJobId: result.jobId,
        clerk: safeClerk(),
        ...agent,
      }),
    ).resolves.toEqual({ status: "completed", jobId: result.jobId });
    expect(agent.agentGrantRevoker).toHaveBeenCalledTimes(2);
  });

  it("discovers a late object without moving the durable cursor or orphaning storage", async () => {
    const fixture = await createUser("late-object", { objects: true });
    const { result } = await queueDeletion(fixture.userId, "late-object");
    const deletedKeys: string[] = [];
    let insertedLateObject = false;
    const lateKey = `${runId}/late-object/0-late.pdf`;
    const storage = {
      deleteObject: vi.fn(async ({ key }: { key: string }) => {
        deletedKeys.push(key);
        if (!insertedLateObject) {
          insertedLateObject = true;
          await prisma.sourceFile.create({
            data: {
              userId: fixture.userId,
              originalName: "late.pdf",
              storageBucket: "account-deletion-test-bucket",
              storageKey: lateKey,
            },
          });
        }
      }),
    };

    await expect(
      runAccountDeletionJob({
        userId: fixture.userId,
        deletionJobId: result.jobId,
        storage,
        clerk: safeClerk(),
        ...safeAgentDependencies(),
      }),
    ).resolves.toEqual({ status: "completed", jobId: result.jobId });

    expect(deletedKeys).toHaveLength(4);
    expect(deletedKeys.filter((key) => key === lateKey)).toHaveLength(1);
    expect(new Set(deletedKeys)).toHaveProperty("size", 4);
    await expect(prisma.user.findUnique({ where: { id: fixture.userId } })).resolves.toBeNull();
    await expect(
      prisma.accountDeletionJob.findUniqueOrThrow({ where: { id: result.jobId } }),
    ).resolves.toMatchObject({
      status: AccountDeletionJobStatus.COMPLETE,
      objectCount: 4,
      deletedObjectCount: 4,
      manifest: { version: 1, storageObjects: [], agentConnections: [] },
    });
  });

  it("waits for every issued upload URL to expire before deleting private objects", async () => {
    const fixture = await createUser("upload-lease", { objects: true });
    const leaseExpiresAt = new Date("2026-09-03T14:10:30.000Z");
    await prisma.sourceFile.updateMany({
      where: { userId: fixture.userId },
      data: { presignedUploadExpiresAt: leaseExpiresAt },
    });
    const { result } = await queueDeletion(fixture.userId, "upload-lease");
    const storage = { deleteObject: vi.fn().mockResolvedValue(undefined) };
    const clerk = safeClerk();
    const agent = safeAgentDependencies();

    await expect(
      runAccountDeletionJob({
        userId: fixture.userId,
        deletionJobId: result.jobId,
        now: new Date("2026-09-03T14:01:00.000Z"),
        storage,
        clerk,
        ...agent,
      }),
    ).rejects.toMatchObject({
      code: "PRESIGNED_UPLOAD_URL_ACTIVE",
      retryable: true,
      retryAt: leaseExpiresAt,
    });
    expect(storage.deleteObject).not.toHaveBeenCalled();
    await expect(
      prisma.accountDeletionJob.findUniqueOrThrow({ where: { id: result.jobId } }),
    ).resolves.toMatchObject({
      status: AccountDeletionJobStatus.FAILED,
      phase: AccountDeletionPhase.DISABLE_ACCESS,
      nextAttemptAt: leaseExpiresAt,
    });

    await expect(
      runAccountDeletionJob({
        userId: fixture.userId,
        deletionJobId: result.jobId,
        now: new Date("2026-09-03T14:10:31.000Z"),
        storage,
        clerk,
        ...agent,
      }),
    ).resolves.toEqual({ status: "completed", jobId: result.jobId });
    expect(storage.deleteObject).toHaveBeenCalledTimes(3);
  });

  it("refuses to issue new upload URLs after deletion is requested", async () => {
    const fixture = await createUser("blocked-upload");
    await queueDeletion(fixture.userId, "blocked-upload");
    const createPresignedUploadUrl = vi.fn().mockResolvedValue("https://uploads.example.test");
    const storage = {
      bucketName: "account-deletion-test-bucket",
      createPresignedUploadUrl,
    } as never;

    await expect(
      prepareSourceUpload({
        userId: fixture.userId,
        now: new Date("2026-09-03T14:00:00.000Z"),
        storage,
        input: {
          originalName: "notes.png",
          mimeType: "image/png",
          byteSize: "1024",
        },
      }),
    ).resolves.toMatchObject({ status: "not-prepared", reason: "account-deletion" });
    await expect(
      prepareMaterialPdf({
        userId: fixture.userId,
        now: new Date("2026-09-03T14:00:00.000Z"),
        storage,
        input: {
          title: "Blocked material",
          originalName: "notes.pdf",
          mimeType: "application/pdf",
          byteSize: "1024",
        },
      }),
    ).resolves.toMatchObject({ status: "not-prepared", message: expect.stringMatching(/deletion/) });
    expect(createPresignedUploadUrl).not.toHaveBeenCalled();
  });

  it("keeps a failed queue dispatch retryable without rebuilding the tombstone", async () => {
    const fixture = await createUser("queue-retry");
    const failedSender = {
      sendAccountDeletionRequested: vi.fn().mockRejectedValue(new Error("fixture queue failure")),
    };
    const failed = await requestAccountDeletion({
      userId: fixture.userId,
      confirmation: ACCOUNT_DELETION_CONFIRMATION,
      now: new Date("2026-09-03T12:20:00.000Z"),
      eventSender: failedSender,
    });
    expect(failed).toMatchObject({ status: "queue-unavailable" });

    const job = await prisma.accountDeletionJob.findUniqueOrThrow({
      where: { userId: fixture.userId },
    });
    jobIds.push(job.id);
    expect(job).toMatchObject({
      status: AccountDeletionJobStatus.FAILED,
      phase: AccountDeletionPhase.DISABLE_ACCESS,
      lastErrorCode: "QUEUE_DISPATCH_FAILED",
    });

    const retrySender = {
      sendAccountDeletionRequested: vi.fn().mockResolvedValue(undefined),
    };
    await expect(
      requestAccountDeletion({
        userId: fixture.userId,
        confirmation: ACCOUNT_DELETION_CONFIRMATION,
        now: new Date("2026-09-03T12:21:00.000Z"),
        eventSender: retrySender,
      }),
    ).resolves.toMatchObject({ status: "queued", jobId: job.id, alreadyQueued: true });
    expect(retrySender.sendAccountDeletionRequested).toHaveBeenCalledOnce();
  });

  it("resumes from the durable object cursor after a partial S3 failure", async () => {
    const fixture = await createUser("s3-retry", { objects: true });
    const { result } = await queueDeletion(fixture.userId, "s3-retry");
    let failOnce = true;
    const deletedKeys: string[] = [];
    const storage = {
      deleteObject: vi.fn(async ({ key }: { key: string }) => {
        if (key.endsWith("/b.pdf") && failOnce) {
          failOnce = false;
          throw new Error("fixture S3 failure");
        }
        deletedKeys.push(key);
      }),
    };
    const clerk = safeClerk();
    const agent = safeAgentDependencies();

    await expect(
      runAccountDeletionJob({
        userId: fixture.userId,
        deletionJobId: result.jobId,
        now: new Date("2026-09-03T13:01:00.000Z"),
        storage,
        clerk,
        ...agent,
      }),
    ).rejects.toMatchObject({ code: "S3_OBJECT_DELETE_FAILED" });
    await expect(
      prisma.accountDeletionJob.findUniqueOrThrow({ where: { id: result.jobId } }),
    ).resolves.toMatchObject({
      status: AccountDeletionJobStatus.FAILED,
      phase: AccountDeletionPhase.DELETE_OBJECTS,
      deletedObjectCount: 1,
      lastErrorMessage: "Deletion could not finish this step. Try again.",
    });
    await expect(prisma.user.findUnique({ where: { id: fixture.userId } })).resolves.not.toBeNull();

    await expect(
      runAccountDeletionJob({
        userId: fixture.userId,
        deletionJobId: result.jobId,
        now: new Date("2026-09-03T13:02:00.000Z"),
        storage,
        clerk,
        ...agent,
      }),
    ).resolves.toEqual({ status: "completed", jobId: result.jobId });
    expect(deletedKeys.filter((key) => key.endsWith("/a.pdf"))).toHaveLength(1);
    expect(deletedKeys.filter((key) => key.endsWith("/b.pdf"))).toHaveLength(1);
    expect(storage.deleteObject).toHaveBeenCalledTimes(4);
  });

  it("dead-letters persistent failures after bounded attempts and allows explicit requeue", async () => {
    const fixture = await createUser("dead-letter", { objects: true });
    const { result } = await queueDeletion(fixture.userId, "dead-letter");
    await prisma.accountDeletionJob.update({
      where: { id: result.jobId },
      data: { attemptCount: 7 },
    });

    await expect(
      runAccountDeletionJob({
        userId: fixture.userId,
        deletionJobId: result.jobId,
        now: new Date("2026-09-03T13:05:00.000Z"),
        storage: { deleteObject: vi.fn().mockRejectedValue(new Error("persistent S3 failure")) },
        clerk: safeClerk(),
        ...safeAgentDependencies(),
      }),
    ).rejects.toMatchObject({ code: "S3_OBJECT_DELETE_FAILED" });
    await expect(
      prisma.accountDeletionJob.findUniqueOrThrow({ where: { id: result.jobId } }),
    ).resolves.toMatchObject({
      status: AccountDeletionJobStatus.DEAD_LETTER,
      attemptCount: 8,
      nextAttemptAt: null,
    });

    await expect(
      runAccountDeletionJob({
        userId: fixture.userId,
        deletionJobId: result.jobId,
        storage: { deleteObject: vi.fn() },
        clerk: safeClerk(),
        ...safeAgentDependencies(),
      }),
    ).rejects.toMatchObject({
      code: "ACCOUNT_DELETION_DEAD_LETTERED",
      retryable: false,
    });
    await expect(
      prisma.accountDeletionJob.findUniqueOrThrow({ where: { id: result.jobId } }),
    ).resolves.toMatchObject({ attemptCount: 8 });

    const eventSender = { sendAccountDeletionRequested: vi.fn().mockResolvedValue(undefined) };
    await expect(
      requestAccountDeletion({
        userId: fixture.userId,
        confirmation: ACCOUNT_DELETION_CONFIRMATION,
        now: new Date("2026-09-03T13:06:00.000Z"),
        eventSender,
      }),
    ).resolves.toMatchObject({ status: "queued", jobId: result.jobId, alreadyQueued: true });
    await expect(
      prisma.accountDeletionJob.findUniqueOrThrow({ where: { id: result.jobId } }),
    ).resolves.toMatchObject({
      status: AccountDeletionJobStatus.PENDING,
      attemptCount: 0,
    });
    expect(eventSender.sendAccountDeletionRequested).toHaveBeenCalledOnce();
  });

  it("retains the manifest when Clerk identity deletion fails and retries last", async () => {
    const fixture = await createUser("clerk-retry");
    const { result } = await queueDeletion(fixture.userId, "clerk-retry");
    const manifest = (await prisma.accountDeletionJob.findUniqueOrThrow({
      where: { id: result.jobId },
      select: { manifest: true },
    })).manifest;
    let failOnce = true;
    const clerk = safeClerk(async () => {
      if (failOnce) {
        failOnce = false;
        throw new Error("fixture Clerk failure");
      }
    });
    const agent = safeAgentDependencies();

    await expect(
      runAccountDeletionJob({
        userId: fixture.userId,
        deletionJobId: result.jobId,
        now: new Date("2026-09-03T13:11:00.000Z"),
        clerk,
        ...agent,
      }),
    ).rejects.toMatchObject({ code: "CLERK_IDENTITY_DELETE_FAILED" });
    await expect(prisma.user.findUnique({ where: { id: fixture.userId } })).resolves.toBeNull();
    await expect(
      prisma.accountDeletionJob.findUniqueOrThrow({ where: { id: result.jobId } }),
    ).resolves.toMatchObject({
      status: AccountDeletionJobStatus.FAILED,
      phase: AccountDeletionPhase.DELETE_CLERK_IDENTITY,
      clerkAttemptCount: 1,
      manifest,
    });

    await expect(
      runAccountDeletionJob({
        userId: fixture.userId,
        deletionJobId: result.jobId,
        now: new Date("2026-09-03T13:12:00.000Z"),
        clerk,
        ...agent,
      }),
    ).resolves.toEqual({ status: "completed", jobId: result.jobId });
    expect(clerk.deleteIdentity).toHaveBeenCalledTimes(2);
    await expect(
      prisma.accountDeletionJob.findUniqueOrThrow({ where: { id: result.jobId } }),
    ).resolves.toMatchObject({
      status: AccountDeletionJobStatus.COMPLETE,
      phase: AccountDeletionPhase.COMPLETE,
      clerkAttemptCount: 2,
      manifest: { version: 1, storageObjects: [], agentConnections: [] },
    });

    await expect(
      runAccountDeletionJob({
        userId: fixture.userId,
        deletionJobId: result.jobId,
        clerk,
        ...agent,
      }),
    ).resolves.toEqual({ status: "already-complete", jobId: result.jobId });
    expect(clerk.deleteIdentity).toHaveBeenCalledTimes(2);
  });

  it("retries an agent revocation and accepts an already-revoked remote grant", async () => {
    const fixture = await createUser("agent-retry", { agent: true });
    const { result } = await queueDeletion(fixture.userId, "agent-retry");
    const clerk = safeClerk();
    const agentAccessDisabler = vi.fn().mockResolvedValue(undefined);
    const agentConnectionRevoker = vi
      .fn()
      .mockRejectedValueOnce(new Error("fixture remote failure"))
      .mockResolvedValueOnce({ status: "not-found" as const });
    const agentGrantRevoker = vi.fn().mockResolvedValue({ revoked: 0 });

    await expect(
      runAccountDeletionJob({
        userId: fixture.userId,
        deletionJobId: result.jobId,
        clerk,
        agentAccessDisabler,
        agentConnectionRevoker,
        agentGrantRevoker,
      }),
    ).rejects.toMatchObject({ code: "AGENT_REVOCATION_FAILED" });
    await expect(
      prisma.accountDeletionJob.findUniqueOrThrow({ where: { id: result.jobId } }),
    ).resolves.toMatchObject({
      status: AccountDeletionJobStatus.FAILED,
      phase: AccountDeletionPhase.DISABLE_ACCESS,
      revokedAgentConnectionCount: 0,
    });

    await expect(
      runAccountDeletionJob({
        userId: fixture.userId,
        deletionJobId: result.jobId,
        clerk,
        agentAccessDisabler,
        agentConnectionRevoker,
        agentGrantRevoker,
      }),
    ).resolves.toEqual({ status: "completed", jobId: result.jobId });
    expect(agentConnectionRevoker).toHaveBeenCalledTimes(2);
  });

  it("denies a cross-user worker invocation without touching the job", async () => {
    const owner = await createUser("owner");
    const other = await createUser("other");
    const { result } = await queueDeletion(owner.userId, "owner");
    const clerk = safeClerk();
    const agent = safeAgentDependencies();

    await expect(
      runAccountDeletionJob({
        userId: other.userId,
        deletionJobId: result.jobId,
        clerk,
        ...agent,
      }),
    ).resolves.toEqual({ status: "not-found" });
    expect(clerk.disableAccess).not.toHaveBeenCalled();
    expect(agent.agentAccessDisabler).not.toHaveBeenCalled();
    await expect(
      prisma.accountDeletionJob.findUniqueOrThrow({ where: { id: result.jobId } }),
    ).resolves.toMatchObject({ status: AccountDeletionJobStatus.PENDING });
    await expect(prisma.user.findUnique({ where: { id: owner.userId } })).resolves.not.toBeNull();
  });

  it("enforces the tombstone uniqueness, accounting checks, and indexes", async () => {
    const fixture = await createUser("constraints");
    const { result } = await queueDeletion(fixture.userId, "constraints");
    const manifest = { version: 1, storageObjects: [], agentConnections: [] };
    await expect(
      prisma.accountDeletionJob.create({
        data: {
          userId: fixture.userId,
          manifest,
          objectCount: 0,
        },
      }),
    ).rejects.toBeDefined();
    await expect(
      prisma.accountDeletionJob.count({ where: { userId: fixture.userId } }),
    ).resolves.toBe(1);
    await expect(
      prisma.accountDeletionJob.create({
        data: {
          userId: `${fixture.userId}-negative`,
          manifest,
          objectCount: -1,
        },
      }),
    ).rejects.toBeDefined();

    const indexes = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname::text AS indexname
      FROM pg_indexes
      WHERE tablename = 'account_deletion_jobs'
    `;
    expect(indexes.map((index) => index.indexname)).toEqual(
      expect.arrayContaining([
        "account_deletion_jobs_userId_key",
        "account_deletion_jobs_status_nextAttemptAt_idx",
        "account_deletion_jobs_phase_status_idx",
      ]),
    );
    const constraints = await prisma.$queryRaw<Array<{ conname: string }>>`
      SELECT conname::text AS conname
      FROM pg_constraint
      WHERE conrelid = 'account_deletion_jobs'::regclass
    `;
    expect(constraints.map((constraint) => constraint.conname)).toEqual(
      expect.arrayContaining([
        "account_deletion_jobs_manifest_version_check",
        "account_deletion_jobs_object_counts_check",
        "account_deletion_jobs_agent_counts_check",
        "account_deletion_jobs_attempt_counts_check",
      ]),
    );
    expect(result.jobId).toBeTruthy();
  });

  it("records locally revoked agent state before relational deletion", async () => {
    const fixture = await createUser("agent", { agent: true });
    const now = new Date("2026-09-03T14:00:00.000Z");
    await disableAgentAccessForAccountDeletion({ userId: fixture.userId, now });

    await expect(
      prisma.user.findUnique({ where: { id: fixture.userId }, select: { agentAccessDisabledAt: true } }),
    ).resolves.toMatchObject({ agentAccessDisabledAt: now });
    await expect(
      prisma.agentConnection.findUnique({ where: { id: fixture.connectionId! } }),
    ).resolves.toMatchObject({
      status: AgentConnectionStatus.REVOKED,
      remoteRevocationStatus: AgentRemoteRevocationStatus.PENDING,
      revokedAt: now,
    });
  });
});
