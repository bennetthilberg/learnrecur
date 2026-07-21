import "server-only";

import { z } from "zod";

import { inngest } from "./client";

export const CHOICE_REFILL_REQUESTED_EVENT = "learnrecur/choice-refill.requested";
export const EXACT_INPUT_REFILL_REQUESTED_EVENT = "learnrecur/exact-input-refill.requested";
export const MATH_REFILL_REQUESTED_EVENT = "learnrecur/math-refill.requested";
export const SOURCE_UPLOAD_DRAFT_REQUESTED_EVENT =
  "learnrecur/source-upload-draft.requested";
export const MATERIAL_INGESTION_REQUESTED_EVENT = "learnrecur/material-ingestion.requested";
export const MATERIAL_CLEANUP_REQUESTED_EVENT = "learnrecur/material-cleanup.requested";
export const MATERIAL_DRAFT_ITEM_REQUESTED_EVENT = "learnrecur/material-draft-item.requested";
export const MATERIAL_BATCH_ACTIVATION_REQUESTED_EVENT =
  "learnrecur/material-batch-activation.requested";

const refillEventPayloadSchema = z.strictObject({
  userId: z.string().trim().min(1),
  skillId: z.string().trim().min(1),
  generationJobId: z.string().trim().min(1),
  targetReadyCount: z.number().int().positive().max(50),
  requestedAt: z.string().trim().min(1),
});

const sourceUploadDraftEventPayloadSchema = z.strictObject({
  userId: z.string().trim().min(1),
  sourceFileId: z.string().trim().min(1),
  requestedAt: z.string().trim().min(1),
});

const materialIngestionEventPayloadSchema = z.strictObject({
  userId: z.string().trim().min(1),
  materialRevisionId: z.string().trim().min(1),
  requestedAt: z.string().trim().min(1),
});

const materialCleanupEventPayloadSchema = z.strictObject({
  userId: z.string().trim().min(1),
  materialId: z.string().trim().min(1),
  cleanupJobId: z.string().trim().min(1),
  requestedAt: z.string().trim().min(1),
});

const materialDraftItemEventPayloadSchema = z.strictObject({
  userId: z.string().trim().min(1),
  batchId: z.string().trim().min(1),
  itemId: z.string().trim().min(1),
  requestedAt: z.string().trim().min(1),
});

const materialBatchActivationEventPayloadSchema = z.strictObject({
  userId: z.string().trim().min(1),
  batchId: z.string().trim().min(1),
  itemId: z.string().trim().min(1),
  generationJobId: z.string().trim().min(1),
  requestedAt: z.string().trim().min(1),
});

export type ExerciseRefillEventPayload = z.infer<typeof refillEventPayloadSchema>;
export type SourceUploadDraftEventPayload = z.infer<
  typeof sourceUploadDraftEventPayloadSchema
>;
export type MaterialIngestionEventPayload = z.infer<
  typeof materialIngestionEventPayloadSchema
>;
export type MaterialCleanupEventPayload = z.infer<typeof materialCleanupEventPayloadSchema>;
export type MaterialDraftItemEventPayload = z.infer<typeof materialDraftItemEventPayloadSchema>;
export type MaterialBatchActivationEventPayload = z.infer<
  typeof materialBatchActivationEventPayloadSchema
>;

export type ExerciseRefillEventSender = {
  sendChoiceRefillRequested(payload: ExerciseRefillEventPayload): Promise<void>;
  sendExactInputRefillRequested(payload: ExerciseRefillEventPayload): Promise<void>;
  sendMathRefillRequested(payload: ExerciseRefillEventPayload): Promise<void>;
};

export type SourceUploadDraftEventSender = {
  sendSourceUploadDraftRequested(payload: SourceUploadDraftEventPayload): Promise<void>;
};

export type MaterialIngestionEventSender = {
  sendMaterialIngestionRequested(payload: MaterialIngestionEventPayload): Promise<void>;
};

export type MaterialCleanupEventSender = {
  sendMaterialCleanupRequested(payload: MaterialCleanupEventPayload): Promise<void>;
};

export type MaterialDraftItemEventSender = {
  sendMaterialDraftItemRequested(payload: MaterialDraftItemEventPayload): Promise<void>;
};

export type MaterialBatchActivationEventSender = {
  sendMaterialBatchActivationRequested(
    payload: MaterialBatchActivationEventPayload,
  ): Promise<void>;
};

export function parseExerciseRefillEventPayload(input: unknown): ExerciseRefillEventPayload {
  return refillEventPayloadSchema.parse(input);
}

export function parseSourceUploadDraftEventPayload(
  input: unknown,
): SourceUploadDraftEventPayload {
  return sourceUploadDraftEventPayloadSchema.parse(input);
}

export function parseMaterialIngestionEventPayload(
  input: unknown,
): MaterialIngestionEventPayload {
  return materialIngestionEventPayloadSchema.parse(input);
}

export function parseMaterialCleanupEventPayload(input: unknown): MaterialCleanupEventPayload {
  return materialCleanupEventPayloadSchema.parse(input);
}

export function parseMaterialDraftItemEventPayload(input: unknown): MaterialDraftItemEventPayload {
  return materialDraftItemEventPayloadSchema.parse(input);
}

export function parseMaterialBatchActivationEventPayload(
  input: unknown,
): MaterialBatchActivationEventPayload {
  return materialBatchActivationEventPayloadSchema.parse(input);
}

export const inngestExerciseRefillEventSender: ExerciseRefillEventSender = {
  async sendChoiceRefillRequested(payload) {
    await inngest.send({
      name: CHOICE_REFILL_REQUESTED_EVENT,
      data: payload,
    });
  },
  async sendExactInputRefillRequested(payload) {
    await inngest.send({
      name: EXACT_INPUT_REFILL_REQUESTED_EVENT,
      data: payload,
    });
  },
  async sendMathRefillRequested(payload) {
    await inngest.send({
      name: MATH_REFILL_REQUESTED_EVENT,
      data: payload,
    });
  },
};

export const inngestSourceUploadDraftEventSender: SourceUploadDraftEventSender = {
  async sendSourceUploadDraftRequested(payload) {
    await inngest.send({
      name: SOURCE_UPLOAD_DRAFT_REQUESTED_EVENT,
      data: payload,
    });
  },
};

export const inngestMaterialIngestionEventSender: MaterialIngestionEventSender = {
  async sendMaterialIngestionRequested(payload) {
    await inngest.send({
      name: MATERIAL_INGESTION_REQUESTED_EVENT,
      data: payload,
    });
  },
};

export const inngestMaterialCleanupEventSender: MaterialCleanupEventSender = {
  async sendMaterialCleanupRequested(payload) {
    await inngest.send({
      name: MATERIAL_CLEANUP_REQUESTED_EVENT,
      data: payload,
    });
  },
};

export const inngestMaterialDraftItemEventSender: MaterialDraftItemEventSender = {
  async sendMaterialDraftItemRequested(payload) {
    await inngest.send({
      name: MATERIAL_DRAFT_ITEM_REQUESTED_EVENT,
      data: payload,
    });
  },
};

export const inngestMaterialBatchActivationEventSender: MaterialBatchActivationEventSender = {
  async sendMaterialBatchActivationRequested(payload) {
    await inngest.send({
      name: MATERIAL_BATCH_ACTIVATION_REQUESTED_EVENT,
      data: payload,
    });
  },
};
