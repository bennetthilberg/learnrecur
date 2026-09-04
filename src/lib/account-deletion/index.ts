import "server-only";

import { clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";

import {
  AccountDeletionJobStatus,
  AccountDeletionPhase,
  AgentConnectionStatus,
  Prisma,
} from "@/generated/prisma/client";
import {
  disableAgentAccessForAccountDeletion,
  runAgentConnectionRevocationJob,
} from "@/lib/agent-access/settings";
import { getInngestEnvStatus } from "@/lib/inngest/client";
import {
  inngestAccountDeletionEventSender,
  type AccountDeletionEventSender,
} from "@/lib/inngest/events";
import { getPrisma } from "@/lib/prisma";
import {
  resolveS3SourceObjectStorage,
  type SourceObjectStorage,
} from "@/lib/storage/s3";

import {
  ACCOUNT_DELETION_CONFIRMATION,
  ACCOUNT_DELETION_MANIFEST_VERSION,
  type AccountDeletionManifest,
  type AccountDeletionStorageObject,
} from "./contracts";

const PUBLIC_FAILURE_MESSAGE = "Deletion could not finish this step. Try again.";
const MAX_CLERK_SESSION_REVOCATION_ROUNDS = 5;
const CLERK_SESSION_PAGE_SIZE = 500;
const MAX_DESTRUCTIVE_PASSES = 5;
const ACCOUNT_DELETION_RECOVERY_DELAY_MS = 15 * 60 * 1_000;
const ACCOUNT_DELETION_RECOVERY_BATCH_SIZE = 25;

// Keep this schema independent of the database row so a malformed or manually
// edited manifest fails closed before any provider or relational deletion.
const manifestSchema = z.strictObject({
  version: z.literal(ACCOUNT_DELETION_MANIFEST_VERSION),
  storageObjects: z.array(
    z.strictObject({
      bucket: z.string().nullable(),
      key: z.string().trim().min(1),
    }),
  ),
  agentConnections: z.array(
    z.strictObject({
      connectionId: z.string().trim().min(1),
    }),
  ),
}) satisfies z.ZodType<AccountDeletionManifest>;

export type AccountDeletionObjectStorage = Pick<SourceObjectStorage, "deleteObject">;

export type AccountDeletionClerkClient = {
  disableAccess(userId: string): Promise<void>;
  deleteIdentity(userId: string): Promise<void>;
};

export type AccountDeletionAgentAccessDisabler = (input: {
  userId: string;
  now: Date;
}) => Promise<unknown>;

export type AccountDeletionAgentConnectionRevoker = (input: {
  userId: string;
  connectionId: string;
}) => Promise<{ status: "revoked" | "not-found" }>;

export type AccountDeletionRequestResult =
  | {
      status: "queued";
      jobId: string;
      alreadyQueued: boolean;
      message: string;
    }
  | {
      status: "already-deleted";
      jobId: string;
      message: string;
    }
  | {
      status: "invalid-confirmation";
      message: string;
    }
  | {
      status: "not-found";
      message: string;
    }
  | {
      status: "queue-unavailable";
      message: string;
    };

export type AccountDeletionJobResult =
  | { status: "completed"; jobId: string }
  | { status: "already-complete"; jobId: string }
  | { status: "not-found" };

export class AccountDeletionWorkflowError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryAt: Date | null;

  constructor(code: string, retryable = true, retryAt: Date | null = null) {
    super(PUBLIC_FAILURE_MESSAGE);
    this.name = "AccountDeletionWorkflowError";
    this.code = code;
    this.retryable = retryable;
    this.retryAt = retryAt;
  }
}

type InventoryConnection = { id: string };

export function parseAccountDeletionManifest(input: unknown): AccountDeletionManifest {
  return manifestSchema.parse(input);
}

export function buildAccountDeletionManifest(input: {
  sourceFiles: Array<{ bucket: string | null; key: string | null }>;
  materialRevisions: Array<{ bucket: string | null; key: string | null }>;
  agentConnections: InventoryConnection[];
}): AccountDeletionManifest {
  const storageObjects = new Map<string, AccountDeletionStorageObject>();
  for (const object of [...input.sourceFiles, ...input.materialRevisions]) {
    if (!object.key) continue;
    const storageObject = { bucket: object.bucket, key: object.key };
    storageObjects.set(`${object.bucket ?? ""}\u0000${object.key}`, storageObject);
  }

  const agentConnections = input.agentConnections.map((connection) => ({
    connectionId: connection.id,
  }));

  return {
    version: ACCOUNT_DELETION_MANIFEST_VERSION,
    storageObjects: [...storageObjects.values()].sort(compareStorageObjects),
    agentConnections: agentConnections.sort((left, right) =>
      left.connectionId.localeCompare(right.connectionId),
    ),
  };
}

