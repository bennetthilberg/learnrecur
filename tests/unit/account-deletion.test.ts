import { afterEach, describe, expect, it, vi } from "vitest";

const clerkMocks = vi.hoisted(() => ({
  clerkClient: vi.fn(),
  getSessionList: vi.fn(),
  revokeSession: vi.fn(),
  lockUser: vi.fn(),
  deleteUser: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  clerkClient: clerkMocks.clerkClient,
}));

vi.mock("@/lib/agent-access/settings", () => ({
  disableAgentAccessForAccountDeletion: vi.fn(),
  runAgentConnectionRevocationJob: vi.fn(),
}));

vi.mock("@/lib/inngest/client", () => ({
  getInngestEnvStatus: vi.fn(() => ({ status: "ready", appId: "test", isDev: true })),
}));

vi.mock("@/lib/inngest/events", () => ({
  inngestAccountDeletionEventSender: { sendAccountDeletionRequested: vi.fn() },
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: vi.fn(),
}));

vi.mock("@/lib/storage/s3", () => ({
  resolveS3SourceObjectStorage: vi.fn(),
}));

import {
  ACCOUNT_DELETION_CONFIRMATION,
  ACCOUNT_DELETION_MANIFEST_VERSION,
} from "@/lib/account-deletion/contracts";
import {
  AccountDeletionWorkflowError,
  buildAccountDeletionManifest,
  createDefaultClerkAccountDeletionClient,
  mergeAccountDeletionManifests,
  parseAccountDeletionManifest,
  recoverRetryableAccountDeletionJobs,
} from "@/lib/account-deletion";
import { getPrisma } from "@/lib/prisma";

afterEach(() => {
  clerkMocks.clerkClient.mockReset();
  clerkMocks.getSessionList.mockReset();
  clerkMocks.revokeSession.mockReset();
  clerkMocks.lockUser.mockReset();
  clerkMocks.deleteUser.mockReset();
  vi.mocked(getPrisma).mockReset();
});

describe("account deletion recovery", () => {
  it("atomically claims and redispatches retryable failed jobs", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "job-1", userId: "user-1", status: "FAILED" },
    ]);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    vi.mocked(getPrisma).mockReturnValue({
      accountDeletionJob: { findMany, updateMany },
    } as never);
    const eventSender = {
      sendAccountDeletionRequested: vi.fn().mockResolvedValue(undefined),
    };
    const now = new Date("2026-09-03T16:00:00.000Z");

    await expect(
      recoverRetryableAccountDeletionJobs({ now, eventSender }),
    ).resolves.toEqual({ claimed: 1, dispatched: 1, failed: 0 });
    expect(eventSender.sendAccountDeletionRequested).toHaveBeenCalledWith({
      userId: "user-1",
      deletionJobId: "job-1",
      requestedAt: now.toISOString(),
    });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: "job-1", status: "FAILED" }),
        data: {
          status: "PENDING",
          nextAttemptAt: new Date("2026-09-03T16:15:00.000Z"),
        },
      }),
    );
  });

  it("reclaims a running job after its worker lease expires", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: "job-running", userId: "user-1", status: "RUNNING" },
    ]);
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    vi.mocked(getPrisma).mockReturnValue({
      accountDeletionJob: { findMany, updateMany },
    } as never);
    const eventSender = {
      sendAccountDeletionRequested: vi.fn().mockResolvedValue(undefined),
    };
    const now = new Date("2026-09-03T16:00:00.000Z");

    await expect(recoverRetryableAccountDeletionJobs({ now, eventSender })).resolves.toEqual({
      claimed: 1,
      dispatched: 1,
      failed: 0,
    });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["PENDING", "RUNNING", "FAILED"] },
          nextAttemptAt: { lte: now },
        }),
      }),
    );
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "RUNNING", nextAttemptAt: { lte: now } }),
      }),
    );
  });

  it("returns a failed claim to the recovery queue when dispatch fails", async () => {
    const updateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    vi.mocked(getPrisma).mockReturnValue({
      accountDeletionJob: {
        findMany: vi.fn().mockResolvedValue([
          { id: "job-1", userId: "user-1", status: "FAILED" },
        ]),
        updateMany,
      },
    } as never);
    const now = new Date("2026-09-03T16:00:00.000Z");

    await expect(
      recoverRetryableAccountDeletionJobs({
        now,
        eventSender: {
          sendAccountDeletionRequested: vi.fn().mockRejectedValue(new Error("queue down")),
        },
      }),
    ).rejects.toMatchObject({ code: "RECOVERY_DISPATCH_FAILED", retryable: true });
    expect(updateMany).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          status: "FAILED",
          lastErrorCode: "RECOVERY_DISPATCH_FAILED",
          nextAttemptAt: new Date("2026-09-03T16:15:00.000Z"),
        }),
      }),
    );
  });
});

