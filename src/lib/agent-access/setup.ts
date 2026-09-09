import "server-only";

import { randomUUID } from "node:crypto";

import {
  AgentSetupPlanStatus,
  MaterialRevisionStatus,
  Prisma,
} from "@/generated/prisma/client";
import { authorizeAgentRead, withAgentMutation } from "@/lib/agent-access/access";
import type { AgentAccessScope, AgentAuthContext } from "@/lib/agent-access/auth";
import {
  agentSetupApplySchema,
  agentSetupGetSchema,
  agentSetupPreviewSchema,
  buildAgentPayloadHash,
} from "@/lib/agent-access/contracts";
import { AgentOperationError } from "@/lib/agent-access/operations";
import {
  createAgentCollection,
  batchUpdateAgentSkills,
} from "@/lib/agent-access/library";
import {
  createAgentMaterialOperation,
  createAgentSpecOperation,
  createAgentTextOperation,
} from "@/lib/agent-access/operations";
import { updateAgentPracticeSettings } from "@/lib/agent-access/practice";
import { updateAgentReminders } from "@/lib/agent-access/reminders";
import {
  isAgentSerializationConflict,
} from "@/lib/agent-access/transactions";
import { getPrisma } from "@/lib/prisma";
import { normalizeReminderPreferenceInput } from "@/lib/reminders";

export {
  isAgentSerializationConflict as isSerializationConflict,
} from "@/lib/agent-access/transactions";

const SETUP_LEASE_MS = 10 * 60 * 1_000;
const CLAIM_SERIALIZATION_RETRIES = 1;
const CLAIM_RETRY_DELAY_MS = 10;

type SetupInput = ReturnType<typeof agentSetupPreviewSchema.parse>;
type SetupResult = Record<string, unknown>;

const PLAN_SELECT = {
  id: true,
  userId: true,
  connectionId: true,
  idempotencyKey: true,
  payloadHash: true,
  permissionVersion: true,
  requestedSpec: true,
  snapshot: true,
  status: true,
  result: true,
  errors: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AgentSetupPlanSelect;

type PlanRecord = Prisma.AgentSetupPlanGetPayload<{ select: typeof PLAN_SELECT }>;

type SetupActionRecord = Record<string, unknown>;

type SetupProgress = {
  version: 1;
  lease_token?: string;
  lease_expires_at?: string;
  actions: SetupActionRecord[];
  pending_count?: number;
  failed_count?: number;
  retryable?: boolean;
};

const PUBLIC_SETUP_UNEXPECTED_ERROR = "The setup action could not be completed.";
const PUBLIC_AGENT_OPERATION_ERROR_CODES: ReadonlySet<string> = new Set([
  "idempotency_conflict",
  "permission_denied",
  "settings_not_found",
  "invalid_stored_settings",
  "collection_too_large",
  "rate_limited",
  "too_many_pending_items",
  "material_not_found",
  "stale_material_revision",
  "operation_not_found",
  "operation_not_ready",
  "operation_not_retryable",
  "upload_preparation_failed",
  "invalid_input",
  "skill_not_found",
  "skill_not_active",
  "collection_not_found",
  "stale_state",
  "meaning_change_requires_reset",
  "setup_not_found",
  "setup_stale",
  "setup_in_progress",
  "setup_failed",
]);
const PUBLIC_SETUP_ERROR_CODES: ReadonlySet<string> = new Set([
  ...PUBLIC_AGENT_OPERATION_ERROR_CODES,
  "partial_failure",
]);

class SetupLeaseLostError extends Error {
  constructor() {
    super("The setup plan lease was replaced by another apply attempt.");
    this.name = "SetupLeaseLostError";
  }
}

const SETUP_TERMINAL_OPERATION_STATUSES = new Set([
  "SUCCEEDED",
  "PARTIAL",
  "FAILED",
  "CANCELED",
]);

export function normalizeSetupOperationStatus(status: unknown) {
  const normalized = String(status ?? "").trim().toUpperCase();
  const terminal = SETUP_TERMINAL_OPERATION_STATUSES.has(normalized);
  return {
    raw: normalized,
    public: normalized ? normalized.toLocaleLowerCase("en-US") : "pending",
    terminal,
    successful: normalized === "SUCCEEDED",
    failed: terminal && normalized !== "SUCCEEDED",
  };
}

function setupProgress(value: Prisma.JsonValue | null): SetupProgress {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { version: 1, actions: [] };
  }
  const record = value as Record<string, unknown>;
  const actions = Array.isArray(record.actions)
    ? record.actions.filter(
        (action): action is SetupActionRecord =>
          Boolean(action) && typeof action === "object" && !Array.isArray(action),
      )
    : [];
  return {
    version: 1,
    ...(typeof record.lease_token === "string"
      ? { lease_token: record.lease_token }
      : {}),
    ...(typeof record.lease_expires_at === "string"
      ? { lease_expires_at: record.lease_expires_at }
      : {}),
    actions,
    ...(typeof record.pending_count === "number"
      ? { pending_count: record.pending_count }
      : {}),
    ...(typeof record.failed_count === "number"
      ? { failed_count: record.failed_count }
      : {}),
    ...(typeof record.retryable === "boolean"
      ? { retryable: record.retryable }
      : {}),
  };
}

function publicSetupProgress(value: Prisma.JsonValue | null) {
  const progress = setupProgress(value);
  const publicValue = { ...progress };
  delete publicValue.lease_token;
  delete publicValue.lease_expires_at;
  publicValue.actions = progress.actions.map(publicSetupAction);
  return publicValue;
}

function publicSetupAction(action: SetupActionRecord) {
  const publicAction = { ...action };
  if ("error" in publicAction) {
    publicAction.error = publicStoredSetupError(
      publicAction.error,
      PUBLIC_AGENT_OPERATION_ERROR_CODES,
    );
  }
  if (
    (typeof publicAction.error_code === "string" &&
      !PUBLIC_AGENT_OPERATION_ERROR_CODES.has(publicAction.error_code)) ||
    (typeof publicAction.error_message === "string" &&
      typeof publicAction.error_code !== "string")
  ) {
    publicAction.error_code = "internal_error";
    publicAction.error_message = PUBLIC_SETUP_UNEXPECTED_ERROR;
  }
  return publicAction;
}

function publicStoredSetupError(
  value: unknown,
  allowedCodes: ReadonlySet<string> = PUBLIC_AGENT_OPERATION_ERROR_CODES,
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { code: "internal_error", message: PUBLIC_SETUP_UNEXPECTED_ERROR };
  }
  const record = value as Record<string, unknown>;
  const code = typeof record.code === "string" ? record.code : null;
  if (!code || !allowedCodes.has(code)) {
    return { code: "internal_error", message: PUBLIC_SETUP_UNEXPECTED_ERROR };
  }
  return {
    code,
    message:
      typeof record.message === "string"
        ? record.message
        : PUBLIC_SETUP_UNEXPECTED_ERROR,
  };
}

function publicSetupErrors(value: Prisma.JsonValue | null) {
  if (value === null) return null;
  const sanitized = publicStoredSetupError(value, PUBLIC_SETUP_ERROR_CODES);
  if (!value || typeof value !== "object" || Array.isArray(value)) return sanitized;
  const record = value as Record<string, unknown>;
  return {
    ...sanitized,
    ...(typeof record.expected_snapshot_hash === "string"
      ? { expected_snapshot_hash: record.expected_snapshot_hash }
      : {}),
    ...(typeof record.current_snapshot_hash === "string"
      ? { current_snapshot_hash: record.current_snapshot_hash }
      : {}),
  };
}

function leaseIsExpired(progress: SetupProgress, now = Date.now()) {
  if (!progress.lease_expires_at) return true;
  const expiresAt = Date.parse(progress.lease_expires_at);
  return !Number.isFinite(expiresAt) || expiresAt <= now;
}

