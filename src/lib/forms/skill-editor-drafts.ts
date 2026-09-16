import { z } from "zod";

export const skillEditorDraftSchema = z.object({
  title: z.string().max(10_000), objective: z.string().max(100_000),
  collectionName: z.string().max(10_000), tags: z.string().max(10_000),
  rules: z.string().max(100_000), examples: z.string().max(100_000),
  exerciseConstraints: z.string().max(100_000), alreadyStudied: z.boolean().optional(),
});