export async function requestAccountDeletion(input: {
  userId: string;
  confirmation: string;
  now: Date;
  eventSender?: AccountDeletionEventSender;
}): Promise<AccountDeletionRequestResult> {
  if (input.confirmation !== ACCOUNT_DELETION_CONFIRMATION) {
    return {
      status: "invalid-confirmation",
      message: `Type ${ACCOUNT_DELETION_CONFIRMATION} exactly to continue.`,
    };
  }

  const envStatus = getInngestEnvStatus();
  if (envStatus.status === "missing-env" && !input.eventSender) {
    return {
      status: "queue-unavailable",
      message: "Account deletion could not be queued. Try again.",
    };
  }

  const prisma = getPrisma();
  const persisted = await persistAccountDeletionRequest(prisma, input);

  if (persisted.status === "not-found") {
    return persisted;
  }

  if (persisted.status === "already-deleted") {
    return persisted;
  }

  try {
    await (input.eventSender ?? inngestAccountDeletionEventSender).sendAccountDeletionRequested({
      userId: input.userId,
      deletionJobId: persisted.jobId,
      requestedAt: input.now.toISOString(),
    });
  } catch {
    if (persisted.markDispatchFailure) {
      await prisma.accountDeletionJob.updateMany({
        where: { id: persisted.jobId, status: AccountDeletionJobStatus.PENDING },
        data: {
          status: AccountDeletionJobStatus.FAILED,
          lastErrorCode: "QUEUE_DISPATCH_FAILED",
          lastErrorMessage: PUBLIC_FAILURE_MESSAGE,
          nextAttemptAt: input.now,
        },
      });
    }
    return {
      status: "queue-unavailable",
      message: "Account deletion could not be queued. Try again.",
    };
  }

  return {
    status: "queued",
    jobId: persisted.jobId,
    alreadyQueued: persisted.alreadyQueued,
    message: persisted.alreadyQueued
      ? "Account deletion is already queued."
      : "Account deletion is queued. You will be signed out as access is disabled.",
  };
}

export async function getAccountDeletionStatus(
  userId: string,
): Promise<{
  status: "none" | AccountDeletionJobStatus;
  phase: AccountDeletionPhase | null;
  lastErrorCode: string | null;
}> {
  const job = await getPrisma().accountDeletionJob.findUnique({
    where: { userId },
    select: { status: true, phase: true, lastErrorCode: true },
  });

  if (!job) {
    return { status: "none", phase: null, lastErrorCode: null };
  }

  return job;
}

export async function recoverRetryableAccountDeletionJobs(input: {
  now: Date;
  eventSender?: AccountDeletionEventSender;
}): Promise<{ claimed: number; dispatched: number; failed: number }> {
  const prisma = getPrisma();
  const sender = input.eventSender ?? inngestAccountDeletionEventSender;
  const candidates = await prisma.accountDeletionJob.findMany({
    where: {
      status: {
        in: [
          AccountDeletionJobStatus.PENDING,
          AccountDeletionJobStatus.RUNNING,
          AccountDeletionJobStatus.FAILED,
        ],
      },
      nextAttemptAt: { lte: input.now },
    },
    orderBy: [{ nextAttemptAt: "asc" }, { createdAt: "asc" }],
    take: ACCOUNT_DELETION_RECOVERY_BATCH_SIZE,
    select: { id: true, userId: true, status: true },
  });
  let claimed = 0;
  let dispatched = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const claim = await prisma.accountDeletionJob.updateMany({
      where: {
        id: candidate.id,
        status: candidate.status,
        nextAttemptAt: { lte: input.now },
      },
      data: {
        status: AccountDeletionJobStatus.PENDING,
        nextAttemptAt: nextRecoveryAt(input.now),
      },
    });
    if (claim.count === 0) continue;
    claimed += 1;

    try {
      await sender.sendAccountDeletionRequested({
        userId: candidate.userId,
        deletionJobId: candidate.id,
        requestedAt: input.now.toISOString(),
      });
      dispatched += 1;
    } catch {
      failed += 1;
      await prisma.accountDeletionJob.updateMany({
        where: { id: candidate.id, status: AccountDeletionJobStatus.PENDING },
        data: {
          status: AccountDeletionJobStatus.FAILED,
          lastErrorCode: "RECOVERY_DISPATCH_FAILED",
          lastErrorMessage: PUBLIC_FAILURE_MESSAGE,
          nextAttemptAt: nextRecoveryAt(input.now),
        },
      });
    }
  }

  if (failed > 0) {
    throw new AccountDeletionWorkflowError("RECOVERY_DISPATCH_FAILED");
  }
  return { claimed, dispatched, failed };
}