function actionStatusIsSuccessful(action: SetupActionRecord) {
  return ["ready", "saved", "created", "succeeded", "updated"].includes(
    String(action.status),
  );
}

function actionStatusIsFailed(action: SetupActionRecord) {
  return ["failed", "partial", "canceled", "stale"].includes(
    String(action.status),
  );
}

function actionKey(action: SetupActionRecord) {
  if (typeof action.step_key === "string") return action.step_key;
  if (action.kind === "practice" || action.kind === "reminders") return action.kind;
  if (typeof action.client_reference === "string") {
    return `${String(action.kind)}:${action.client_reference}`;
  }
  if (typeof action.skill_id === "string") return `${String(action.kind)}:${action.skill_id}`;
  if (typeof action.collection_id === "string") return `${String(action.kind)}:${action.collection_id}`;
  return null;
}

function progressActions(plan: PlanRecord) {
  const result = new Map<string, SetupActionRecord>();
  for (const action of setupProgress(plan.result).actions) {
    const key = actionKey(action);
    if (key) result.set(key, action);
  }
  return result;
}

export function requiredSetupScopes(input: SetupInput): AgentAccessScope[] {
  const scopes = new Set<AgentAccessScope>(["setup:write"]);
  for (const collection of input.collections) {
    scopes.add(collection.kind === "create" ? "collections:write" : "collections:read");
  }
  for (const skill of input.skills) {
    if (skill.kind === "reuse") {
      scopes.add(
        skill.collection_id !== undefined ||
          "collection_reference" in skill && skill.collection_reference !== undefined ||
          skill.tags !== undefined
          ? "skills:write"
          : "skills:read",
      );
      continue;
    }
    scopes.add("skills:create");
    if (skill.kind === "create_material") {
      scopes.add("materials:read");
      if (skill.collection !== undefined) scopes.add("collections:read");
    }
    if (collectionReferenceForSkill(skill) || skill.kind === "create_material" && skill.collection !== undefined) {
      scopes.add("skills:write");
    }
  }
  if (input.practice) scopes.add("practice:write");
  if (input.reminders) scopes.add("reminders:write");
  return [...scopes];
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function stableHash(value: unknown) {
  // Postgres jsonb may reorder object keys when it persists a snapshot. Use
  // the same canonical representation as the agent idempotency contract so
  // an unchanged preview survives a read/compare round trip.
  return buildAgentPayloadHash(value);
}

function planSummary(input: SetupInput) {
  return {
    collection_count: input.collections.length,
    skill_count: input.skills.length,
    created_skill_count: input.skills.filter((skill) => skill.kind !== "reuse").length,
    reused_skill_count: input.skills.filter((skill) => skill.kind === "reuse").length,
    includes_practice_settings: input.practice !== undefined,
    includes_reminders: input.reminders !== undefined,
    client_references: input.skills.flatMap((skill) =>
      "client_reference" in skill ? [skill.client_reference] : [],
    ),
  };
}

function plannedPlacement(skill: SetupInput["skills"][number]) {
  if (skill.kind === "reuse") {
    if (skill.collection_id !== undefined) return { collection_id: skill.collection_id };
    const collectionReference = collectionReferenceForSkill(skill);
    return collectionReference ? { collection_reference: collectionReference } : null;
  }
  if (skill.kind === "create_specs" && skill.skill.collection !== undefined) {
    return { collection: skill.skill.collection };
  }
  if (skill.kind !== "create_specs" && skill.collection !== undefined) {
    return { collection: skill.collection };
  }
  const collectionReference = collectionReferenceForSkill(skill);
  return collectionReference ? { collection_reference: collectionReference } : null;
}

/**
 * Project only the user-reviewable effect of a setup request. Keep source
 * material and candidate answer data out of plan reads; the saved request is
 * still retained privately for the apply path.
 */
export function projectSetupPlannedChanges(input: SetupInput) {
  return {
    practice: input.practice ? { ...input.practice } : null,
    reminders: input.reminders ? { ...input.reminders } : null,
    collections: input.collections.map((collection) =>
      collection.kind === "reuse"
        ? { action: "reuse" as const, collection_id: collection.collection_id }
        : {
            action: "create" as const,
            client_reference: collection.client_reference,
            name: collection.name,
            ...(collection.description !== undefined
              ? { description: collection.description }
              : {}),
          },
    ),
    skills: input.skills.map((skill) => {
      if (skill.kind === "reuse") {
        return {
          action: "reuse" as const,
          skill_id: skill.skill_id,
          move: plannedPlacement(skill),
          ...(skill.tags !== undefined ? { tags: [...skill.tags] } : {}),
        };
      }
      if (skill.kind === "create_specs") {
        return {
          action: "create_specs" as const,
          client_reference: skill.client_reference,
          title: skill.skill.title,
          objective: skill.skill.objective,
          placement: plannedPlacement(skill),
        };
      }
      if (skill.kind === "create_text") {
        return {
          action: "create_text" as const,
          client_reference: skill.client_reference,
          intent: skill.intent,
          ...(skill.source_label !== undefined
            ? { source_label: skill.source_label }
            : {}),
          source_char_count: Array.from(skill.source_text).length,
          placement: plannedPlacement(skill),
        };
      }
      return {
        action: "create_material" as const,
        client_reference: skill.client_reference,
        material_id: skill.material_id,
        expected_revision_id: skill.expected_revision_id,
        ...(skill.section_ids !== undefined
          ? { section_ids: [...skill.section_ids] }
          : {}),
        max_skills: skill.max_skills,
        placement: plannedPlacement(skill),
      };
    }),
  };
}

function publicPlan(plan: PlanRecord, input?: SetupInput): SetupResult {
  const parsedStoredInput = input
    ? null
    : agentSetupPreviewSchema.safeParse(plan.requestedSpec);
  const storedInput = input ?? (parsedStoredInput?.success ? parsedStoredInput.data : null);
  const summary = input
    ? planSummary(input)
    : typeof plan.requestedSpec === "object" && plan.requestedSpec !== null
      ? summarizeStoredSpec(plan.requestedSpec)
      : null;
  return {
    plan_id: plan.id,
    status: plan.status,
    permission_version: plan.permissionVersion,
    idempotency_key: plan.idempotencyKey,
    payload_hash: plan.payloadHash,
    summary,
    planned_changes: storedInput ? projectSetupPlannedChanges(storedInput) : null,
    result: publicSetupProgress(plan.result),
    errors: publicSetupErrors(plan.errors),
    created_at: plan.createdAt.toISOString(),
    updated_at: plan.updatedAt.toISOString(),
    plan_uri: `learnrecur://setup-plans/${plan.id}`,
  };
}

function summarizeStoredSpec(value: Prisma.JsonValue) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const skills = Array.isArray(record.skills) ? record.skills : [];
  const collections = Array.isArray(record.collections) ? record.collections : [];
  return {
    collection_count: collections.length,
    skill_count: skills.length,
    created_skill_count: skills.filter((skill) => skill && typeof skill === "object" && (skill as Record<string, unknown>).kind !== "reuse").length,
    reused_skill_count: skills.filter((skill) => skill && typeof skill === "object" && (skill as Record<string, unknown>).kind === "reuse").length,
    includes_practice_settings: record.practice !== undefined,
    includes_reminders: record.reminders !== undefined,
    client_references: skills.flatMap((skill) => skill && typeof skill === "object" && typeof (skill as Record<string, unknown>).client_reference === "string" ? [(skill as Record<string, string>).client_reference] : []),
  };
}

