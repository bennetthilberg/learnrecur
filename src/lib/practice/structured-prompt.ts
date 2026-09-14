import { z } from "zod";

export const structuredPromptSchema = z.strictObject({
  instruction: z.string().trim().max(300),
  content: z.string().trim().min(1).max(1200),
});
export type StructuredPrompt = z.infer<typeof structuredPromptSchema>;

export function composeStructuredPrompt(parts: StructuredPrompt): string {
  return parts.instruction ? `${parts.instruction}\n\n${parts.content}` : parts.content;
}

/** Only display parts that reproduce the question the verifier actually saw. */
export function readStructuredPrompt(prompt: string, value: unknown): StructuredPrompt | null {
  const parsed = structuredPromptSchema.safeParse(value);
  if (!parsed.success || composeStructuredPrompt(parsed.data) !== prompt) return null;
  return parsed.data;
}

/** Adapt the new generator shape to the existing verification contracts. */
export function normalizeGeneratedPrompt(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const candidate = value as Record<string, unknown>;
  if (!("instruction" in candidate) && !("content" in candidate)) return value;
  const parsed = structuredPromptSchema.safeParse({ instruction: candidate.instruction, content: candidate.content });
  if (!parsed.success) return value; // Leave malformed input for the strict candidate schema to reject.
  const prompt = composeStructuredPrompt(parsed.data);
  if ("prompt" in candidate && candidate.prompt !== prompt) return value;
  const rest = { ...candidate };
  delete rest.instruction;
  delete rest.content;
  return { ...rest, prompt, promptLayout: parsed.data };
}

/** Read only display metadata; never send the rest of generation metadata to clients. */
export function readStoredPromptLayout(prompt: string, metadata: unknown): StructuredPrompt | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  return readStructuredPrompt(prompt, (metadata as Record<string, unknown>).promptLayout);
}