describe("account deletion manifest", () => {
  it("deduplicates and sorts private object references without storing material", () => {
    const manifest = buildAccountDeletionManifest({
      sourceFiles: [
        { bucket: "private-bucket", key: "z/source.pdf" },
        { bucket: "private-bucket", key: "a/source.pdf" },
        { bucket: "private-bucket", key: "z/source.pdf" },
        { bucket: null, key: null },
      ],
      materialRevisions: [
        { bucket: "private-bucket", key: "a/source.pdf" },
        { bucket: "private-bucket", key: "m/revision.pdf" },
      ],
      agentConnections: [
        {
          id: "connection-z",
          workosApplicationId: "application-z",
          workosIdentity: { workosUserId: "workos-z" },
        },
        {
          id: "connection-a",
          workosApplicationId: "application-a",
          workosIdentity: { workosUserId: "workos-a" },
        },
      ],
    });

    expect(manifest).toEqual({
      version: ACCOUNT_DELETION_MANIFEST_VERSION,
      storageObjects: [
        { bucket: "private-bucket", key: "a/source.pdf" },
        { bucket: "private-bucket", key: "m/revision.pdf" },
        { bucket: "private-bucket", key: "z/source.pdf" },
      ],
      agentConnections: [
        { connectionId: "connection-a" },
        { connectionId: "connection-z" },
      ],
    });
    expect(JSON.stringify(manifest)).not.toContain("private material");
    expect(JSON.stringify(manifest)).not.toContain("workos-");
    expect(JSON.stringify(manifest)).not.toContain("application-");
    expect(ACCOUNT_DELETION_CONFIRMATION).toBe("DELETE MY ACCOUNT");
  });

  it("validates a strict versioned manifest", () => {
    expect(() =>
      parseAccountDeletionManifest({
        version: 1,
        storageObjects: [],
        agentConnections: [],
        extractedText: "must not be accepted",
      }),
    ).toThrow();
  });

  it("appends newly discovered objects without moving the deletion cursor", () => {
    const original = {
      version: ACCOUNT_DELETION_MANIFEST_VERSION,
      storageObjects: [
        { bucket: "private-bucket", key: "m.pdf" },
        { bucket: "private-bucket", key: "z.pdf" },
      ],
      agentConnections: [{ connectionId: "connection-z" }],
    };

    expect(
      mergeAccountDeletionManifests(original, {
        version: ACCOUNT_DELETION_MANIFEST_VERSION,
        storageObjects: [
          { bucket: "private-bucket", key: "a.pdf" },
          { bucket: "private-bucket", key: "m.pdf" },
        ],
        agentConnections: [
          { connectionId: "connection-a" },
          { connectionId: "connection-z" },
        ],
      }),
    ).toEqual({
      version: ACCOUNT_DELETION_MANIFEST_VERSION,
      storageObjects: [
        { bucket: "private-bucket", key: "m.pdf" },
        { bucket: "private-bucket", key: "z.pdf" },
        { bucket: "private-bucket", key: "a.pdf" },
      ],
      agentConnections: [
        { connectionId: "connection-z" },
        { connectionId: "connection-a" },
      ],
    });
  });
});