async function buildSnapshot(
  tx: Prisma.TransactionClient,
  auth: AgentAuthContext,
  input: SetupInput,
) {
  const user = await tx.user.findUnique({
    where: { id: auth.userId },
    select: {
      practicePreference: true,
      mixedReview: true,
      dailyNewSkillLimit: true,
      practiceTimezone: true,
      desiredRetention: true,
      practiceDayStartMinutes: true,
    },
  });
  if (!user) throw new AgentOperationError("permission_denied", "The account was not found.");

  const reminder = await tx.reminderPreference.findUnique({
    where: { userId: auth.userId },
    select: {
      enabled: true,
      email: true,
      localHour: true,
      timezone: true,
      minimumDueCount: true,
      updatedAt: true,
    },
  });
  const collectionIds = input.collections
    .filter((collection): collection is Extract<typeof collection, { kind: "reuse" }> => collection.kind === "reuse")
    .map((collection) => collection.collection_id);
  const skillIds = input.skills
    .filter((skill): skill is Extract<typeof skill, { kind: "reuse" }> => skill.kind === "reuse")
    .map((skill) => skill.skill_id);
  const [collections, skills] = await Promise.all([
    collectionIds.length
      ? tx.collection.findMany({
          where: { userId: auth.userId, id: { in: collectionIds } },
          select: { id: true, name: true, status: true, updatedAt: true },
        })
      : [],
    skillIds.length
      ? tx.skill.findMany({
          where: { userId: auth.userId, id: { in: skillIds } },
          select: { id: true, title: true, status: true, collectionId: true, tags: true, updatedAt: true },
        })
      : [],
  ]);
  if (collections.length !== collectionIds.length) {
    throw new AgentOperationError("collection_not_found", "One or more collections in the setup plan were not found.");
  }
  if (skills.length !== skillIds.length) {
    throw new AgentOperationError("skill_not_found", "One or more skills in the setup plan were not found.");
  }
  return {
    permission_version: auth.permissionVersion ?? null,
    user: {
      practice_preference: user.practicePreference,
      mixed_review: user.mixedReview,
      daily_new_skill_limit: user.dailyNewSkillLimit,
      practice_timezone: user.practiceTimezone,
      desired_retention: user.desiredRetention,
      practice_day_start_minutes: user.practiceDayStartMinutes,
    },
    reminder: reminder
      ? {
          updated_at: reminder.updatedAt.toISOString(),
          enabled: reminder.enabled,
          email: reminder.email,
          local_hour: reminder.localHour,
          timezone: reminder.timezone,
          minimum_due_count: reminder.minimumDueCount,
        }
      : null,
    collections: collections
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map((collection) => ({
        id: collection.id,
        name: collection.name,
        status: collection.status,
        updated_at: collection.updatedAt.toISOString(),
      })),
    skills: skills
      .toSorted((left, right) => left.id.localeCompare(right.id))
      .map((skill) => ({
        id: skill.id,
        title: skill.title,
        status: skill.status,
        collection_id: skill.collectionId,
        tags: skill.tags,
        updated_at: skill.updatedAt.toISOString(),
      })),
  };
}

export function validateSetupReferences(input: SetupInput) {
  const createdCollectionReferences = input.collections
    .filter(
      (collection): collection is Extract<typeof collection, { kind: "create" }> =>
        collection.kind === "create",
    )
    .map((collection) => collection.client_reference);
  if (new Set(createdCollectionReferences).size !== createdCollectionReferences.length) {
    throw new AgentOperationError("invalid_input", "Collection client references must be unique within a setup plan.");
  }
  const collectionStepKeys = input.collections.map((collection) =>
    collection.kind === "create"
      ? `collection:${collection.client_reference}`
      : `collection:${collection.collection_id}`,
  );
  if (new Set(collectionStepKeys).size !== collectionStepKeys.length) {
    throw new AgentOperationError("invalid_input", "Collection actions must identify distinct steps within a setup plan.");
  }
  const skillStepKeys = input.skills.map((skill) =>
    skill.kind === "reuse"
      ? `skill:${skill.skill_id}`
      : `skill:${skill.client_reference}`,
  );
  if (new Set(skillStepKeys).size !== skillStepKeys.length) {
    throw new AgentOperationError("invalid_input", "Skill actions must identify distinct steps within a setup plan.");
  }
  const createdCollections = new Set(createdCollectionReferences);
  for (const skill of input.skills) {
    const reference = collectionReferenceForSkill(skill);
    if (reference && !createdCollections.has(reference)) {
      throw new AgentOperationError(
        "invalid_input",
        `The setup collection reference ${reference} must name a collection created in the same plan.`,
      );
    }
  }
}

async function validateMaterialActions(
  tx: Prisma.TransactionClient,
  auth: AgentAuthContext,
  input: SetupInput,
) {
  for (const skill of input.skills) {
    if (skill.kind !== "create_material") continue;
    const material = await tx.studyMaterial.findFirst({
      where: { id: skill.material_id, userId: auth.userId, status: "ACTIVE" },
      select: { activeRevisionId: true },
    });
    if (!material || material.activeRevisionId !== skill.expected_revision_id) {
      throw new AgentOperationError("stale_material_revision", "A setup material revision is no longer active.");
    }
    const revision = await tx.materialRevision.findFirst({
      where: { id: skill.expected_revision_id, userId: auth.userId, status: MaterialRevisionStatus.READY },
      select: { id: true },
    });
    if (!revision) throw new AgentOperationError("stale_material_revision", "A setup material revision is not ready.");
    if (skill.section_ids?.length) {
      const count = await tx.materialSection.count({
        where: { id: { in: skill.section_ids }, userId: auth.userId, materialRevisionId: revision.id },
      });
      if (count !== skill.section_ids.length) {
        throw new AgentOperationError("material_not_found", "One or more setup material sections were not found.");
      }
    }
  }
}

async function validatePracticeAndReminderInputs(
  tx: Prisma.TransactionClient,
  auth: AgentAuthContext,
  input: SetupInput,
) {
  if (input.practice) {
    const timezone = input.practice.practice_timezone;
    if (timezone !== undefined) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      } catch {
        throw new AgentOperationError("invalid_input", "The setup practice timezone must be a valid IANA timezone.");
      }
    }
  }
  if (input.reminders) {
    const user = await tx.user.findUnique({ where: { id: auth.userId }, select: { email: true } });
    const current = await tx.reminderPreference.findUnique({
      where: { userId: auth.userId },
      select: { enabled: true, email: true, localHour: true, timezone: true, minimumDueCount: true },
    });
    const existing = current ?? {
      enabled: false,
      email: user?.email ?? "",
      localHour: 9,
      timezone: "America/New_York",
      minimumDueCount: 1,
    };
    const timezone = input.reminders.timezone ?? existing.timezone;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    } catch {
      throw new AgentOperationError("invalid_input", "The setup reminder timezone must be a valid IANA timezone.");
    }
    if (input.reminders.enabled && !(user?.email ?? input.reminders.email ?? existing.email)) {
      throw new AgentOperationError("invalid_input", "Enabled reminders require a verified account email.");
    }
    const normalized = normalizeReminderPreferenceInput({
      enabled: input.reminders.enabled ?? existing.enabled,
      email: user?.email ?? input.reminders.email ?? existing.email,
      localHour: input.reminders.local_hour ?? existing.localHour,
      timezone,
      minimumDueCount: input.reminders.minimum_due_count ?? existing.minimumDueCount,
    });
    if (normalized.status !== "valid") {
      throw new AgentOperationError("invalid_input", normalized.message);
    }
  }
}

