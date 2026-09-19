import "server-only";

import type { AgentAuthContext } from "@/lib/agent-access/auth";
import { authorizeAgentRead, withAgentMutation } from "@/lib/agent-access/access";
import {
  agentGetIntroductionQueueSchema,
  agentUpdateIntroductionQueueSchema,
} from "@/lib/agent-access/practice-contracts";
import {
  AgentOperationError,
} from "@/lib/agent-access/operations";
import { buildAgentPayloadHash } from "@/lib/agent-access/contracts";
import {
  getIntroductionQueuePage,
  IntroductionQueueError,
  updateIntroductionQueue,
  type IntroductionQueuePage,
} from "@/lib/practice/introduction-queue";
import { getPrisma } from "@/lib/prisma";

export async function getAgentIntroductionQueue(
  auth: AgentAuthContext,
  rawInput: unknown,
): Promise<Record<string, unknown>> {
  const input = agentGetIntroductionQueueSchema.parse(rawInput);
  await authorizeAgentRead(auth, "practice:read");
  try {
    const page = await getPrisma().$transaction(
      async (tx) => {
        // Queue reads lazily materialize new skills. Serialize that sync with
        // presentation and queue writes so two readers cannot create the same
        // queue or race its version forward independently.
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${auth.userId} FOR NO KEY UPDATE`;
        return getIntroductionQueuePage(tx, {
          userId: auth.userId,
          collectionId: input.collection_id,
          cursor: input.cursor,
          limit: input.limit,
        });
      },
      { timeout: 15_000 },
    );
    return toPublicQueuePage(page);
  } catch (error) {
    throw mapQueueError(error);
  }
}

export async function updateAgentIntroductionQueue(
  auth: AgentAuthContext,
  rawInput: unknown,
): Promise<Record<string, unknown>> {
  const input = agentUpdateIntroductionQueueSchema.parse(rawInput);
  try {
    return await withAgentMutation(
      auth,
      "practice:write",
      async (tx) => {
        const payloadHash = buildAgentPayloadHash({
          collection_id: input.collection_id,
          expected_version: input.expected_version,
          skill_ids: input.skill_ids,
        });
        const existing = await tx.introductionQueueUpdate.findUnique({
          where: {
            connectionId_idempotencyKey: {
              connectionId: auth.connectionId,
              idempotencyKey: input.idempotency_key,
            },
          },
          select: { payloadHash: true, result: true },
        });
        if (existing) {
          if (existing.payloadHash !== payloadHash) {
            throw new AgentOperationError(
              "idempotency_conflict",
              "That idempotency key was already used with different input.",
            );
          }
          return { ...(existing.result as Record<string, unknown>), idempotent: true };
        }

        const page = await updateIntroductionQueue(tx, {
          userId: auth.userId,
          collectionId: input.collection_id,
          expectedVersion: input.expected_version,
          skillIds: input.skill_ids,
        });
        const result = { ...toPublicQueuePage(page), idempotent: false };
        await tx.introductionQueueUpdate.create({
          data: {
            userId: auth.userId,
            connectionId: auth.connectionId,
            queueId: page.queueId,
            idempotencyKey: input.idempotency_key,
            payloadHash,
            result,
          },
        });
        return result;
      },
      undefined,
      { retryUniqueConstraint: true },
    );
  } catch (error) {
    throw mapQueueError(error);
  }
}

function toPublicQueuePage(page: IntroductionQueuePage) {
  return {
    queue_id: page.queueId,
    collection_id: page.collectionId,
    scope_key: page.scopeKey,
    version: page.version,
    introduced_count: page.introducedCount,
    items: page.items.map((item) => ({
      entry_id: item.entryId,
      skill_id: item.skillId,
      position: item.position,
      title: item.title,
      status: item.status,
      reason: item.reason,
    })),
    next_cursor: page.nextCursor,
    skipped: page.skipped.map((item) => ({ skill_id: item.skillId, reason: item.reason })),
  };
}

function mapQueueError(error: unknown): AgentOperationError | unknown {
  if (!(error instanceof IntroductionQueueError)) return error;
  return new AgentOperationError(error.code, error.message);
}
