import "server-only";

import type { AgentAuthContext } from "@/lib/agent-access/auth";
import { authorizeAgentRead, withAgentMutation } from "@/lib/agent-access/access";
import {
  agentCustomSessionCreateSchema,
  agentCustomSessionGetSchema,
  agentCustomSessionMutationSchema,
} from "@/lib/agent-access/contracts";
import { AgentOperationError } from "@/lib/agent-access/operations";
import {
  createCustomPracticeSession,
  getCustomPracticeSession,
  resumeCustomPracticeSession,
  stopCustomPracticeSession,
} from "@/lib/practice/custom-session";

function publicSession(session: {
  id: string;
  mode: string;
  status: string;
  targetCount: number;
  completedCount: number;
  nextIndex: number;
  version: number;
  scope: unknown;
  plan: Array<{ ordinal: number; itemKey: string; skillId: string; exerciseId: string; status: string }>;
  startedAt: Date;
  stoppedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    session_id: session.id,
    mode: session.mode,
    status: session.status,
    target_count: session.targetCount,
    completed_count: session.completedCount,
    next_index: session.nextIndex,
    version: session.version,
    scope: session.scope,
    items: session.plan.map((item) => ({
      ordinal: item.ordinal,
      item_key: item.itemKey,
      skill_id: item.skillId,
      exercise_id: item.exerciseId,
      status: item.status,
    })),
    started_at: session.startedAt.toISOString(),
    stopped_at: session.stoppedAt?.toISOString() ?? null,
    completed_at: session.completedAt?.toISOString() ?? null,
    created_at: session.createdAt.toISOString(),
    updated_at: session.updatedAt.toISOString(),
    practice_uri: `learnrecur://practice-sessions/${session.id}`,
    practice_url: `/practice?session=${encodeURIComponent(session.id)}`,
  };
}

export async function createAgentCustomSession(auth: AgentAuthContext, rawInput: unknown) {
  const input = agentCustomSessionCreateSchema.parse(rawInput);
  const result = await withAgentMutation(auth, "practice:write", (transaction) =>
    createCustomPracticeSession({
      userId: auth.userId,
      mode: input.mode,
      targetCount: input.target_count,
      transaction,
      scope: {
        collectionIds: input.scope.collection_ids,
        tags: input.scope.tags,
        skillIds: input.scope.skill_ids,
        recentlyMissed: input.scope.recently_missed,
        mixedReview: input.scope.mixed_review,
      },
    }),
  );
  if (result.status === "unavailable") throw new AgentOperationError("invalid_input", result.message);
  return {
    status: result.status,
    message: "message" in result ? result.message : null,
    session: publicSession(result.session),
  };
}

export async function getAgentCustomSession(auth: AgentAuthContext, rawInput: unknown) {
  const input = agentCustomSessionGetSchema.parse(rawInput);
  await authorizeAgentRead(auth, "practice:read");
  const session = await getCustomPracticeSession(auth.userId, input.session_id);
  if (!session) throw new AgentOperationError("operation_not_found", "The practice session was not found.");
  return { status: "ready", session: publicSession(session) };
}

export async function stopAgentCustomSession(auth: AgentAuthContext, rawInput: unknown) {
  return mutateAgentCustomSession(auth, rawInput, stopCustomPracticeSession, "stopped");
}

export async function resumeAgentCustomSession(auth: AgentAuthContext, rawInput: unknown) {
  return mutateAgentCustomSession(auth, rawInput, resumeCustomPracticeSession, "active");
}

async function mutateAgentCustomSession(
  auth: AgentAuthContext,
  rawInput: unknown,
  mutation: typeof stopCustomPracticeSession,
  action: "stopped" | "active",
) {
  const input = agentCustomSessionMutationSchema.parse(rawInput);
  const result = await withAgentMutation(auth, "practice:write", (transaction) =>
    mutation({ userId: auth.userId, sessionId: input.session_id, transaction }),
  );
  if (result.status === "not-found") throw new AgentOperationError("operation_not_found", result.message);
  if (result.status === "conflict") throw new AgentOperationError("stale_state", result.message);
  return { status: action, session: publicSession(result.session) };
}
