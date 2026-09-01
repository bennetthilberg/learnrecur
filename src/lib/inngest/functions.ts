import "server-only";

import { NonRetriableError } from "inngest";

import {
  parseExerciseRefillEventPayload,
  parseMaterialBatchActivationEventPayload,
  parseMaterialCleanupEventPayload,
  parseMaterialDraftItemEventPayload,
  parseMaterialIngestionEventPayload,
  parseSourceUploadDraftEventPayload,
  parseAgentSkillOperationEventPayload,
  parseAgentConnectionRevocationEventPayload,
} from "@/lib/inngest/events";
import {
  runAgentAccessMaintenance,
  runAgentConnectionRevocationJob,
} from "@/lib/agent-access/settings";
import { AgentSkillWorkerError, runAgentSkillOperationJob } from "@/lib/agent-access/worker";
import {
  MaterialIngestionError,
  runMaterialIngestionJob,
} from "@/lib/materials/ingestion";
import { runMaterialCleanupJob } from "@/lib/materials/cleanup";
import {
  MaterialBatchActivationError,
  MaterialDraftGenerationError,
  runMaterialBatchActivationJob,
  runMaterialDraftItemJob,
} from "@/lib/materials/batches";
import {
  processDueReminderBatch,
  resolveClerkReminderAccountEmail,
} from "@/lib/reminders";
import {
  markRefillJobRetryableFailure,
  runChoiceExerciseRefillJob,
  runExactInputExerciseRefillJob,
  runMathExerciseRefillJob,
} from "@/lib/skills/refill-jobs";
import { REFILL_JOB_RETRY_LIMIT } from "@/lib/skills/refill-policy";
import { runQueuedSourceUploadDraftJob } from "@/lib/skills/uploads";

import {
  CHOICE_REFILL_REQUESTED_EVENT,
  EXACT_INPUT_REFILL_REQUESTED_EVENT,
  MATH_REFILL_REQUESTED_EVENT,
  MATERIAL_BATCH_ACTIVATION_REQUESTED_EVENT,
  MATERIAL_CLEANUP_REQUESTED_EVENT,
  MATERIAL_DRAFT_ITEM_REQUESTED_EVENT,
  MATERIAL_INGESTION_REQUESTED_EVENT,
  SOURCE_UPLOAD_DRAFT_REQUESTED_EVENT,
  AGENT_SKILL_OPERATION_REQUESTED_EVENT,
  AGENT_CONNECTION_REVOCATION_REQUESTED_EVENT,
} from "./events";
import { inngest } from "./client";

async function markRefillFailureBestEffort(
  input: Parameters<typeof markRefillJobRetryableFailure>[0],
) {
  try {
    await markRefillJobRetryableFailure(input);
  } catch (markError) {
    console.error("[inngest] refill failure marking failed", {
      error: markError instanceof Error ? markError.message : String(markError),
    });
  }
}