async function assertSetupScopes(
  tx: Prisma.TransactionClient,
  auth: AgentAuthContext,
  input: SetupInput,
  expectedPermissionVersion?: number,
) {
  const connection = await tx.agentConnection.findFirst({
    where: {
      id: auth.connectionId,
      userId: auth.userId,
      status: "ACTIVE",
    },
    select: { permissionVersion: true, scopes: true },
  });
  if (!connection) {
    throw new AgentOperationError(
      "permission_denied",
      "The setup connection is no longer active.",
    );
  }
  if (
    expectedPermissionVersion !== undefined &&
    connection.permissionVersion !== expectedPermissionVersion
  ) {
    throw new AgentOperationError(
      "setup_stale",
      "The setup connection permissions changed. Preview a new plan.",
    );
  }
  const missing = requiredSetupScopes(input).find(
    (scope) => !auth.scopes.includes(scope) || !connection.scopes.includes(scope),
  );
  if (missing) {
    throw new AgentOperationError(
      "permission_denied",
      `Agent permission ${missing} is required for this setup plan.`,
    );
  }
  return connection;
}

function sameRecordExceptUpdatedAt(
  current: Record<string, unknown> | null,
  expected: Record<string, unknown> | null,
  ignored: Set<string> = new Set(["updated_at"]),
) {
  if (!current || !expected) return current === expected;
  for (const key of new Set([...Object.keys(current), ...Object.keys(expected)])) {
    if (ignored.has(key)) continue;
    if (JSON.stringify(current[key]) !== JSON.stringify(expected[key])) return false;
  }
  return true;
}

function snapshotCompatibleAfterApply(
  baseline: Prisma.JsonValue,
  current: ReturnType<typeof buildSnapshot> extends Promise<infer T> ? T : never,
  input: SetupInput,
  completedActions: ReadonlyMap<string, SetupActionRecord>,
) {
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) return false;
  const expected = baseline as Record<string, unknown>;
  const currentRecord = current as unknown as Record<string, unknown>;
  const baselineUser = expected.user as Record<string, unknown>;
  const currentUser = currentRecord.user as Record<string, unknown>;
  const requestedPractice = input.practice ?? {};
  const practiceMapping: Record<string, keyof typeof requestedPractice> = {
    practice_preference: "practice_preference",
    mixed_review: "mixed_review",
    daily_new_skill_limit: "daily_new_skill_limit",
    practice_timezone: "practice_timezone",
    desired_retention: "desired_retention",
    practice_day_start_minutes: "practice_day_start_minutes",
  };
  const practiceCompleted = actionStatusIsSuccessful(completedActions.get("practice") ?? {});
  for (const [key, requestKey] of Object.entries(practiceMapping)) {
    const requested = requestedPractice[requestKey];
    if (practiceCompleted) continue;
    if (requested !== undefined && JSON.stringify(currentUser[key]) !== JSON.stringify(baselineUser[key])) {
      return false;
    }
  }
  const baselineReminder = (expected.reminder as Record<string, unknown> | null) ?? null;
  const currentReminder = (currentRecord.reminder as Record<string, unknown> | null) ?? null;
  if (input.reminders) {
    const remindersCompleted = actionStatusIsSuccessful(completedActions.get("reminders") ?? {});
    if (!remindersCompleted && currentReminder !== null && baselineReminder !== null) {
      const reminderMapping: Record<string, keyof typeof input.reminders> = {
        enabled: "enabled",
        email: "email",
        local_hour: "local_hour",
        timezone: "timezone",
        minimum_due_count: "minimum_due_count",
      };
      for (const [key, requestKey] of Object.entries(reminderMapping)) {
        const requested = input.reminders[requestKey];
        if (
          requested !== undefined &&
          JSON.stringify(currentReminder[key]) !== JSON.stringify(baselineReminder[key])
        ) {
          return false;
        }
      }
    } else if (!remindersCompleted && currentReminder !== baselineReminder) {
      return false;
    }
  }
  const baselineCollections = new Map(
    ((expected.collections as Array<Record<string, unknown>>) ?? []).map((collection) => [
      String(collection.id),
      collection,
    ]),
  );
  const currentCollections = new Map(
    ((currentRecord.collections as Array<Record<string, unknown>>) ?? []).map((collection) => [
      String(collection.id),
      collection,
    ]),
  );
  for (const collection of input.collections) {
    if (collection.kind !== "reuse") continue;
    if (actionStatusIsSuccessful(completedActions.get(`collection:${collection.collection_id}`) ?? {})) continue;
    const oldCollection = baselineCollections.get(collection.collection_id);
    const newCollection = currentCollections.get(collection.collection_id);
    if (!oldCollection || !newCollection || !sameRecordExceptUpdatedAt(newCollection, oldCollection)) {
      return false;
    }
  }
  const baselineSkills = new Map(((expected.skills as Array<Record<string, unknown>>) ?? []).map((skill) => [String(skill.id), skill]));
  const currentSkills = new Map(((currentRecord.skills as Array<Record<string, unknown>>) ?? []).map((skill) => [String(skill.id), skill]));
  for (const skill of input.skills) {
    if (skill.kind !== "reuse") continue;
    if (actionStatusIsSuccessful(completedActions.get(`skill:${skill.skill_id}`) ?? {})) continue;
    const oldSkill = baselineSkills.get(skill.skill_id);
    const newSkill = currentSkills.get(skill.skill_id);
    if (!oldSkill || !newSkill) return false;
    if (
      JSON.stringify(newSkill.title) !== JSON.stringify(oldSkill.title) ||
      JSON.stringify(newSkill.status) !== JSON.stringify(oldSkill.status)
    ) {
      return false;
    }
    if (
      (skill.collection_id !== undefined || collectionReferenceForSkill(skill)) &&
      JSON.stringify(newSkill.collection_id) !== JSON.stringify(oldSkill.collection_id)
    ) {
      return false;
    }
    if (skill.tags !== undefined && JSON.stringify(newSkill.tags) !== JSON.stringify(oldSkill.tags)) {
      return false;
    }
    if (
      skill.collection_id === undefined &&
      !collectionReferenceForSkill(skill) &&
      skill.tags === undefined &&
      !sameRecordExceptUpdatedAt(newSkill, oldSkill)
    ) {
      return false;
    }
  }
  return true;
}

export async function previewAgentSetup(
  auth: AgentAuthContext,
  rawInput: unknown,
): Promise<SetupResult> {
  const input = agentSetupPreviewSchema.parse(rawInput);
  const payloadHash = buildAgentPayloadHash(input);
  return withAgentMutation(auth, "setup:write", async (tx) => {
    await assertSetupScopes(tx, auth, input);
    validateSetupReferences(input);
    const connection = await tx.agentConnection.findUnique({
      where: { id_userId: { id: auth.connectionId, userId: auth.userId } },
      select: { permissionVersion: true },
    });
    if (!connection || (auth.permissionVersion !== undefined && connection.permissionVersion !== auth.permissionVersion)) {
      throw new AgentOperationError("permission_denied", "The setup connection permissions changed. Reconnect and try again.");
    }
    const existing = await tx.agentSetupPlan.findUnique({
      where: { connectionId_idempotencyKey: { connectionId: auth.connectionId, idempotencyKey: input.idempotency_key } },
      select: PLAN_SELECT,
    });
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new AgentOperationError("idempotency_conflict", "This setup idempotency key was already used for a different plan.");
      }
      return publicPlan(existing, input);
    }
    await validateMaterialActions(tx, auth, input);
    await validatePracticeAndReminderInputs(tx, auth, input);
    const snapshot = await buildSnapshot(tx, auth, input);
    const plan = await tx.agentSetupPlan.create({
      data: {
        userId: auth.userId,
        connectionId: auth.connectionId,
        idempotencyKey: input.idempotency_key,
        payloadHash,
        permissionVersion: connection.permissionVersion,
        requestedSpec: jsonValue(input),
        snapshot: jsonValue(snapshot),
        status: AgentSetupPlanStatus.PREVIEWED,
      },
      select: PLAN_SELECT,
    });
    return {
      ...publicPlan(plan, input),
      actions: planSummary(input),
      snapshot_hash: stableHash(snapshot),
    };
  });
}

