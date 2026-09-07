import "server-only";
import { isDeepStrictEqual } from "node:util";
import { AgentRateLimitKind, type Prisma } from "@/generated/prisma/client";
import type { AgentAccessScope, AgentAuthContext } from "./auth";
import { AgentOperationError, consumeRateLimit } from "./operations";
import {
  agentGetPracticeSettingsSchema,
  agentListPracticeTargetsSchema,
  agentUpdatePracticeSettingsSchema,
  type AgentPracticeTarget,
} from "./practice-contracts";
import { getPrisma } from "@/lib/prisma";
import {
  collectionPracticePreferencesSchema,
  skillPracticePreferencesSchema,
  userPracticePreferencesSchema,
  saveCollectionPracticePreferences,
  saveSkillPracticePreferences,
  saveUserPracticePreferences,
} from "@/lib/practice/preferences";
import {
  practicePreferenceOverrideSchema,
  resolvePracticePreference,
  resolveTextPolicy,
  textPolicySchema,
} from "@/lib/practice/policies";
import { queueRetentionPreparation } from "@/lib/skills/retention-preparation";

// Serialize with preference saves and account deletion, and hold the connection
// lock through the write so a revoke that wins the race prevents the mutation.
async function authorize(
  tx: Prisma.TransactionClient,
  auth: AgentAuthContext,
  scope: AgentAccessScope,
) {
  await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${auth.userId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "id" FROM "agent_connections" WHERE "id" = ${auth.connectionId} AND "userId" = ${auth.userId} FOR UPDATE`;
  const connection = await tx.agentConnection.findFirst({
    where: {
      id: auth.connectionId,
      userId: auth.userId,
      status: "ACTIVE",
      workosSubject: auth.subject,
      workosSessionId: auth.sessionId,
      clientId: auth.clientId,
      resourceUrl: auth.resourceUrl,
      scopes: { has: scope },
      user: { agentAccessDisabledAt: null },
    },
    select: { id: true },
  });
  const deleting = await tx.accountDeletionJob.findUnique({
    where: { userId: auth.userId },
    select: { id: true },
  });
  if (
    !connection ||
    deleting ||
    !auth.scopes.includes(scope) ||
    auth.expiresAt <= Date.now() / 1000
  ) {
    throw new AgentOperationError(
      "permission_denied",
      `An active connection with ${scope} permission is required.`,
    );
  }
  const write = scope === "practice:write";
  await consumeRateLimit(
    tx,
    auth,
    write ? AgentRateLimitKind.MUTATION : AgentRateLimitKind.READ,
    write ? 10 : 60,
  );
}

export async function listAgentPracticeTargets(
  auth: AgentAuthContext,
  rawInput: unknown,
): Promise<Record<string, unknown>> {
  const input = agentListPracticeTargetsSchema.parse(rawInput);
  return getPrisma().$transaction(async (tx) => {
    await authorize(tx, auth, "practice:read");
    const where = {
      userId: auth.userId,
      ...(input.after_id ? { id: { gt: input.after_id } } : {}),
    };
    const page =
      input.scope === "collection"
        ? await tx.collection.findMany({
            where: {
              ...where,
              ...(input.query
                ? { name: { contains: input.query, mode: "insensitive" } }
                : {}),
            },
            orderBy: { id: "asc" },
            take: input.limit + 1,
            select: { id: true, name: true },
          })
        : await tx.skill.findMany({
            where: {
              ...where,
              ...(input.query
                ? { title: { contains: input.query, mode: "insensitive" } }
                : {}),
            },
            orderBy: { id: "asc" },
            take: input.limit + 1,
            select: { id: true, title: true, status: true, collectionId: true },
          });
    const items = page.slice(0, input.limit);
    return {
      scope: input.scope,
      items,
      next_cursor: page.length > input.limit ? items.at(-1)!.id : null,
    };
  });
}

async function loadSettings(
  tx: Prisma.TransactionClient,
  userId: string,
  target: AgentPracticeTarget,
) {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: { practicePreference: true, mixedReview: true },
  });
  if (target.scope === "user")
    return { settings: user, user, collection: null };
  if (target.scope === "collection") {
    const collection = await tx.collection.findFirst({
      where: { id: target.id, userId },
      select: { practicePreference: true, textPolicy: true },
    });
    if (!collection) throw settingsNotFound();
    return { settings: collection, user, collection: null };
  }
  const skill = await tx.skill.findFirst({
    where: { id: target.id, userId },
    select: {
      practicePreference: true,
      textPolicy: true,
      alreadyStudied: true,
      collection: { select: { practicePreference: true, textPolicy: true } },
    },
  });
  if (!skill) throw settingsNotFound();
  const { collection, ...settings } = skill;
  return { settings, user, collection };
}
function settingsNotFound() {
  return new AgentOperationError(
    "settings_not_found",
    "These practice settings were not found.",
  );
}

function publicSettings(
  target: AgentPracticeTarget,
  stored: Awaited<ReturnType<typeof loadSettings>>,
) {
  const invalidFields: string[] = [];
  const settings = { ...stored.settings };
  if (
    "textPolicy" in settings &&
    settings.textPolicy !== null &&
    !textPolicySchema.safeParse(settings.textPolicy).success
  ) {
    settings.textPolicy = null;
    invalidFields.push("textPolicy");
  }
  const ownPreference = practicePreferenceOverrideSchema.safeParse(
    settings.practicePreference,
  );
  const inheritedPreference = practicePreferenceOverrideSchema.safeParse(
    stored.collection?.practicePreference ?? null,
  );
  const ownText =
    "textPolicy" in stored.settings ? stored.settings.textPolicy : null;
  let textPolicy = null;
  try {
    textPolicy = resolveTextPolicy({
      skill: ownText,
      collection: stored.collection?.textPolicy,
    });
  } catch {
    if (!invalidFields.includes("textPolicy"))
      invalidFields.push("inheritedTextPolicy");
  }
  return {
    target,
    settings,
    effective: {
      practicePreference: resolvePracticePreference({
        skill: ownPreference.success ? ownPreference.data : null,
        collection: inheritedPreference.success
          ? inheritedPreference.data
          : null,
        user: stored.user.practicePreference,
      }),
      mixedReview: stored.user.mixedReview,
      textPolicy,
    },
    invalid_fields: invalidFields,
  };
}

export async function getAgentPracticeSettings(
  auth: AgentAuthContext,
  rawInput: unknown,
): Promise<Record<string, unknown>> {
  const { target } = agentGetPracticeSettingsSchema.parse(rawInput);
  return getPrisma().$transaction(async (tx) => {
    await authorize(tx, auth, "practice:read");
    return publicSettings(target, await loadSettings(tx, auth.userId, target));
  });
}

export async function updateAgentPracticeSettings(
  auth: AgentAuthContext,
  rawInput: unknown,
): Promise<Record<string, unknown>> {
  const { target, changes } = agentUpdatePracticeSettingsSchema.parse(rawInput);
  const result = await getPrisma().$transaction(
    async (tx) => {
      await authorize(tx, auth, "practice:write");
      const stored = await loadSettings(tx, auth.userId, target);
      const schema =
        target.scope === "user"
          ? userPracticePreferencesSchema
          : target.scope === "collection"
            ? collectionPracticePreferencesSchema
            : skillPracticePreferencesSchema;
      // Merge under the user lock so disjoint concurrent patches cannot overwrite
      // one another. Never silently replace malformed stored policies with defaults.
      const parsed = schema.safeParse({ ...stored.settings, ...changes });
      if (!parsed.success)
        throw new AgentOperationError(
          "invalid_stored_settings",
          "Repair the invalid stored setting by supplying an explicit textPolicy or null.",
        );
      const data = parsed.data;
      const changed = !isDeepStrictEqual(data, stored.settings);
      let skillIds: string[] = [];
      let policyChanged = false;
      if (changed) {
        if (target.scope === "user")
          await saveUserPracticePreferences(auth.userId, data, tx);
        else {
          const common = { userId: auth.userId, input: data, now: new Date() };
          const saved =
            target.scope === "skill"
              ? await saveSkillPracticePreferences(
                  { ...common, skillId: target.id },
                  tx,
                )
              : await saveCollectionPracticePreferences(
                  { ...common, collectionId: target.id },
                  tx,
                );
          if (saved.status === "not-found") throw settingsNotFound();
          if (saved.status === "too-large")
            throw new AgentOperationError(
              "collection_too_large",
              "A text policy edit can affect at most 500 inheriting skills. Split this collection before changing its text policy.",
            );
          skillIds = saved.skillIds;
          policyChanged = saved.policyChanged;
        }
      }
      return {
        response: {
          status: "saved",
          changed,
          policy_changed: policyChanged,
          ...publicSettings(
            target,
            await loadSettings(tx, auth.userId, target),
          ),
        },
        skillIds,
      };
    },
    { timeout: 15_000 },
  );
  // Same bounded refill path as the UI. A delivery failure does not turn an
  // already-committed setting into an apparent failed save or leak provider data.
  let preparationDeferred = false;
  for (const skillId of result.skillIds) {
    try {
      await queueRetentionPreparation({
        userId: auth.userId,
        skillId,
        now: new Date(),
      });
    } catch {
      preparationDeferred = true;
    }
  }
  return { ...result.response, preparation_deferred: preparationDeferred };
}