export async function runAccountDeletionJob(input: {
  userId: string;
  deletionJobId: string;
  now?: Date;
  storage?: AccountDeletionObjectStorage;
  clerk?: AccountDeletionClerkClient;
  agentAccessDisabler?: AccountDeletionAgentAccessDisabler;
  agentConnectionRevoker?: AccountDeletionAgentConnectionRevoker;
}): Promise<AccountDeletionJobResult> {
  const prisma = getPrisma();
  const now = input.now ?? new Date();
  const job = await prisma.accountDeletionJob.findFirst({
    where: { id: input.deletionJobId, userId: input.userId },
    select: {
      id: true,
      userId: true,
      status: true,
      phase: true,
      manifestVersion: true,
      manifest: true,
      objectCount: true,
      deletedObjectCount: true,
      agentConnectionCount: true,
      revokedAgentConnectionCount: true,
    },
  });

  if (!job) return { status: "not-found" };
  if (job.status === AccountDeletionJobStatus.COMPLETE) {
    return { status: "already-complete", jobId: job.id };
  }

  try {
    if (job.manifestVersion !== ACCOUNT_DELETION_MANIFEST_VERSION) {
      throw new AccountDeletionWorkflowError("MANIFEST_VERSION_UNSUPPORTED", false);
    }

    let manifest = parseAccountDeletionManifest(job.manifest);
    validateManifestAccounting(job, manifest);

    await prisma.accountDeletionJob.update({
      where: { id: job.id },
      data: {
        status: AccountDeletionJobStatus.RUNNING,
        attemptCount: { increment: 1 },
        startedAt: now,
        lastErrorCode: null,
        lastErrorMessage: null,
        nextAttemptAt: nextRecoveryAt(now),
      },
    });

    let phase = job.phase;

    if (phase === AccountDeletionPhase.DISABLE_ACCESS) {
      await disableAccessAndRevokeAgents({
        input,
        prisma,
        now,
      });
      await assertNoActiveUploadLeases(prisma, input.userId, now);
      manifest = await refreshManifestBeforeDestructiveSteps({
        prisma,
        userId: input.userId,
        jobId: job.id,
        manifest,
      });
      await revokeAndForgetAgentConnections({
        prisma,
        userId: input.userId,
        manifest,
        revoker: input.agentConnectionRevoker,
      });
      await markPhaseReady(prisma, job.id, AccountDeletionPhase.DELETE_OBJECTS, {
        accessDisabledAt: now,
        agentConnectionCount: manifest.agentConnections.length,
        revokedAgentConnectionCount: manifest.agentConnections.length,
        manifest: manifest as Prisma.InputJsonValue,
        objectCount: manifest.storageObjects.length,
      });
      phase = AccountDeletionPhase.DELETE_OBJECTS;
    }

    let destructivePass = 0;
    while (
      phase === AccountDeletionPhase.DELETE_OBJECTS ||
      phase === AccountDeletionPhase.DELETE_RELATIONAL_DATA
    ) {
      destructivePass += 1;
      if (destructivePass > MAX_DESTRUCTIVE_PASSES) {
        throw new AccountDeletionWorkflowError("ACCOUNT_MUTATION_DURING_DELETION");
      }

      if (phase === AccountDeletionPhase.DELETE_OBJECTS) {
        await assertNoActiveUploadLeases(prisma, input.userId, now);
        manifest = await refreshManifestBeforeDestructiveSteps({
          prisma,
          userId: input.userId,
          jobId: job.id,
          manifest,
        });
        const refreshedJob = await prisma.accountDeletionJob.findUniqueOrThrow({
          where: { id: job.id },
          select: { deletedObjectCount: true, objectCount: true },
        });
        validateObjectAccounting(refreshedJob, manifest);
        await deleteManifestObjects({
          prisma,
          jobId: job.id,
          startAt: refreshedJob.deletedObjectCount,
          manifest,
          storage: input.storage,
        });
        await markPhaseReady(prisma, job.id, AccountDeletionPhase.DELETE_RELATIONAL_DATA, {
          objectsDeletedAt: now,
          deletedObjectCount: manifest.storageObjects.length,
          objectCount: manifest.storageObjects.length,
          manifest: manifest as Prisma.InputJsonValue,
        });
        phase = AccountDeletionPhase.DELETE_RELATIONAL_DATA;
      }

      const finalization = await finalizeRelationalDataOrDiscoverObjects({
        prisma,
        userId: input.userId,
        jobId: job.id,
        manifest,
      });
      if (finalization.status === "inventory-discovered") {
        manifest = finalization.manifest;
        await disableAccessAndRevokeAgents({ input, prisma, now });
        await revokeAndForgetAgentConnections({
          prisma,
          userId: input.userId,
          manifest,
          revoker: input.agentConnectionRevoker,
        });
        await markPhaseReady(prisma, job.id, AccountDeletionPhase.DELETE_OBJECTS, {
          manifest: manifest as Prisma.InputJsonValue,
          objectCount: manifest.storageObjects.length,
          agentConnectionCount: manifest.agentConnections.length,
          revokedAgentConnectionCount: manifest.agentConnections.length,
        });
        phase = AccountDeletionPhase.DELETE_OBJECTS;
        continue;
      }

      await markPhaseReady(prisma, job.id, AccountDeletionPhase.DELETE_CLERK_IDENTITY, {
        relationalDataDeletedAt: now,
      });
      phase = AccountDeletionPhase.DELETE_CLERK_IDENTITY;
    }

    if (phase === AccountDeletionPhase.DELETE_CLERK_IDENTITY) {
      await prisma.accountDeletionJob.update({
        where: { id: job.id },
        data: { clerkAttemptCount: { increment: 1 } },
      });
      try {
        await (input.clerk ?? createDefaultClerkAccountDeletionClient()).deleteIdentity(
          input.userId,
        );
      } catch {
        throw new AccountDeletionWorkflowError("CLERK_IDENTITY_DELETE_FAILED");
      }
      await prisma.accountDeletionJob.update({
        where: { id: job.id },
        data: {
          status: AccountDeletionJobStatus.COMPLETE,
          phase: AccountDeletionPhase.COMPLETE,
          clerkDeletedAt: now,
          completedAt: now,
          manifest: emptyAccountDeletionManifest() as Prisma.InputJsonValue,
          lastErrorCode: null,
          lastErrorMessage: null,
          nextAttemptAt: null,
        },
      });
      return { status: "completed", jobId: job.id };
    }

    throw new AccountDeletionWorkflowError("INVALID_PHASE", false);
  } catch (error) {
    const workflowError =
      error instanceof AccountDeletionWorkflowError
        ? error
        : new AccountDeletionWorkflowError("WORKFLOW_STEP_FAILED");
    await markAccountDeletionFailed(
      prisma,
      job.id,
      workflowError.code,
      now,
      workflowError.retryable,
      workflowError.retryAt,
    );
    throw workflowError;
  }
}