async function claimSetupPlanOnce(auth: AgentAuthContext, planId: string) {
  return withAgentMutation(auth, "setup:write", async (tx) => {
    const plan = await tx.agentSetupPlan.findFirst({
      where: { id: planId, userId: auth.userId, connectionId: auth.connectionId },
      select: PLAN_SELECT,
    });
    if (!plan) throw new AgentOperationError("setup_not_found", "The setup plan was not found for this connection.");
    if (plan.status === AgentSetupPlanStatus.SUCCEEDED) return { plan, claimed: false as const };
    if (plan.status === AgentSetupPlanStatus.STALE || plan.status === AgentSetupPlanStatus.CANCELED) {
      throw new AgentOperationError("setup_stale", "This setup plan is stale. Preview a new plan from current settings.");
    }
    const spec = agentSetupPreviewSchema.parse(plan.requestedSpec);
    const connection = await assertSetupScopes(
      tx,
      auth,
      spec,
      plan.permissionVersion,
    );
    const existingProgress = setupProgress(plan.result);
    if (
      plan.status === AgentSetupPlanStatus.APPLYING &&
      !leaseIsExpired(existingProgress)
    ) {
      throw new AgentOperationError(
        "setup_in_progress",
        "This setup plan is already being applied. Retry after its current result is available.",
      );
    }
    if (plan.status === AgentSetupPlanStatus.PREVIEWED) {
      const currentSnapshot = await buildSnapshot(tx, auth, spec);
      if (stableHash(currentSnapshot) !== stableHash(plan.snapshot)) {
        const stale = await tx.agentSetupPlan.update({
          where: { id: plan.id },
          data: {
            status: AgentSetupPlanStatus.STALE,
            errors: jsonValue({ code: "stale_state", message: "Account, connection, or selected library state changed after preview.", expected_snapshot_hash: stableHash(plan.snapshot), current_snapshot_hash: stableHash(currentSnapshot) }),
          },
          select: PLAN_SELECT,
        });
        return { plan: stale, claimed: false as const };
      }
    } else if (
      plan.status === AgentSetupPlanStatus.APPLYING ||
      plan.status === AgentSetupPlanStatus.PARTIAL ||
      plan.status === AgentSetupPlanStatus.FAILED
    ) {
      const currentSnapshot = await buildSnapshot(tx, auth, spec);
      const completedActions = progressActions(plan);
      if (
        stableHash(currentSnapshot) !== stableHash(plan.snapshot) &&
        !snapshotCompatibleAfterApply(plan.snapshot, currentSnapshot, spec, completedActions)
      ) {
        const stale = await tx.agentSetupPlan.update({
          where: { id: plan.id },
          data: {
            status: AgentSetupPlanStatus.STALE,
            errors: jsonValue({ code: "stale_state", message: "The account changed while the previous setup attempt was interrupted; no later user edit was overwritten." }),
          },
          select: PLAN_SELECT,
        });
        return { plan: stale, claimed: false as const };
      }
    }
    const leaseToken = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + SETUP_LEASE_MS).toISOString();
    const claimed = await tx.agentSetupPlan.update({
      where: { id: plan.id },
      data: {
        status: AgentSetupPlanStatus.APPLYING,
        errors: Prisma.DbNull,
        result: jsonValue({
          ...existingProgress,
          version: 1,
          lease_token: leaseToken,
          lease_expires_at: leaseExpiresAt,
        }),
      },
      select: PLAN_SELECT,
    });
    // Keep this read in the same transaction so the claim is bound to the
    // connection permission version that was just preflighted.
    if (connection.permissionVersion !== claimed.permissionVersion) {
      throw new AgentOperationError("setup_stale", "The setup connection permissions changed. Preview a new plan.");
    }
    return { plan: claimed, claimed: true as const, leaseToken };
  });
}

async function resolveClaimSerializationConflict(
  auth: AgentAuthContext,
  planId: string,
) {
  // A serialization failure can be returned after the competing transaction
  // has committed. Read the owned plan once before exposing a retryable public
  // error, so a completed concurrent apply is replayed normally.
  const current = await getPrisma().agentSetupPlan.findFirst({
    where: { id: planId, userId: auth.userId, connectionId: auth.connectionId },
    select: PLAN_SELECT,
  });
  if (!current) {
    throw new AgentOperationError(
      "setup_not_found",
      "The setup plan was not found for this connection.",
    );
  }
  if (current.status === AgentSetupPlanStatus.SUCCEEDED) {
    return { plan: current, claimed: false as const };
  }
  if (
    current.status === AgentSetupPlanStatus.STALE ||
    current.status === AgentSetupPlanStatus.CANCELED
  ) {
    throw new AgentOperationError(
      "setup_stale",
      "This setup plan is stale. Preview a new plan from current settings.",
    );
  }
  throw new AgentOperationError(
    "setup_in_progress",
    "This setup plan is already being applied. Retry after its current result is available.",
  );
}

async function claimSetupPlan(auth: AgentAuthContext, planId: string) {
  for (let attempt = 0; attempt <= CLAIM_SERIALIZATION_RETRIES; attempt += 1) {
    try {
      return await claimSetupPlanOnce(auth, planId);
    } catch (error) {
      if (!isAgentSerializationConflict(error)) throw error;
      if (attempt === CLAIM_SERIALIZATION_RETRIES) {
        return resolveClaimSerializationConflict(auth, planId);
      }
      await new Promise((resolve) => setTimeout(resolve, CLAIM_RETRY_DELAY_MS));
    }
  }
  throw new AgentOperationError(
    "setup_in_progress",
    "This setup plan is already being applied. Retry after its current result is available.",
  );
}

function setupIdempotency(planId: string, index: number) {
  return `setup-${planId}-${index}`;
}

async function assertSetupLease(
  tx: Prisma.TransactionClient,
  planId: string,
  leaseToken: string,
) {
  const plan = await tx.agentSetupPlan.findFirst({
    where: { id: planId },
    select: PLAN_SELECT,
  });
  if (!plan || plan.status !== AgentSetupPlanStatus.APPLYING) {
    throw new SetupLeaseLostError();
  }
  const progress = setupProgress(plan.result);
  if (progress.lease_token !== leaseToken || leaseIsExpired(progress)) {
    throw new SetupLeaseLostError();
  }
  return plan;
}

async function assertSetupLeaseOutside(
  auth: AgentAuthContext,
  planId: string,
  leaseToken: string,
) {
  const plan = await getPrisma().agentSetupPlan.findFirst({
    where: { id: planId, userId: auth.userId, connectionId: auth.connectionId },
    select: { status: true, result: true },
  });
  if (!plan || plan.status !== AgentSetupPlanStatus.APPLYING) {
    throw new SetupLeaseLostError();
  }
  const progress = setupProgress(plan.result);
  if (progress.lease_token !== leaseToken || leaseIsExpired(progress)) {
    throw new SetupLeaseLostError();
  }
}

function countProgressActions(actions: readonly SetupActionRecord[]) {
  return {
    pending: actions.filter(
      (action) => !actionStatusIsSuccessful(action) && !actionStatusIsFailed(action),
    ).length,
    failed: actions.filter(actionStatusIsFailed).length,
  };
}

async function appendSetupJournal(
  tx: Prisma.TransactionClient,
  planId: string,
  leaseToken: string,
  action: SetupActionRecord,
) {
  const current = await tx.agentSetupPlan.findFirst({
    where: { id: planId },
    select: PLAN_SELECT,
  });
  if (!current) throw new SetupLeaseLostError();
  const progress = setupProgress(current.result);
  if (
    current.status !== AgentSetupPlanStatus.APPLYING ||
    progress.lease_token !== leaseToken ||
    leaseIsExpired(progress)
  ) {
    throw new SetupLeaseLostError();
  }
  const key = actionKey(action);
  if (!key) throw new Error("Setup journal entries require a stable step key.");
  const actions = [...progress.actions];
  const existingIndex = actions.findIndex((entry) => actionKey(entry) === key);
  if (existingIndex === -1) actions.push(action);
  else actions[existingIndex] = action;
  const counts = countProgressActions(actions);
  await tx.agentSetupPlan.update({
    where: { id: current.id },
    data: {
      result: jsonValue({
        ...progress,
        actions,
        pending_count: counts.pending,
        failed_count: counts.failed,
        retryable: counts.pending > 0 || counts.failed > 0,
        lease_expires_at: new Date(Date.now() + SETUP_LEASE_MS).toISOString(),
      }),
    },
  });
}

