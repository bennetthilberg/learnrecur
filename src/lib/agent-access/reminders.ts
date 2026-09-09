import "server-only";

import type { AgentAuthContext } from "@/lib/agent-access/auth";
import { authorizeAgentRead, withAgentMutation } from "@/lib/agent-access/access";
import type { Prisma } from "@/generated/prisma/client";
import {
  agentReminderGetSchema,
  agentReminderUpdateSchema,
} from "@/lib/agent-access/contracts";
import { AgentOperationError } from "@/lib/agent-access/operations";
import {
  getDuePracticeSkillCount,
  getReminderSettings,
  saveReminderPreference,
} from "@/lib/reminders";

export async function getAgentReminders(
  auth: AgentAuthContext,
  rawInput: unknown,
) {
  agentReminderGetSchema.parse(rawInput);
  await authorizeAgentRead(auth, "reminders:read");
  const result = await getReminderSettings({ userId: auth.userId });
  if (result.status !== "ready") throw new AgentOperationError("settings_not_found", result.message);
  const dueCount = await getDuePracticeSkillCount({ userId: auth.userId, now: new Date() });
  return {
    status: "ready",
    persisted: result.persisted,
    preference: toPublicPreference(result.preference),
    due_skill_count: dueCount,
  };
}

export async function updateAgentReminders(
  auth: AgentAuthContext,
  rawInput: unknown,
  transaction?: Prisma.TransactionClient,
) {
  const input = agentReminderUpdateSchema.parse(rawInput);
  return withAgentMutation(auth, "reminders:write", async (tx) => {
    const current = await getReminderSettings({ userId: auth.userId, transaction: tx });
    if (current.status !== "ready") throw new AgentOperationError("settings_not_found", current.message);
    const existing = current.preference;
    const changes = input.changes;
    const result = await saveReminderPreference({
      userId: auth.userId,
      transaction: tx,
      input: {
        enabled: changes.enabled ?? existing.enabled,
        // The domain service canonicalizes this to the current account email.
        email: changes.email ?? existing.email,
        localHour: changes.local_hour ?? existing.localHour,
        timezone: changes.timezone ?? existing.timezone,
        minimumDueCount: changes.minimum_due_count ?? existing.minimumDueCount,
      },
    });
    if (result.status !== "saved") {
      throw new AgentOperationError("invalid_input", result.message);
    }
    const saved = await getReminderSettings({ userId: auth.userId, transaction: tx });
    return {
      status: "saved",
      preference: result.preference ? toPublicPreference(result.preference) : null,
      persisted: saved.status === "ready" ? saved.persisted : true,
      message: result.message,
    };
  }, transaction);
}

function toPublicPreference(preference: {
  enabled: boolean;
  email: string;
  localHour: number;
  timezone: string;
  minimumDueCount: number;
}) {
  return {
    enabled: preference.enabled,
    // Email is account-owned and safe to return to the same authenticated user.
    email: preference.email,
    local_hour: preference.localHour,
    timezone: preference.timezone,
    minimum_due_count: preference.minimumDueCount,
  };
}