export function createDefaultClerkAccountDeletionClient(): AccountDeletionClerkClient {
  return {
    async disableAccess(userId) {
      const client = await clerkClient();

      try {
        await client.users.lockUser(userId);
      } catch (error) {
        if (isProviderNotFound(error)) return;
        throw new AccountDeletionWorkflowError("CLERK_IDENTITY_LOCK_FAILED");
      }

      for (let round = 0; round < MAX_CLERK_SESSION_REVOCATION_ROUNDS; round += 1) {
        const sessionIds: string[] = [];
        let offset = 0;

        try {
          while (true) {
            const page = await client.sessions.getSessionList({
              userId,
              status: "active",
              limit: CLERK_SESSION_PAGE_SIZE,
              offset,
            });
            sessionIds.push(...page.data.map((session) => session.id));
            offset += page.data.length;
            if (page.data.length === 0 || offset >= page.totalCount) break;
          }
        } catch (error) {
          if (isProviderNotFound(error)) return;
          throw new AccountDeletionWorkflowError("CLERK_SESSION_LIST_FAILED");
        }

        if (sessionIds.length === 0) return;

        for (const sessionId of sessionIds) {
          try {
            await client.sessions.revokeSession(sessionId);
          } catch (error) {
            if (!isProviderNotFound(error)) {
              throw new AccountDeletionWorkflowError("CLERK_SESSION_REVOCATION_FAILED");
            }
          }
        }
      }

      throw new AccountDeletionWorkflowError("CLERK_SESSIONS_REMAIN_ACTIVE");
    },
    async deleteIdentity(userId) {
      const client = await clerkClient();
      try {
        await client.users.deleteUser(userId);
      } catch (error) {
        if (!isProviderNotFound(error)) {
          throw new AccountDeletionWorkflowError("CLERK_IDENTITY_DELETE_FAILED");
        }
      }
    },
  };
}