async function runAtomicSetupStep(
  auth: AgentAuthContext,
  scopes: readonly AgentAccessScope[],
  planId: string,
  leaseToken: string,
  stepKey: string,
  work: (tx: Prisma.TransactionClient) => Promise<SetupActionRecord>,
) {
  return withAgentMutation(auth, scopes, async (tx) => {
    const plan = await assertSetupLease(tx, planId, leaseToken);
    const input = agentSetupPreviewSchema.parse(plan.requestedSpec);
    const currentSnapshot = await buildSnapshot(tx, auth, input);
    const completedActions = progressActions(plan);
    if (
      stableHash(currentSnapshot) !== stableHash(plan.snapshot) &&
      !snapshotCompatibleAfterApply(
        plan.snapshot,
        currentSnapshot,
        input,
        completedActions,
      )
    ) {
      throw new AgentOperationError(
        "stale_state",
        "The account changed while this setup step was waiting; no later user edit was overwritten.",
      );
    }
    const action = { ...(await work(tx)), step_key: stepKey };
    await appendSetupJournal(tx, planId, leaseToken, action);
    return action;
  });
}

async function journalSetupAction(
  auth: AgentAuthContext,
  planId: string,
  leaseToken: string,
  action: SetupActionRecord,
) {
  // Journal-only commits still revalidate the connection and lease, but run
  // inside an explicitly owned transaction so bookkeeping does not consume a
  // second mutation-rate allowance after a child operation has already paid.
  return getPrisma().$transaction(async (tx) =>
    withAgentMutation(
      auth,
      "setup:write",
      async (guardedTx) => {
        await assertSetupLease(guardedTx, planId, leaseToken);
        const journaled = { ...action, step_key: action.step_key };
        await appendSetupJournal(guardedTx, planId, leaseToken, journaled);
        return journaled;
      },
      tx,
    ),
  );
}

async function journalSetupFailure(
  auth: AgentAuthContext,
  planId: string,
  leaseToken: string,
  base: SetupActionRecord,
  error: unknown,
) {
  return journalSetupAction(auth, planId, leaseToken, {
    ...base,
    status: "failed",
    error: publicSetupError(error),
  });
}

async function getChildOperation(
  auth: AgentAuthContext,
  toolName: string,
  idempotencyKey: string,
) {
  const operation = await getPrisma().agentSkillOperation.findUnique({
    where: {
      connectionId_toolName_idempotencyKey: {
        connectionId: auth.connectionId,
        toolName,
        idempotencyKey,
      },
    },
    select: {
      id: true,
      userId: true,
      status: true,
      requestedCount: true,
      activeCount: true,
      reusedCount: true,
      failedCount: true,
      errorCode: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
      completedAt: true,
      items: {
        orderBy: { ordinal: "asc" },
        select: {
          resultSkillId: true,
          createdSkillId: true,
          status: true,
          clientReference: true,
          errorCode: true,
        },
      },
    },
  });
  if (!operation || operation.userId !== auth.userId) return null;
  return operation;
}

function operationAction(
  operation: Awaited<ReturnType<typeof getChildOperation>> | Record<string, unknown>,
  base: SetupActionRecord,
): SetupActionRecord {
  const record = operation as Record<string, unknown>;
  const status = normalizeSetupOperationStatus(record.status ?? record.operation_status);
  const items = Array.isArray(record.items) ? record.items : [];
  const skillIds = items.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const child = item as Record<string, unknown>;
    const id = child.resultSkillId ?? child.result_skill_id ?? child.createdSkillId ?? child.created_skill_id ?? child.skill_id;
    return typeof id === "string" ? [id] : [];
  });
  return {
    ...base,
    status: status.public,
    operation_id: String(record.id ?? record.operation_id),
    operation_status: status.raw || String(record.operation_status ?? "PENDING"),
    requested_count: record.requestedCount ?? record.requested_count ?? null,
    active_count: record.activeCount ?? record.active_count ?? null,
    reused_count: record.reusedCount ?? record.reused_count ?? null,
    failed_count: record.failedCount ?? record.failed_count ?? null,
    skill_ids: skillIds,
    items,
    error_code: record.errorCode ?? record.error_code ?? null,
    error_message: record.errorMessage ?? record.error_message ?? null,
    completed_at:
      record.completedAt instanceof Date
        ? record.completedAt.toISOString()
        : record.completed_at ?? null,
  };
}

function collectionReferenceForSkill(skill: SetupInput["skills"][number]) {
  return "collection_reference" in skill && typeof skill.collection_reference === "string"
    ? skill.collection_reference
    : null;
}

function resolveSetupCollectionId(
  skill: SetupInput["skills"][number],
  actions: ReadonlyMap<string, SetupActionRecord>,
) {
  if (skill.kind === "reuse" && skill.collection_id !== undefined) {
    return skill.collection_id;
  }
  const reference = collectionReferenceForSkill(skill);
  if (!reference) return skill.kind === "reuse" ? skill.collection_id : undefined;
  const collection = [...actions.values()].find(
    (action) =>
      action.kind === "collection" &&
      action.client_reference === reference &&
      actionStatusIsSuccessful(action),
  );
  const collectionId =
    collection?.collection &&
    typeof collection.collection === "object" &&
    !Array.isArray(collection.collection) &&
    typeof (collection.collection as Record<string, unknown>).collection_id === "string"
      ? (collection.collection as Record<string, unknown>).collection_id
      : null;
  if (!collectionId) {
    throw new AgentOperationError(
      "collection_not_found",
      `The setup collection reference ${reference} has not been created successfully.`,
    );
  }
  return collectionId;
}

function childOperationSpec(skill: SetupInput["skills"][number], planId: string, index: number) {
  const idempotencyKey = setupIdempotency(planId, index);
  if (skill.kind === "create_specs") {
    const collectionReference = collectionReferenceForSkill(skill);
    const skillSpec = collectionReference ? { ...skill.skill } : skill.skill;
    if (collectionReference && "collection" in skillSpec) delete skillSpec.collection;
    return {
      toolName: "skills.add_from_specs",
      idempotencyKey,
      input: {
        idempotency_key: idempotencyKey,
        items: [
          {
            client_reference: skill.client_reference,
            skill: skillSpec,
            candidate_exercises: skill.candidate_exercises,
          },
        ],
      },
    } as const;
  }
  if (skill.kind === "create_text") {
    return {
      toolName: "skills.add_from_text",
      idempotencyKey,
      input: {
        idempotency_key: idempotencyKey,
        source_text: skill.source_text,
        intent: skill.intent,
        source_label: skill.source_label,
        ...(skill.collection !== undefined ? { collection: skill.collection } : {}),
        tags: skill.tags,
        candidate_exercises: skill.candidate_exercises,
      },
    } as const;
  }
  if (skill.kind !== "create_material") {
    throw new AgentOperationError("invalid_input", "Unsupported setup skill action.");
  }
  return {
    toolName: "skills.add_from_material",
    idempotencyKey,
    input: {
      idempotency_key: idempotencyKey,
      material_id: skill.material_id,
      expected_revision_id: skill.expected_revision_id,
      instruction: skill.instruction,
      section_ids: skill.section_ids,
      max_skills: skill.max_skills,
    },
  } as const;
}