export const choiceExerciseRefillFunction = inngest.createFunction(
  {
    id: "choice-exercise-refill",
    retries: REFILL_JOB_RETRY_LIMIT,
    concurrency: { limit: 1, key: "event.data.skillId", scope: "env" },
    triggers: [{ event: CHOICE_REFILL_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const payload = parseExerciseRefillEventPayload(event.data);

    return step.run("refill choice exercises", async () => {
      try {
        return await runChoiceExerciseRefillJob({ ...payload, now: new Date() });
      } catch (error) {
        await markRefillFailureBestEffort({ ...payload, now: new Date(), error });
        throw error;
      }
    });
  },
);

export const exactInputExerciseRefillFunction = inngest.createFunction(
  {
    id: "exact-input-exercise-refill",
    retries: REFILL_JOB_RETRY_LIMIT,
    concurrency: { limit: 1, key: "event.data.skillId", scope: "env" },
    triggers: [{ event: EXACT_INPUT_REFILL_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const payload = parseExerciseRefillEventPayload(event.data);

    return step.run("refill exact-input exercises", async () => {
      try {
        return await runExactInputExerciseRefillJob({ ...payload, now: new Date() });
      } catch (error) {
        await markRefillFailureBestEffort({ ...payload, now: new Date(), error });
        throw error;
      }
    });
  },
);

export const mathExerciseRefillFunction = inngest.createFunction(
  {
    id: "math-exercise-refill",
    retries: REFILL_JOB_RETRY_LIMIT,
    concurrency: { limit: 1, key: "event.data.skillId", scope: "env" },
    triggers: [{ event: MATH_REFILL_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const payload = parseExerciseRefillEventPayload(event.data);

    return step.run("refill math exercises", async () => {
      try {
        return await runMathExerciseRefillJob({ ...payload, now: new Date() });
      } catch (error) {
        await markRefillFailureBestEffort({ ...payload, now: new Date(), error });
        throw error;
      }
    });
  },
);

export const sourceUploadDraftFunction = inngest.createFunction(
  {
    id: "source-upload-draft",
    triggers: [{ event: SOURCE_UPLOAD_DRAFT_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const payload = parseSourceUploadDraftEventPayload(event.data);

    return step.run("create source-backed drafts", () =>
      runQueuedSourceUploadDraftJob({
        ...payload,
        now: new Date(),
      }),
    );
  },
);

export const materialIngestionFunction = inngest.createFunction(
  {
    id: "material-ingestion",
    retries: 3,
    concurrency: { limit: 1, key: "event.data.userId" },
    triggers: [{ event: MATERIAL_INGESTION_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const payload = parseMaterialIngestionEventPayload(event.data);

    try {
      return await step.run("ingest material revision", () =>
        runMaterialIngestionJob({
          userId: payload.userId,
          materialRevisionId: payload.materialRevisionId,
        }),
      );
    } catch (error) {
      if (error instanceof MaterialIngestionError && !error.retryable) {
        throw new NonRetriableError(error.message, { cause: error });
      }
      throw error;
    }
  },
);

export const materialCleanupFunction = inngest.createFunction(
  {
    id: "material-cleanup",
    retries: 3,
    concurrency: { limit: 1, key: "event.data.userId" },
    triggers: [{ event: MATERIAL_CLEANUP_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const payload = parseMaterialCleanupEventPayload(event.data);
    return step.run("delete material objects and derived data", () =>
      runMaterialCleanupJob(payload),
    );
  },
);

export const materialDraftItemFunction = inngest.createFunction(
  {
    id: "material-draft-item",
    retries: 3,
    concurrency: { limit: 2, key: "event.data.userId" },
    triggers: [{ event: MATERIAL_DRAFT_ITEM_REQUESTED_EVENT }],
  },
  async ({ event, step, attempt, maxAttempts }) => {
    const payload = parseMaterialDraftItemEventPayload(event.data);
    try {
      return await step.run("generate and verify material skill draft", () =>
        runMaterialDraftItemJob({
          ...payload,
          attempt,
          maxAttempts: maxAttempts ?? 4,
        }),
      );
    } catch (error) {
      if (error instanceof MaterialDraftGenerationError && !error.retryable) {
        throw new NonRetriableError(error.message, { cause: error });
      }
      throw error;
    }
  },
);

export const materialBatchActivationFunction = inngest.createFunction(
  {
    id: "material-batch-activation",
    retries: 3,
    concurrency: { limit: 2, key: "event.data.userId" },
    triggers: [{ event: MATERIAL_BATCH_ACTIVATION_REQUESTED_EVENT }],
  },
  async ({ event, step, attempt, maxAttempts }) => {
    const payload = parseMaterialBatchActivationEventPayload(event.data);
    try {
      return await step.run("activate one material skill", () =>
        runMaterialBatchActivationJob({
          ...payload,
          attempt,
          maxAttempts: maxAttempts ?? 4,
        }),
      );
    } catch (error) {
      if (error instanceof MaterialBatchActivationError && !error.retryable) {
        throw new NonRetriableError(error.message, { cause: error });
      }
      throw error;
    }
  },
);

export const duePracticeReminderFunction = inngest.createFunction(
  {
    id: "due-practice-reminders",
    triggers: [{ cron: "0 * * * *" }],
  },
  async ({ step }) =>
    step.run("send due practice reminders", () =>
      processDueReminderBatch({
        accountEmailResolver: resolveClerkReminderAccountEmail,
        now: new Date(),
      }),
    ),
);

export const agentSkillOperationFunction = inngest.createFunction(
  {
    id: "agent-skill-operation",
    retries: 3,
    concurrency: { limit: 1, key: "event.data.userId" },
    triggers: [{ event: AGENT_SKILL_OPERATION_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const payload = parseAgentSkillOperationEventPayload(event.data);
    try {
      return await step.run("process agent skill operation", () =>
        runAgentSkillOperationJob(payload),
      );
    } catch (error) {
      if (error instanceof AgentSkillWorkerError && !error.retryable) {
        throw new NonRetriableError(error.message, { cause: error });
      }
      throw error;
    }
  },
);

export const agentConnectionRevocationFunction = inngest.createFunction(
  {
    id: "agent-connection-revocation",
    retries: 3,
    concurrency: { limit: 1, key: "event.data.userId" },
    triggers: [{ event: AGENT_CONNECTION_REVOCATION_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const payload = parseAgentConnectionRevocationEventPayload(event.data);
    return step.run("revoke WorkOS authorized application", () =>
      runAgentConnectionRevocationJob(payload),
    );
  },
);

export const agentAccessMaintenanceFunction = inngest.createFunction(
  {
    id: "agent-access-maintenance",
    retries: 2,
    triggers: [{ cron: "*/5 * * * *" }],
  },
  async ({ step }) =>
    step.run("purge agent payloads and retry revocations", () =>
      runAgentAccessMaintenance(new Date()),
    ),
);

export const learnRecurInngestFunctions = [
  choiceExerciseRefillFunction,
  exactInputExerciseRefillFunction,
  mathExerciseRefillFunction,
  sourceUploadDraftFunction,
  materialIngestionFunction,
  materialCleanupFunction,
  materialDraftItemFunction,
  materialBatchActivationFunction,
  agentSkillOperationFunction,
  agentConnectionRevocationFunction,
  agentAccessMaintenanceFunction,
  duePracticeReminderFunction,
];
