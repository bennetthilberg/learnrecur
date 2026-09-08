import { z } from "zod";

export const DEFAULT_DESIRED_RETENTION = 0.9;

// FSRS accepts any value in (0, 1], but the product deliberately keeps this
// control in a practical range so a mistaken setting cannot create extreme
// schedules. null means that the learner uses the ts-fsrs default.
export const desiredRetentionSchema = z
  .number()
  .finite()
  .min(0.7)
  .max(0.99)
  .nullable();

export function resolveDesiredRetention(value: number | null | undefined): number {
  if (value === null || value === undefined) {
    return DEFAULT_DESIRED_RETENTION;
  }

  return desiredRetentionSchema.unwrap().parse(value);
}
