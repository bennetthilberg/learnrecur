import "server-only";

import { z } from "zod";

import { inngest } from "./client";

export const CHOICE_REFILL_REQUESTED_EVENT = "learnrecur/choice-refill.requested";
export const EXACT_INPUT_REFILL_REQUESTED_EVENT = "learnrecur/exact-input-refill.requested";

const refillEventPayloadSchema = z.strictObject({
  userId: z.string().trim().min(1),
  skillId: z.string().trim().min(1),
  generationJobId: z.string().trim().min(1),
  targetReadyCount: z.number().int().positive().max(50),
  requestedAt: z.string().trim().min(1),
});

export type ExerciseRefillEventPayload = z.infer<typeof refillEventPayloadSchema>;

export type ExerciseRefillEventSender = {
  sendChoiceRefillRequested(payload: ExerciseRefillEventPayload): Promise<void>;
  sendExactInputRefillRequested(payload: ExerciseRefillEventPayload): Promise<void>;
};

export function parseExerciseRefillEventPayload(input: unknown): ExerciseRefillEventPayload {
  return refillEventPayloadSchema.parse(input);
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
};