describe("Clerk account deletion adapter", () => {
  it("lists every active session before revoking them", async () => {
    clerkMocks.getSessionList
      .mockResolvedValueOnce({ data: [{ id: "session-1" }, { id: "session-2" }], totalCount: 3 })
      .mockResolvedValueOnce({ data: [{ id: "session-3" }], totalCount: 3 })
      .mockResolvedValueOnce({ data: [], totalCount: 0 });
    clerkMocks.revokeSession.mockResolvedValue({});
    clerkMocks.lockUser.mockResolvedValue({});
    clerkMocks.deleteUser.mockResolvedValue({});
    clerkMocks.clerkClient.mockResolvedValue({
      sessions: {
        getSessionList: clerkMocks.getSessionList,
        revokeSession: clerkMocks.revokeSession,
      },
      users: { deleteUser: clerkMocks.deleteUser, lockUser: clerkMocks.lockUser },
    });

    await createDefaultClerkAccountDeletionClient().disableAccess("user-1");

    expect(clerkMocks.lockUser).toHaveBeenCalledWith("user-1");

    expect(clerkMocks.getSessionList).toHaveBeenNthCalledWith(1, {
      userId: "user-1",
      status: "active",
      limit: 500,
      offset: 0,
    });
    expect(clerkMocks.getSessionList).toHaveBeenNthCalledWith(2, {
      userId: "user-1",
      status: "active",
      limit: 500,
      offset: 2,
    });
    expect(clerkMocks.revokeSession).toHaveBeenCalledWith("session-1");
    expect(clerkMocks.revokeSession).toHaveBeenCalledWith("session-2");
    expect(clerkMocks.revokeSession).toHaveBeenCalledWith("session-3");
  });

  it("treats already-removed Clerk identities as idempotent", async () => {
    clerkMocks.deleteUser.mockRejectedValue({ status: 404 });
    clerkMocks.clerkClient.mockResolvedValue({
      sessions: {
        getSessionList: clerkMocks.getSessionList,
        revokeSession: clerkMocks.revokeSession,
      },
      users: { deleteUser: clerkMocks.deleteUser, lockUser: clerkMocks.lockUser },
    });

    await expect(
      createDefaultClerkAccountDeletionClient().deleteIdentity("user-1"),
    ).resolves.toBeUndefined();
  });

  it("fails closed when the Clerk identity cannot be locked", async () => {
    clerkMocks.lockUser.mockRejectedValue({ status: 503, detail: "private provider detail" });
    clerkMocks.clerkClient.mockResolvedValue({
      sessions: {
        getSessionList: clerkMocks.getSessionList,
        revokeSession: clerkMocks.revokeSession,
      },
      users: { deleteUser: clerkMocks.deleteUser, lockUser: clerkMocks.lockUser },
    });

    const error = await createDefaultClerkAccountDeletionClient()
      .disableAccess("user-1")
      .catch((value: unknown) => value);

    expect(error).toMatchObject({ code: "CLERK_IDENTITY_LOCK_FAILED", retryable: true });
    expect((error as Error).message).not.toContain("private provider detail");
    expect(clerkMocks.getSessionList).not.toHaveBeenCalled();
  });

  it("converts provider failures to safe retryable errors", async () => {
    clerkMocks.deleteUser.mockRejectedValue({ status: 503, secret: "should not escape" });
    clerkMocks.clerkClient.mockResolvedValue({
      sessions: {
        getSessionList: clerkMocks.getSessionList,
        revokeSession: clerkMocks.revokeSession,
      },
      users: { deleteUser: clerkMocks.deleteUser, lockUser: clerkMocks.lockUser },
    });

    const error = await createDefaultClerkAccountDeletionClient()
      .deleteIdentity("user-1")
      .catch((value: unknown) => value);

    expect(error).toBeInstanceOf(AccountDeletionWorkflowError);
    expect(error).toMatchObject({ code: "CLERK_IDENTITY_DELETE_FAILED", retryable: true });
    expect((error as Error).message).not.toContain("should not escape");
  });
});
