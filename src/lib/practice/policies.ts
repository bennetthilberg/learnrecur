import { z } from "zod";

export const practicePreferenceSchema = z.enum(["BALANCED", "RECALL_FIRST"]);
export type PracticePreference = z.infer<typeof practicePreferenceSchema>;
export const practicePreferenceOverrideSchema =
  practicePreferenceSchema.nullable();

export function resolvePracticePreference(input: {
  skill?: PracticePreference | null;
  collection?: PracticePreference | null;
  user?: PracticePreference | null;
}): PracticePreference {
  return input.skill ?? input.collection ?? input.user ?? "BALANCED";
}

// No locale is inferred from UI language or the skill title. Explicit accepted
// alternatives, rather than blanket accent folding, express limited equivalence.
export const textPolicySchema = z
  .strictObject({
    version: z.literal(2),
    profile: z.enum(["NATURAL", "EXACT", "CUSTOM"]),
    normalizeCase: z.boolean(),
    normalizeWhitespace: z.boolean(),
  })
  .superRefine((policy, context) => {
    if (
      (policy.profile === "NATURAL" &&
        (!policy.normalizeCase || !policy.normalizeWhitespace)) ||
      (policy.profile === "EXACT" &&
        (policy.normalizeCase || policy.normalizeWhitespace))
    ) {
      context.addIssue({
        code: "custom",
        message: "Use Custom to change the named profile's comparison rules.",
      });
    }
  });
export type TextPolicy = z.infer<typeof textPolicySchema>;
export const NATURAL_TEXT_POLICY: TextPolicy = {
  version: 2,
  profile: "NATURAL",
  normalizeCase: true,
  normalizeWhitespace: true,
};
export const EXACT_TEXT_POLICY: TextPolicy = {
  version: 2,
  profile: "EXACT",
  normalizeCase: false,
  normalizeWhitespace: false,
};

export function resolveTextPolicy(input: {
  skill?: unknown;
  collection?: unknown;
}): TextPolicy {
  return textPolicySchema.parse(
    input.skill ?? input.collection ?? NATURAL_TEXT_POLICY,
  );
}

export function textAnswerContract(accepted: string[], policy: TextPolicy) {
  const parsed = textPolicySchema.parse(policy);
  return {
    kind: "text" as const,
    policyVersion: 2 as const,
    accepted,
    normalizeCase: parsed.normalizeCase,
    normalizeWhitespace: parsed.normalizeWhitespace,
    normalizeDiacritics: false,
  };
}

export function matchesTextPolicy(
  answerSpec: unknown,
  policy: TextPolicy,
): boolean {
  if (!answerSpec || typeof answerSpec !== "object") return false;
  const spec = answerSpec as Record<string, unknown>;
  return (
    spec.kind === "text" &&
    spec.policyVersion === policy.version &&
    spec.normalizeDiacritics === false &&
    spec.normalizeCase === policy.normalizeCase &&
    spec.normalizeWhitespace === policy.normalizeWhitespace
  );
}

export const practiceContextSchema = z
  .strictObject({
    version: z.literal(1),
    answerMode: z.enum(["CHOICE", "TEXT", "NUMERIC", "MATH"]),
    mixedReview: z.boolean(),
    reducedRuleCues: z.boolean(),
    assistance: z.enum(["none", "observed"]),
  })
  .refine(
    (value) => !value.reducedRuleCues || value.mixedReview,
    "Reduced rule cues require mixed review.",
  );