async function applySetupActions(
  auth: AgentAuthContext,
  plan: PlanRecord,
  leaseToken: string,
): Promise<SetupResult> {
  const input = agentSetupPreviewSchema.parse(plan.requestedSpec);
  const actions = progressActions(plan);

  const recordAction = (action: SetupActionRecord) => {
    const key = actionKey(action);
    if (key) actions.set(key, action);
  };

  const priorAction = (key: string, requiresPlacement = false) => {
    const action = actions.get(key);
    if (!action || !actionStatusIsSuccessful(action)) return null;
    if (requiresPlacement && !("placement" in action)) return null;
    return action;
  };

  const runAndRecord = async (
    key: string,
    base: SetupActionRecord,
    work: () => Promise<SetupActionRecord>,
  ) => {
    try {
      const action = await work();
      recordAction({ ...action, step_key: key });
      return action;
    } catch (error) {
      if (error instanceof SetupLeaseLostError) throw error;
      const failure = await journalSetupFailure(auth, plan.id, leaseToken, { ...base, step_key: key }, error);
      recordAction(failure);
      return failure;
    }
  };

  for (const collection of input.collections) {
    const key = collection.kind === "create"
      ? `collection:${collection.client_reference}`
      : `collection:${collection.collection_id}`;
    if (priorAction(key)) continue;
    const base: SetupActionRecord = {
      kind: "collection",
      action: collection.kind,
      ...(collection.kind === "create"
        ? { client_reference: collection.client_reference }
        : { collection_id: collection.collection_id }),
    };
    await runAndRecord(key, base, async () => {
      const scopes: AgentAccessScope[] = [
        "setup:write",
        collection.kind === "create" ? "collections:write" : "collections:read",
      ];
      return runAtomicSetupStep(auth, scopes, plan.id, leaseToken, key, async (tx) => {
        if (collection.kind === "reuse") {
          const existing = await tx.collection.findFirst({
            where: { id: collection.collection_id, userId: auth.userId, status: "ACTIVE" },
            select: { id: true, name: true, description: true, status: true, updatedAt: true },
          });
          if (!existing) throw new AgentOperationError("collection_not_found", "The collection was not found or is archived.");
          return {
            ...base,
            status: "ready",
            collection: {
              collection_id: existing.id,
              name: existing.name,
              description: existing.description,
              status: existing.status,
              updated_at: existing.updatedAt.toISOString(),
            },
          };
        }
        const created = await createAgentCollection(
          auth,
          { name: collection.name, description: collection.description },
          tx,
        );
        if (created.status !== "created") {
          throw new AgentOperationError("invalid_input", created.message ?? "The collection could not be created.");
        }
        return { ...base, status: "created", collection: created.collection };
      });
    });
  }

  for (const [index, skill] of input.skills.entries()) {
    const key = skill.kind === "reuse"
      ? `skill:${skill.skill_id}`
      : `skill:${skill.client_reference}`;
    const needsPlacement =
      skill.kind === "reuse"
        ? skill.collection_id !== undefined ||
          collectionReferenceForSkill(skill) !== null ||
          skill.tags !== undefined
        : collectionReferenceForSkill(skill) !== null ||
          (skill.kind === "create_material" && skill.collection !== undefined);
    if (priorAction(key, needsPlacement)) continue;
    const base: SetupActionRecord = {
      kind: "skill",
      action: skill.kind,
      ...(skill.kind === "reuse"
        ? { skill_id: skill.skill_id }
        : { client_reference: skill.client_reference }),
    };

    if (skill.kind === "reuse") {
      const needsWrite =
        skill.collection_id !== undefined ||
        collectionReferenceForSkill(skill) !== null ||
        skill.tags !== undefined;
      await runAndRecord(key, base, async () => {
        if (!needsWrite) {
          return runAtomicSetupStep(
            auth,
            ["setup:write", "skills:read"],
            plan.id,
            leaseToken,
            key,
            async (tx) => {
              const existing = await tx.skill.findFirst({
                where: { id: skill.skill_id, userId: auth.userId },
                select: { id: true },
              });
              if (!existing) throw new AgentOperationError("skill_not_found", "The skill was not found.");
              return { ...base, status: "ready" };
            },
          );
        }
        return runAtomicSetupStep(
          auth,
          ["setup:write", "skills:write"],
          plan.id,
          leaseToken,
          key,
          async (tx) => {
            const collectionId = resolveSetupCollectionId(skill, actions);
            const updated = await batchUpdateAgentSkills(
              auth,
              {
                skill_ids: [skill.skill_id],
                ...(skill.collection_id !== undefined || collectionReferenceForSkill(skill)
                  ? { collection_id: collectionId }
                  : {}),
                ...(skill.tags !== undefined ? { set_tags: skill.tags } : {}),
              },
              tx,
            );
            if (updated.status !== "updated") {
              throw new AgentOperationError("stale_state", "The skill changed before setup could update it.");
            }
            return { ...base, status: "updated", result: updated, placement: updated };
          },
        );
      });
      continue;
    }

    const spec = childOperationSpec(skill, plan.id, index);
      let operation: Awaited<ReturnType<typeof getChildOperation>> | Record<string, unknown> | null = null;
    try {
      await assertSetupLeaseOutside(auth, plan.id, leaseToken);
      operation = await getChildOperation(auth, spec.toolName, spec.idempotencyKey);
      if (!operation) {
        try {
          operation = skill.kind === "create_specs"
            ? await createAgentSpecOperation(auth, spec.input)
            : skill.kind === "create_text"
              ? await createAgentTextOperation(auth, spec.input)
              : await createAgentMaterialOperation(auth, spec.input);
        } catch (error) {
          // A child operation can commit before this worker observes its
          // response. Reconcile by the unique deterministic key before
          // reporting failure; never recover by a mutable collection name.
          const reconciled = await getChildOperation(auth, spec.toolName, spec.idempotencyKey);
          if (reconciled) operation = reconciled;
          else throw error;
        }
      }
      if (!operation) throw new AgentOperationError("operation_not_found", "The child operation could not be created or recovered.");
      const childAction = operationAction(operation, base);
      const normalized = normalizeSetupOperationStatus(childAction.operation_status);
      const skillIds = Array.isArray(childAction.skill_ids)
        ? childAction.skill_ids.filter((skillId): skillId is string => typeof skillId === "string")
        : [];
      if (!needsPlacement || !normalized.terminal || skillIds.length === 0) {
        if (needsPlacement && normalized.successful && skillIds.length === 0) {
          const failure = await journalSetupFailure(
            auth,
            plan.id,
            leaseToken,
            { ...childAction, step_key: key },
            new AgentOperationError("stale_state", "The completed child operation did not expose a skill to place."),
          );
          recordAction(failure);
          continue;
        }
        const journaled = await journalSetupAction(auth, plan.id, leaseToken, { ...childAction, step_key: key });
        recordAction(journaled);
        continue;
      }

      const previousPlacement = actions.get(key);
      let placementBaseline =
        previousPlacement &&
        previousPlacement.placement_baseline &&
        typeof previousPlacement.placement_baseline === "object" &&
        !Array.isArray(previousPlacement.placement_baseline)
          ? previousPlacement.placement_baseline as Record<string, unknown>
          : null;
      if (!placementBaseline) {
        const skills = await getPrisma().skill.findMany({
          where: { userId: auth.userId, id: { in: skillIds } },
          select: { id: true, collectionId: true },
        });
        if (skills.length !== skillIds.length) {
          throw new AgentOperationError("skill_not_found", "A completed child operation returned a missing skill.");
        }
        placementBaseline = Object.fromEntries(
          skills.map((item) => [item.id, item.collectionId]),
        );
        const pending = await journalSetupAction(auth, plan.id, leaseToken, {
          ...childAction,
          status: "pending",
          placement_pending: true,
          placement_baseline: placementBaseline,
          step_key: key,
        });
        recordAction(pending);
      }

      try {
        const placement = await runAtomicSetupStep(
          auth,
          ["setup:write", "skills:write"],
          plan.id,
          leaseToken,
          key,
          async (tx) => {
            const currentSkills = await tx.skill.findMany({
              where: { userId: auth.userId, id: { in: skillIds } },
              select: { id: true, collectionId: true },
            });
            if (
              currentSkills.length !== skillIds.length ||
              currentSkills.some((item) =>
                String(item.collectionId) !== String(placementBaseline?.[item.id] ?? null),
              )
            ) {
              throw new AgentOperationError("stale_state", "A created skill moved before setup could place it.");
            }
            let collectionId = resolveSetupCollectionId(skill, actions);
            if (skill.kind === "create_material" && !collectionId && skill.collection !== undefined) {
              const collection = await tx.collection.findFirst({
                where: {
                  userId: auth.userId,
                  status: "ACTIVE",
                  OR: [{ id: skill.collection }, { name: skill.collection }],
                },
                select: { id: true },
              });
              if (!collection) throw new AgentOperationError("collection_not_found", "The material skills destination collection was not found.");
              collectionId = collection.id;
            }
            if (!collectionId) throw new AgentOperationError("collection_not_found", "The setup collection reference was not created successfully.");
            const updated = await batchUpdateAgentSkills(
              auth,
              { skill_ids: skillIds, collection_id: collectionId },
              tx,
            );
            if (updated.status !== "updated") {
              throw new AgentOperationError("stale_state", "The created skills changed before setup could place them.");
            }
            return { ...childAction, placement: updated, placement_baseline: placementBaseline };
          },
        );
        recordAction(placement);
      } catch (error) {
        if (error instanceof SetupLeaseLostError) throw error;
        const failure = await journalSetupFailure(
          auth,
          plan.id,
          leaseToken,
          { ...childAction, placement_baseline: placementBaseline, step_key: key },
          error,
        );
        recordAction(failure);
      }
    } catch (error) {
      if (error instanceof SetupLeaseLostError) throw error;
      const failure = await journalSetupFailure(auth, plan.id, leaseToken, { ...base, step_key: key }, error);
      recordAction(failure);
    }
  }

  if (input.practice && !priorAction("practice")) {
    await runAndRecord("practice", { kind: "practice" }, async () => {
      const changes = Object.fromEntries(
        Object.entries({
          practicePreference: input.practice?.practice_preference,
          mixedReview: input.practice?.mixed_review,
          dailyNewSkillLimit: input.practice?.daily_new_skill_limit,
          practiceTimezone: input.practice?.practice_timezone,
          desiredRetention: input.practice?.desired_retention,
          practiceDayStartMinutes: input.practice?.practice_day_start_minutes,
        }).filter(([, value]) => value !== undefined),
      );
      return runAtomicSetupStep(
        auth,
        ["setup:write", "practice:write"],
        plan.id,
        leaseToken,
        "practice",
        async (tx) => ({
          kind: "practice",
          status: "saved",
          result: await updateAgentPracticeSettings(
            auth,
            { target: { scope: "user" }, changes },
            tx,
          ),
        }),
      );
    });
  }

  if (input.reminders && !priorAction("reminders")) {
    await runAndRecord("reminders", { kind: "reminders" }, async () => {
      const changes = Object.fromEntries(
        Object.entries({
          enabled: input.reminders?.enabled,
          email: input.reminders?.email,
          local_hour: input.reminders?.local_hour,
          timezone: input.reminders?.timezone,
          minimum_due_count: input.reminders?.minimum_due_count,
        }).filter(([, value]) => value !== undefined),
      );
      return runAtomicSetupStep(
        auth,
        ["setup:write", "reminders:write"],
        plan.id,
        leaseToken,
        "reminders",
        async (tx) => ({
          kind: "reminders",
          status: "saved",
          result: await updateAgentReminders(auth, { changes }, tx),
        }),
      );
    });
  }

  const allActions = [...actions.values()];
  const counts = countProgressActions(allActions);
  const hasPartialAction = allActions.some((action) => action.status === "partial");
  const status = allActions.length === 0
    ? "succeeded"
    : hasPartialAction || counts.failed > 0 && counts.failed < allActions.length || counts.pending > 0
        ? "partial"
        : counts.failed === allActions.length
          ? "failed"
          : "succeeded";
  return {
    status,
    pending_count: counts.pending,
    failed_count: counts.failed,
    actions: allActions,
    retryable: counts.pending > 0 || counts.failed > 0,
  };
}

