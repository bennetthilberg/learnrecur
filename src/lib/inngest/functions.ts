import "server-only";

import { NonRetriableError } from "inngest";

import {
  parseExerciseRefillEventPayload,
  parseMaterialCleanupEventPayload,
  parseMaterialDraftItemEventPayload,
  parseMaterialIngestionEventPayload,
  parseSourceUploadDraftEventPayload,
} from "@/lib/inngest/events";
import {
  MaterialIngestionError,
  runMaterialIngestionJob,
} from "@/lib/materials/ingestion";
import { runMaterialCleanupJob } from "@/lib/materials/cleanup";
import {
  MaterialDraftGenerationError,
  runMaterialDraftItemJob,
} from "@/lib/materials/batches";
import {
  processDueReminderBatch,
  resolveClerkReminderAccountEmail,
} from "@/lib/reminders";
import {
  runChoiceExerciseRefillJob,
  runExactInputExerciseRefillJob,
  runMathExerciseRefillJob,
} from "@/lib/skills/refill-jobs";
import { runQueuedSourceUploadDraftJob } from "@/lib/skills/uploads";

import {
  CHOICE_REFILL_REQUESTED_EVENT,
  EXACT_INPUT_REFILL_REQUESTED_EVENT,
  MATH_REFILL_REQUESTED_EVENT,
  MATERIAL_CLEANUP_REQUESTED_EVENT,
  MATERIAL_DRAFT_ITEM_REQUESTED_EVENT,
  MATERIAL_INGESTION_REQUESTED_EVENT,
  SOURCE_UPLOAD_DRAFT_REQUESTED_EVENT,
} from "./events";
import { inngest } from "./client";

export const choiceExerciseRefillFunction = inngest.createFunction(
  {
    id: "choice-exercise-refill",
    triggers: [{ event: CHOICE_REFILL_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const payload = parseExerciseRefillEventPayload(event.data);

    return step.run("refill choice exercises", () =>
      runChoiceExerciseRefillJob({
        ...payload,
        now: new Date(),
      }),
    );
  },
);

export const exactInputExerciseRefillFunction = inngest.createFunction(
  {
    id: "exact-input-exercise-refill",
    triggers: [{ event: EXACT_INPUT_REFILL_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const payload = parseExerciseRefillEventPayload(event.data);

    return step.run("refill exact-input exercises", () =>
      runExactInputExerciseRefillJob({
        ...payload,
        now: new Date(),
      }),
    );
  },
);

export const mathExerciseRefillFunction = inngest.createFunction(
  {
    id: "math-exercise-refill",
    triggers: [{ event: MATH_REFILL_REQUESTED_EVENT }],
  },
  async ({ event, step }) => {
    const payload = parseExerciseRefillEventPayload(event.data);

    return step.run("refill math exercises", () =>
      runMathExerciseRefillJob({
        ...payload,
        now: new Date(),
      }),
    );
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
  async ({ event, step }) => {
    const payload = parseMaterialDraftItemEventPayload(event.data);
    try {
      return await step.run("generate and verify material skill draft", () =>
        runMaterialDraftItemJob(payload),
      );
    } catch (error) {
      if (error instanceof MaterialDraftGenerationError && !error.retryable) {
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

export const learnRecurInngestFunctions = [
  choiceExerciseRefillFunction,
  exactInputExerciseRefillFunction,
  mathExerciseRefillFunction,
  sourceUploadDraftFunction,
  materialIngestionFunction,
  materialCleanupFunction,
  materialDraftItemFunction,
  duePracticeReminderFunction,
];
