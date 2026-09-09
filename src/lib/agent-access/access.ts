import "server-only";

import { AgentConnectionStatus, AgentRateLimitKind, Prisma } from "@/generated/prisma/client";
import type { AgentAccessScope, AgentAuthContext } from "@/lib/agent-access/auth";
import { AgentOperationError, consumeAgentReadRateLimit, consumeRateLimit } from "@/lib/agent-access/operations";
import { runAgentSerializable } from "@/lib/agent-access/transactions";
import { getPrisma } from "@/lib/prisma";

/**
 * A second authorization check is intentional. The bearer token is short
 * lived, but a learner can revoke a connection while a request is in flight.
 * Mutations keep the account and connection locks until their write commits.
 */
export async function authorizeAgentRead(
  auth: AgentAuthContext,
  scope: AgentAccessScope,
) {
  if (!auth.scopes.includes(scope)) {
    throw new AgentOperationError("permission_denied", `Agent permission ${scope} is required.`);
  }
  if (auth.expiresAt <= Date.now() / 1_000) {
    throw new AgentOperationError("permission_denied", "The agent access token has expired.");
  }
  const prisma = getPrisma();
  const deleting = await prisma.accountDeletionJob.findUnique({
    where: { userId: auth.userId },
    select: { id: true },
  });
  const connection = deleting
    ? null
    : await prisma.agentConnection.findFirst({
        where: {
          id: auth.connectionId,
          userId: auth.userId,
          status: AgentConnectionStatus.ACTIVE,
          scopes: { has: scope },
          workosSubject: auth.subject,
          workosSessionId: auth.sessionId,
          clientId: auth.clientId,
          resourceUrl: auth.resourceUrl,
          user: { agentAccessDisabledAt: null },
        },
        select: { id: true, permissionVersion: true },
      });
  if (!connection || (auth.permissionVersion !== undefined && connection.permissionVersion !== auth.permissionVersion)) {
    throw new AgentOperationError("permission_denied", `An active connection with ${scope} permission is required.`);
  }
  await consumeAgentReadRateLimit(auth);
}

export async function withAgentMutation<T>(
  auth: AgentAuthContext,
  requiredScopes: AgentAccessScope | readonly AgentAccessScope[],
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  transaction?: Prisma.TransactionClient,
  options?: {
    retryUniqueConstraint?: boolean;
    /**
     * A trusted continuation can recheck the connection after an external
     * call without charging the same logical mutation twice. This must never
     * be derived from tool input; the continuation still runs every
     * authorization, lock, expiry, permission-version, and deletion check.
     */
    consumeMutationRate?: boolean;
  },
): Promise<T> {
  const scopes = Array.isArray(requiredScopes) ? [...requiredScopes] : [requiredScopes];
  if (scopes.some((scope) => !auth.scopes.includes(scope))) {
    throw new AgentOperationError(
      "permission_denied",
      `Agent permission ${scopes.find((scope) => !auth.scopes.includes(scope)) ?? scopes[0]} is required.`,
    );
  }

  const verify = async (tx: Prisma.TransactionClient, consumeMutationRate: boolean) => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${auth.userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "agent_connections" WHERE "id" = ${auth.connectionId} AND "userId" = ${auth.userId} FOR UPDATE`;
    const connection = await tx.agentConnection.findFirst({
      where: {
        id: auth.connectionId,
        userId: auth.userId,
        status: AgentConnectionStatus.ACTIVE,
        scopes: { hasEvery: scopes },
        workosSubject: auth.subject,
        workosSessionId: auth.sessionId,
        clientId: auth.clientId,
        resourceUrl: auth.resourceUrl,
        user: { agentAccessDisabledAt: null },
      },
      select: { id: true, permissionVersion: true },
    });
    const deleting = await tx.accountDeletionJob.findUnique({
      where: { userId: auth.userId },
      select: { id: true },
    });
    if (
      !connection ||
      deleting ||
      auth.expiresAt <= Date.now() / 1_000 ||
      (auth.permissionVersion !== undefined && connection.permissionVersion !== auth.permissionVersion)
    ) {
      throw new AgentOperationError(
        "permission_denied",
        `An active connection with ${scopes.join(" and ")} permission is required.`,
      );
    }
    if (consumeMutationRate) {
      await consumeRateLimit(tx, auth, AgentRateLimitKind.MUTATION, 10);
    }
  };

  if (transaction) {
    // An outer operation (such as setup.apply) owns the transaction and has
    // already paid the mutation rate charge. Revalidate the connection in the
    // same transaction before allowing this nested domain write.
    await verify(transaction, false);
    return work(transaction);
  }

  return runAgentSerializable(async (tx) => {
    await verify(tx, options?.consumeMutationRate ?? true);
    return work(tx);
  }, {
    timeout: 15_000,
    retryUniqueConstraint: options?.retryUniqueConstraint,
  });
}