export function publicSetupError(error: unknown) {
  if (error instanceof AgentOperationError) return { code: error.code, message: error.message };
  return { code: "internal_error", message: PUBLIC_SETUP_UNEXPECTED_ERROR };
}

async function finishSetupPlan(
  auth: AgentAuthContext,
  planId: string,
  leaseToken: string,
  result: SetupResult,
) {
  return getPrisma().$transaction(async (tx) =>
    withAgentMutation(
      auth,
      "setup:write",
      async (guardedTx) => {
        const current = await guardedTx.agentSetupPlan.findFirst({ where: { id: planId, userId: auth.userId, connectionId: auth.connectionId }, select: PLAN_SELECT });
        if (!current) throw new AgentOperationError("setup_not_found", "The setup plan was not found for this connection.");
        await assertSetupLease(guardedTx, planId, leaseToken);
        const status = result.status === "succeeded"
          ? AgentSetupPlanStatus.SUCCEEDED
          : result.status === "failed"
            ? AgentSetupPlanStatus.FAILED
            : AgentSetupPlanStatus.PARTIAL;
        const progress = setupProgress(current.result);
        const updated = await guardedTx.agentSetupPlan.update({
          where: { id: current.id },
          data: {
            status,
            result: jsonValue({
              ...progress,
              actions: Array.isArray(result.actions) ? result.actions : progress.actions,
              pending_count: typeof result.pending_count === "number" ? result.pending_count : 0,
              failed_count: typeof result.failed_count === "number" ? result.failed_count : 0,
              retryable: Boolean(result.retryable),
            }),
            errors: result.failed_count
              ? jsonValue({ code: "partial_failure", message: "Some setup actions failed or remain pending." })
              : Prisma.DbNull,
          },
          select: PLAN_SELECT,
        });
        return publicPlan(updated);
      },
      tx,
    ),
  );
}

export async function applyAgentSetup(
  auth: AgentAuthContext,
  rawInput: unknown,
): Promise<SetupResult> {
  const input = agentSetupApplySchema.parse(rawInput);
  const claim = await claimSetupPlan(auth, input.plan_id);
  if (!claim.claimed) return publicPlan(claim.plan);
  try {
    const result = await applySetupActions(auth, claim.plan, claim.leaseToken);
    return await finishSetupPlan(auth, input.plan_id, claim.leaseToken, result);
  } catch (error) {
    if (!(error instanceof SetupLeaseLostError)) throw error;
    const current = await getPrisma().agentSetupPlan.findFirst({
      where: { id: input.plan_id, userId: auth.userId, connectionId: auth.connectionId },
      select: PLAN_SELECT,
    });
    if (!current) throw new AgentOperationError("setup_not_found", "The setup plan was not found for this connection.");
    return publicPlan(current);
  }
}

export async function getAgentSetupPlan(
  auth: AgentAuthContext,
  rawInput: unknown,
): Promise<SetupResult> {
  const input = agentSetupGetSchema.parse(rawInput);
  await authorizeAgentRead(auth, "setup:read");
  const plan = await getPrisma().agentSetupPlan.findFirst({ where: { id: input.plan_id, userId: auth.userId, connectionId: auth.connectionId }, select: PLAN_SELECT });
  if (!plan) throw new AgentOperationError("setup_not_found", "The setup plan was not found for this connection.");
  return publicPlan(plan);
}