async function persistAccountDeletionRequest(
  prisma: ReturnType<typeof getPrisma>,
  input: { userId: string; now: Date },
) {
  try {
    return await prisma.$transaction(async (tx) => {
      const existing = await tx.accountDeletionJob.findUnique({
        where: { userId: input.userId },
        select: { id: true, status: true },
      });

      if (existing) {
        if (existing.status === AccountDeletionJobStatus.COMPLETE) {
          return {
            status: "already-deleted" as const,
            jobId: existing.id,
            message: "This account has already been deleted.",
          };
        }

        const shouldRequeue = existing.status === AccountDeletionJobStatus.FAILED;
        if (shouldRequeue) {
          await tx.accountDeletionJob.update({
            where: { id: existing.id },
            data: {
              status: AccountDeletionJobStatus.PENDING,
              lastErrorCode: null,
              lastErrorMessage: null,
              nextAttemptAt: input.now,
            },
          });
        }

        return {
          status: "queued" as const,
          jobId: existing.id,
          alreadyQueued: true,
          markDispatchFailure: shouldRequeue,
        };
      }

      const user = await tx.user.findUnique({ where: { id: input.userId }, select: { id: true } });
      if (!user) {
        return {
          status: "not-found" as const,
          message: "Account deletion could not find the signed-in account.",
        };
      }

      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${input.userId} FOR UPDATE`;

      const [sourceFiles, materialRevisions, agentConnections] = await Promise.all([
        tx.sourceFile.findMany({
          where: { userId: input.userId },
          select: { storageBucket: true, storageKey: true },
        }),
        tx.materialRevision.findMany({
          where: { userId: input.userId },
          select: { storageBucket: true, storageKey: true },
        }),
        tx.agentConnection.findMany({
          where: { userId: input.userId },
          select: { id: true },
        }),
      ]);
      const manifest = buildAccountDeletionManifest({
        sourceFiles: sourceFiles.map(toStorageObjectRow),
        materialRevisions: materialRevisions.map(toStorageObjectRow),
        agentConnections,
      });

      const job = await tx.accountDeletionJob.create({
        data: {
          userId: input.userId,
          manifestVersion: ACCOUNT_DELETION_MANIFEST_VERSION,
          manifest: manifest as Prisma.InputJsonValue,
          objectCount: manifest.storageObjects.length,
          agentConnectionCount: manifest.agentConnections.length,
          nextAttemptAt: nextRecoveryAt(input.now),
        },
        select: { id: true },
      });

      return {
        status: "queued" as const,
        jobId: job.id,
        alreadyQueued: false,
        markDispatchFailure: true,
      };
    });
  } catch (error) {
    if (!isUniqueConflict(error)) throw error;

    const existing = await prisma.accountDeletionJob.findUnique({
      where: { userId: input.userId },
      select: { id: true, status: true },
    });
    if (!existing) throw error;
    if (existing.status === AccountDeletionJobStatus.COMPLETE) {
      return {
        status: "already-deleted" as const,
        jobId: existing.id,
        message: "This account has already been deleted.",
      };
    }
    return {
      status: "queued" as const,
      jobId: existing.id,
      alreadyQueued: true,
      markDispatchFailure: false,
    };
  }
}

async function disableAccessAndRevokeAgents(input: {
  input: {
    userId: string;
    clerk?: AccountDeletionClerkClient;
    agentAccessDisabler?: AccountDeletionAgentAccessDisabler;
    agentConnectionRevoker?: AccountDeletionAgentConnectionRevoker;
  };
  prisma: ReturnType<typeof getPrisma>;
  now: Date;
}) {
  const clerk = input.input.clerk ?? createDefaultClerkAccountDeletionClient();
  const disabler =
    input.input.agentAccessDisabler ?? disableAgentAccessForAccountDeletion;
  const [clerkResult, agentResult] = await Promise.allSettled([
    clerk.disableAccess(input.input.userId),
    disableAgentAccessLocally({
      prisma: input.prisma,
      userId: input.input.userId,
      now: input.now,
      disabler,
    }),
  ]);

  if (clerkResult.status === "rejected") {
    throw new AccountDeletionWorkflowError("CLERK_SESSION_REVOCATION_FAILED");
  }
  if (agentResult.status === "rejected") {
    throw new AccountDeletionWorkflowError("AGENT_ACCESS_DISABLE_FAILED");
  }
}

async function revokeManifestAgentConnections(input: {
  userId: string;
  manifest: AccountDeletionManifest;
  revoker?: AccountDeletionAgentConnectionRevoker;
}) {
  const revoker =
    input.revoker ??
    (runAgentConnectionRevocationJob as AccountDeletionAgentConnectionRevoker);
  for (const connection of input.manifest.agentConnections) {
    let result: { status: "revoked" | "not-found" };
    try {
      result = await revoker({
        userId: input.userId,
        connectionId: connection.connectionId,
      });
    } catch {
      throw new AccountDeletionWorkflowError("AGENT_REVOCATION_FAILED");
    }
    if (result.status !== "revoked" && result.status !== "not-found") {
      throw new AccountDeletionWorkflowError("AGENT_REVOCATION_FAILED");
    }
  }
}

async function revokeAndForgetAgentConnections(input: {
  prisma: ReturnType<typeof getPrisma>;
  userId: string;
  manifest: AccountDeletionManifest;
  revoker?: AccountDeletionAgentConnectionRevoker;
}) {
  await revokeManifestAgentConnections(input);
  await input.prisma.agentRevocationOutbox.deleteMany({
    where: {
      userId: input.userId,
      connectionId: {
        in: input.manifest.agentConnections.map(({ connectionId }) => connectionId),
      },
    },
  });
}

async function disableAgentAccessLocally(input: {
  prisma: ReturnType<typeof getPrisma>;
  userId: string;
  now: Date;
  disabler: AccountDeletionAgentAccessDisabler;
}) {
  try {
    await input.disabler({ userId: input.userId, now: input.now });
    return;
  } catch {
    // The existing agent helper commits the local fail-closed state before
    // dispatching remote work. A dispatch exception is safe to retry when
    // that local state is already durable and no active connection remains.
    const [user, activeConnectionCount] = await Promise.all([
      input.prisma.user.findUnique({
        where: { id: input.userId },
        select: { agentAccessDisabledAt: true },
      }),
      input.prisma.agentConnection.count({
        where: { userId: input.userId, status: AgentConnectionStatus.ACTIVE },
      }),
    ]);
    if (user && (!user.agentAccessDisabledAt || activeConnectionCount > 0)) {
      throw new AccountDeletionWorkflowError("AGENT_ACCESS_DISABLE_FAILED");
    }
  }
}

async function refreshManifestBeforeDestructiveSteps(input: {
  prisma: ReturnType<typeof getPrisma>;
  userId: string;
  jobId: string;
  manifest: AccountDeletionManifest;
}) {
  const user = await input.prisma.user.findUnique({
    where: { id: input.userId },
    select: { id: true },
  });
  if (!user) return input.manifest;

  const [sourceFiles, materialRevisions, agentConnections] = await Promise.all([
    input.prisma.sourceFile.findMany({
      where: { userId: input.userId },
      select: { storageBucket: true, storageKey: true },
    }),
    input.prisma.materialRevision.findMany({
      where: { userId: input.userId },
      select: { storageBucket: true, storageKey: true },
    }),
    input.prisma.agentConnection.findMany({
      where: { userId: input.userId },
      select: { id: true },
    }),
  ]);
  const current = buildAccountDeletionManifest({
    sourceFiles: sourceFiles.map(toStorageObjectRow),
    materialRevisions: materialRevisions.map(toStorageObjectRow),
    agentConnections,
  });
  const merged = mergeAccountDeletionManifests(input.manifest, current);
  await input.prisma.accountDeletionJob.update({
    where: { id: input.jobId },
    data: {
      manifest: merged as Prisma.InputJsonValue,
      objectCount: merged.storageObjects.length,
      agentConnectionCount: merged.agentConnections.length,
    },
  });
  return merged;
}

async function finalizeRelationalDataOrDiscoverObjects(input: {
  prisma: ReturnType<typeof getPrisma>;
  userId: string;
  jobId: string;
  manifest: AccountDeletionManifest;
}): Promise<
  | { status: "deleted" }
  | { status: "inventory-discovered"; manifest: AccountDeletionManifest }
> {
  return input.prisma.$transaction(async (tx) => {
    const lockedUsers = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "users" WHERE "id" = ${input.userId} FOR UPDATE
    `;
    if (lockedUsers.length === 0) return { status: "deleted" as const };

    const [sourceFiles, materialRevisions, agentConnections] = await Promise.all([
      tx.sourceFile.findMany({
        where: { userId: input.userId },
        select: { storageBucket: true, storageKey: true },
      }),
      tx.materialRevision.findMany({
        where: { userId: input.userId },
        select: { storageBucket: true, storageKey: true },
      }),
      tx.agentConnection.findMany({
        where: { userId: input.userId },
        select: { id: true },
      }),
    ]);
    const current = buildAccountDeletionManifest({
      sourceFiles: sourceFiles.map(toStorageObjectRow),
      materialRevisions: materialRevisions.map(toStorageObjectRow),
      agentConnections,
    });
    const merged = mergeAccountDeletionManifests(input.manifest, current);
    const inventoryChanged =
      merged.storageObjects.length !== input.manifest.storageObjects.length ||
      merged.agentConnections.length !== input.manifest.agentConnections.length;

    if (inventoryChanged) {
      await tx.accountDeletionJob.update({
        where: { id: input.jobId },
        data: {
          manifest: merged as Prisma.InputJsonValue,
          objectCount: merged.storageObjects.length,
          agentConnectionCount: merged.agentConnections.length,
        },
      });
      return { status: "inventory-discovered" as const, manifest: merged };
    }

    // Holding FOR UPDATE on the parent serializes this final inventory with
    // foreign-key inserts. Any writer that starts now will fail after deletion.
    await tx.user.delete({ where: { id: input.userId } });
    return { status: "deleted" as const };
  });
}

async function deleteManifestObjects(input: {
  prisma: ReturnType<typeof getPrisma>;
  jobId: string;
  startAt: number;
  manifest: AccountDeletionManifest;
  storage?: AccountDeletionObjectStorage;
}) {
  if (input.startAt >= input.manifest.storageObjects.length) return;

  const storageSetup = input.storage
    ? { status: "ready" as const, storage: input.storage }
    : resolveS3SourceObjectStorage();
  if (storageSetup.status === "missing-env") {
    throw new AccountDeletionWorkflowError("S3_CONFIGURATION_MISSING");
  }

  for (let index = input.startAt; index < input.manifest.storageObjects.length; index += 1) {
    const object = input.manifest.storageObjects[index];
    try {
      await storageSetup.storage.deleteObject({
        key: object.key,
        bucket: object.bucket ?? undefined,
      });
    } catch {
      throw new AccountDeletionWorkflowError("S3_OBJECT_DELETE_FAILED");
    }
    await input.prisma.accountDeletionJob.updateMany({
      where: {
        id: input.jobId,
        phase: AccountDeletionPhase.DELETE_OBJECTS,
        deletedObjectCount: index,
      },
      data: {
        deletedObjectCount: index + 1,
        nextAttemptAt: nextRecoveryAt(new Date()),
      },
    });
  }
}

async function markPhaseReady(
  prisma: ReturnType<typeof getPrisma>,
  jobId: string,
  phase: AccountDeletionPhase,
  data: {
    accessDisabledAt?: Date;
    objectsDeletedAt?: Date;
    relationalDataDeletedAt?: Date;
    manifest?: Prisma.InputJsonValue;
    objectCount?: number;
    deletedObjectCount?: number;
    agentConnectionCount?: number;
    revokedAgentConnectionCount?: number;
  },
) {
  await prisma.accountDeletionJob.update({
    where: { id: jobId },
    data: {
      ...data,
      status: AccountDeletionJobStatus.RUNNING,
      phase,
      lastErrorCode: null,
      lastErrorMessage: null,
      nextAttemptAt: nextRecoveryAt(new Date()),
    },
  });
}

async function markAccountDeletionFailed(
  prisma: ReturnType<typeof getPrisma>,
  jobId: string,
  code: string,
  now: Date,
  retryable: boolean,
  retryAt: Date | null = null,
) {
  await prisma.accountDeletionJob.updateMany({
    where: { id: jobId },
    data: {
      status: AccountDeletionJobStatus.FAILED,
      lastErrorCode: code,
      lastErrorMessage: PUBLIC_FAILURE_MESSAGE,
      nextAttemptAt: retryable ? retryAt ?? nextRecoveryAt(now) : null,
    },
  });
}

async function assertNoActiveUploadLeases(
  prisma: ReturnType<typeof getPrisma>,
  userId: string,
  now: Date,
): Promise<void> {
  const activeLease = await prisma.sourceFile.findFirst({
    where: {
      userId,
      presignedUploadExpiresAt: { gt: now },
    },
    orderBy: { presignedUploadExpiresAt: "desc" },
    select: { presignedUploadExpiresAt: true },
  });
  if (activeLease?.presignedUploadExpiresAt) {
    throw new AccountDeletionWorkflowError(
      "PRESIGNED_UPLOAD_URL_ACTIVE",
      true,
      activeLease.presignedUploadExpiresAt,
    );
  }
}

function nextRecoveryAt(now: Date): Date {
  return new Date(now.getTime() + ACCOUNT_DELETION_RECOVERY_DELAY_MS);
}

function validateManifestAccounting(
  job: {
    objectCount: number;
    deletedObjectCount: number;
    agentConnectionCount: number;
    revokedAgentConnectionCount: number;
  },
  manifest: AccountDeletionManifest,
) {
  if (
    job.objectCount !== manifest.storageObjects.length ||
    job.agentConnectionCount !== manifest.agentConnections.length ||
    job.deletedObjectCount < 0 ||
    job.deletedObjectCount > manifest.storageObjects.length ||
    job.revokedAgentConnectionCount < 0 ||
    job.revokedAgentConnectionCount > manifest.agentConnections.length
  ) {
    throw new AccountDeletionWorkflowError("MANIFEST_ACCOUNTING_INVALID", false);
  }
}

function validateObjectAccounting(
  job: { objectCount: number; deletedObjectCount: number },
  manifest: AccountDeletionManifest,
) {
  if (
    job.objectCount !== manifest.storageObjects.length ||
    job.deletedObjectCount < 0 ||
    job.deletedObjectCount > manifest.storageObjects.length
  ) {
    throw new AccountDeletionWorkflowError("MANIFEST_ACCOUNTING_INVALID", false);
  }
}

export function mergeAccountDeletionManifests(
  original: AccountDeletionManifest,
  current: AccountDeletionManifest,
): AccountDeletionManifest {
  const originalObjectKeys = new Set(
    original.storageObjects.map((object) => `${object.bucket ?? ""}\u0000${object.key}`),
  );
  const newObjects = current.storageObjects.filter(
    (object) => !originalObjectKeys.has(`${object.bucket ?? ""}\u0000${object.key}`),
  );
  const originalConnectionIds = new Set(
    original.agentConnections.map((connection) => connection.connectionId),
  );
  const newConnections = current.agentConnections.filter(
    (connection) => !originalConnectionIds.has(connection.connectionId),
  );
  return {
    version: ACCOUNT_DELETION_MANIFEST_VERSION,
    // Existing entries are immutable because deletedObjectCount is a durable
    // cursor into this array. Newly discovered entries are appended.
    storageObjects: [...original.storageObjects, ...newObjects.sort(compareStorageObjects)],
    agentConnections: [
      ...original.agentConnections,
      ...newConnections.sort((left, right) => left.connectionId.localeCompare(right.connectionId)),
    ],
  };
}

function emptyAccountDeletionManifest(): AccountDeletionManifest {
  return {
    version: ACCOUNT_DELETION_MANIFEST_VERSION,
    storageObjects: [],
    agentConnections: [],
  };
}

function toStorageObjectRow(object: { storageBucket: string | null; storageKey: string | null }) {
  return { bucket: object.storageBucket, key: object.storageKey };
}

function compareStorageObjects(
  left: AccountDeletionStorageObject,
  right: AccountDeletionStorageObject,
) {
  const leftValue = `${left.bucket ?? ""}\u0000${left.key}`;
  const rightValue = `${right.bucket ?? ""}\u0000${right.key}`;
  return leftValue.localeCompare(rightValue);
}

function isUniqueConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isProviderNotFound(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const response = isRecord(error.response) ? error.response : null;
  return [error.status, error.statusCode, response?.status].some((value) => value === 404);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
