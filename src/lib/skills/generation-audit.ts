import { z } from "zod";

export const GENERATION_AUDIT_METADATA_VERSION = 1 as const;
export const CONTEXT_MANIFEST_VERSION = 1 as const;

// Audit records are operational evidence, not a second copy of a model request.
// Keep the envelope small enough for ordinary row reads and reject oversize data.
export const MAX_GENERATION_AUDIT_METADATA_BYTES = 32 * 1024;
export const MAX_GENERATION_AUDIT_CONTEXT_MANIFEST_BYTES = 8 * 1024;
export const MAX_GENERATION_AUDIT_LIST_ENTRIES = 128;
export const MAX_GENERATION_AUDIT_MEDIA_ITEMS = 32;
export const MAX_GENERATION_AUDIT_SELECTED_EVIDENCE = 1_000;

const MAX_IDENTIFIER_LENGTH = 200;
const MAX_VERSION_LENGTH = 120;
const MAX_REASON_CODE_LENGTH = 80;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

const safeTokenSchema = (maximum: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(maximum)
    .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
      message: "Audit identifiers cannot contain control characters.",
    })
    .refine((value) => !/\s/.test(value), {
      message: "Audit identifiers cannot contain whitespace.",
    });

const identifierSchema = safeTokenSchema(MAX_IDENTIFIER_LENGTH).refine(
  (value) => /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value),
  { message: "Audit identifiers contain unsupported characters." },
);
const idempotencyKeySchema = identifierSchema.min(8);
const versionSchema = safeTokenSchema(MAX_VERSION_LENGTH);
const reasonCodeSchema = safeTokenSchema(MAX_REASON_CODE_LENGTH).refine(
  (value) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value),
  { message: "Audit reason codes contain unsupported characters." },
);
const hashSchema = z
  .string()
  .trim()
  .regex(HASH_PATTERN, "Audit hashes must be 64 hexadecimal characters.")
  .transform((value) => value.toLowerCase());

const uniqueArray = <T>(schema: z.ZodType<T>, maximum = MAX_GENERATION_AUDIT_LIST_ENTRIES) =>
  z
    .array(schema)
    .max(maximum)
    .superRefine((values, context) => {
      if (new Set(values.map((value) => JSON.stringify(value))).size !== values.length) {
        context.addIssue({
          code: "custom",
          message: "Audit list entries must be unique.",
        });
      }
    });

export const generationJobStageSchema = z.enum([
  "QUEUED",
  "PLANNING",
  "GENERATING",
  "VALIDATING",
  "VERIFYING",
  "ADJUDICATING",
  "PUBLISHING",
  "COMPLETE",
  "FAILED",
]);

export const generationJobStatusSchema = z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]);

export const generationFailureCategorySchema = z.enum([
  "NONE",
  "TRANSPORT",
  "TIMEOUT",
  "RATE_LIMIT",
  "AUTHENTICATION",
  "SCHEMA",
  "DETERMINISTIC",
  "SEMANTIC",
  "SOURCE_EVIDENCE",
  "DUPLICATE",
  "DIVERSITY",
  "COST_LIMIT",
  "CANCELED",
  "UNKNOWN",
]);

export const generationDegradedStateSchema = z.enum([
  "NONE",
  "FALLBACK_ACTIVE",
  "FALLBACK_USED",
  "QUALITY_REPAIR",
  "ADJUDICATION_REQUIRED",
]);

export const generationAuditDecisionSchema = z.enum([
  "IN_PROGRESS",
  "RETRY",
  "ACCEPTED",
  "REJECTED",
  "QUARANTINED",
  "PUBLISHED",
  "FAILED",
]);

export const generationReleaseTupleSchema = z.object({
  releaseId: identifierSchema.optional(),
  provider: identifierSchema,
  model: identifierSchema,
  endpointMode: identifierSchema,
  generationPromptVersion: versionSchema,
  verificationPromptVersion: versionSchema.optional(),
  responseSchemaVersion: versionSchema,
  validatorVersion: versionSchema,
  contextBuilderVersion: versionSchema,
  skillSpecSchemaVersion: versionSchema,
  blueprintVersion: versionSchema.optional(),
  qualityVersion: versionSchema.optional(),
  fingerprint: hashSchema,
});

export type GenerationReleaseTuple = z.infer<typeof generationReleaseTupleSchema>;

const contextSourceKindSchema = z.enum(["none", "pdf", "image", "text", "web", "mixed"]);

export const contextManifestSchema = z
  .object({
    version: z.literal(CONTEXT_MANIFEST_VERSION),
    manifestHash: hashSchema,
    sourceRevisionIds: uniqueArray(identifierSchema).default([]),
    sourceFileIds: uniqueArray(identifierSchema).default([]),
    sectionIds: uniqueArray(identifierSchema).default([]),
    chunkIds: uniqueArray(identifierSchema).default([]),
    pageNumbers: uniqueArray(z.number().int().min(1).max(100_000)).default([]),
    contentHashes: uniqueArray(hashSchema).default([]),
    sourceKind: contextSourceKindSchema,
    mediaCount: z.number().int().min(0).max(MAX_GENERATION_AUDIT_MEDIA_ITEMS).default(0),
    selectedEvidenceCount: z
      .number()
      .int()
      .min(0)
      .max(MAX_GENERATION_AUDIT_SELECTED_EVIDENCE)
      .default(0),
    extractionConfidence: z.number().finite().min(0).max(1).optional(),
    evidenceOmitted: z.boolean().default(false),
  })
  .superRefine((manifest, context) => {
    const hasSourceIdentity =
      manifest.sourceRevisionIds.length > 0 ||
      manifest.sourceFileIds.length > 0 ||
      manifest.sectionIds.length > 0 ||
      manifest.chunkIds.length > 0;

    if (manifest.sourceKind === "none" && hasSourceIdentity) {
      context.addIssue({
        code: "custom",
        path: ["sourceKind"],
        message: "A source-less context manifest cannot contain source identifiers.",
      });
    }

    if (manifest.sourceKind !== "none" && !hasSourceIdentity) {
      context.addIssue({
        code: "custom",
        path: ["sourceRevisionIds"],
        message: "A source-backed context manifest needs a source identifier.",
      });
    }
  });

export type ContextManifest = z.infer<typeof contextManifestSchema>;

const nonNegativeMetric = (maximum: number) => z.number().int().min(0).max(maximum);

export const generationStageMetricsSchema = z
  .object({
    requestedCount: nonNegativeMetric(10_000).default(0),
    candidateCount: nonNegativeMetric(10_000).default(0),
    acceptedCount: nonNegativeMetric(10_000).default(0),
    rejectedCount: nonNegativeMetric(10_000).default(0),
    unfilledSlotCount: nonNegativeMetric(10_000).default(0),
    attemptCount: nonNegativeMetric(100).default(0),
    retryCount: nonNegativeMetric(100).default(0),
    latencyMs: nonNegativeMetric(86_400_000).default(0),
    inputTokens: nonNegativeMetric(10_000_000).default(0),
    outputTokens: nonNegativeMetric(10_000_000).default(0),
    estimatedCostMicros: nonNegativeMetric(10_000_000_000).default(0),
  })
  .superRefine((metrics, context) => {
    if (metrics.acceptedCount > metrics.candidateCount) {
      context.addIssue({
        code: "custom",
        path: ["acceptedCount"],
        message: "Accepted candidates cannot exceed candidate count.",
      });
    }

    if (metrics.rejectedCount > metrics.candidateCount) {
      context.addIssue({
        code: "custom",
        path: ["rejectedCount"],
        message: "Rejected candidates cannot exceed candidate count.",
      });
    }

    if (metrics.unfilledSlotCount > metrics.requestedCount) {
      context.addIssue({
        code: "custom",
        path: ["unfilledSlotCount"],
        message: "Unfilled slots cannot exceed requested count.",
      });
    }
  });

export type GenerationStageMetrics = z.infer<typeof generationStageMetricsSchema>;

export const generationAuditJobSchema = z
  .object({
    jobId: identifierSchema,
    idempotencyKey: idempotencyKeySchema,
    kind: z.enum([
      "SKILL_ACTIVATION",
      "CHOICE_EXERCISE_GENERATION",
      "EXACT_INPUT_EXERCISE_GENERATION",
      "MATH_EXERCISE_GENERATION",
    ]),
    stage: generationJobStageSchema,
    checkpoint: identifierSchema.optional(),
    attempt: z.number().int().min(0).max(100).default(0),
    retryCount: z.number().int().min(0).max(100).default(0),
    maxAttempts: z.number().int().min(1).max(100).default(3),
  })
  .superRefine((job, context) => {
    if (job.attempt > job.maxAttempts) {
      context.addIssue({
        code: "custom",
        path: ["attempt"],
        message: "Attempt count cannot exceed the configured maximum.",
      });
    }
  });

export type GenerationAuditJob = z.infer<typeof generationAuditJobSchema>;

export const generationFailureSchema = z
  .object({
    category: generationFailureCategorySchema,
    code: reasonCodeSchema.optional(),
    retryable: z.boolean(),
  })
  .superRefine((failure, context) => {
    if (failure.category === "NONE" && failure.code !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["code"],
        message: "A successful audit cannot carry a failure code.",
      });
    }
  });

export type GenerationFailure = z.infer<typeof generationFailureSchema>;

export const generationDegradedStateMetadataSchema = z
  .object({
    state: generationDegradedStateSchema,
    fallbackProvider: identifierSchema.optional(),
    fallbackModel: identifierSchema.optional(),
    reasonCode: reasonCodeSchema.optional(),
  })
  .superRefine((degraded, context) => {
    const usesFallback = degraded.state === "FALLBACK_ACTIVE" || degraded.state === "FALLBACK_USED";

    if (usesFallback && (!degraded.fallbackProvider || !degraded.fallbackModel || !degraded.reasonCode)) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "Fallback audit state requires provider, model, and reason code.",
      });
    }

    if (degraded.state === "NONE" && (degraded.fallbackProvider || degraded.fallbackModel || degraded.reasonCode)) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "A non-degraded audit cannot carry fallback details.",
      });
    }
  });

export type GenerationDegradedStateMetadata = z.infer<
  typeof generationDegradedStateMetadataSchema
>;

const provenanceKindSchema = z.enum([
  "SOURCE_DERIVED",
  "PEDAGOGICAL_TRANSFORMATION",
  "VERIFIED_SUPPLEMENT",
  "LEARNER_DECLARED",
  "UNKNOWN",
]);

const provenanceSchema = z
  .object({
    kind: provenanceKindSchema,
    sourceRevisionIds: uniqueArray(identifierSchema).default([]),
    sourceFileIds: uniqueArray(identifierSchema).default([]),
    evidenceAnchorIds: uniqueArray(identifierSchema).default([]),
    contentHashes: uniqueArray(hashSchema).default([]),
  })
  .superRefine((provenance, context) => {
    if (
      provenance.kind === "SOURCE_DERIVED" &&
      provenance.sourceRevisionIds.length === 0 &&
      provenance.sourceFileIds.length === 0 &&
      provenance.evidenceAnchorIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceRevisionIds"],
        message: "Source-derived provenance needs at least one evidence identity.",
      });
    }
  });

const verifierSchema = z.object({
  releaseId: identifierSchema,
  provider: identifierSchema,
  model: identifierSchema,
  decision: z.enum(["ACCEPTED", "REJECTED", "NEEDS_ADJUDICATION"]),
  independentAnswerMatch: z.boolean(),
  premisesConsistent: z.boolean(),
  deterministicChecksPassed: z.boolean(),
  sourceSupported: z.boolean(),
  explanationConsistent: z.boolean(),
  scopeSupported: z.boolean(),
  unambiguous: z.boolean(),
  duplicateFree: z.boolean(),
});

const acceptedCandidateDecisionSchema = z.enum(["PENDING", "ACCEPTED", "REJECTED", "QUARANTINED", "PUBLISHED"]);

const candidateSchema = z
  .object({
    candidateId: identifierSchema,
    exerciseSpecVersion: versionSchema,
    skillSpecVersion: versionSchema,
    skillSpecFingerprint: hashSchema,
    blueprintVersion: versionSchema,
    blueprintSlot: identifierSchema,
    exerciseFamily: identifierSchema,
    qualityVersion: versionSchema,
    provenance: provenanceSchema,
    acceptanceDecision: acceptedCandidateDecisionSchema,
    acceptanceReasonCodes: uniqueArray(reasonCodeSchema, 32).default([]),
    verifier: verifierSchema,
    repairAncestorId: identifierSchema.optional(),
  })
  .superRefine((candidate, context) => {
    const accepted = candidate.acceptanceDecision === "ACCEPTED" || candidate.acceptanceDecision === "PUBLISHED";
    const verifierGates = [
      candidate.verifier.independentAnswerMatch,
      candidate.verifier.premisesConsistent,
      candidate.verifier.deterministicChecksPassed,
      candidate.verifier.sourceSupported,
      candidate.verifier.explanationConsistent,
      candidate.verifier.scopeSupported,
      candidate.verifier.unambiguous,
      candidate.verifier.duplicateFree,
    ];

    if (accepted && (candidate.verifier.decision !== "ACCEPTED" || verifierGates.some((passed) => !passed))) {
      context.addIssue({
        code: "custom",
        path: ["acceptanceDecision"],
        message: "An accepted candidate needs an independently passing verifier record.",
      });
    }

    if (candidate.verifier.decision === "ACCEPTED" && verifierGates.some((passed) => !passed)) {
      context.addIssue({
        code: "custom",
        path: ["verifier"],
        message: "An accepted verifier decision cannot contain a failed quality gate.",
      });
    }
  });

export type GenerationAuditCandidate = z.infer<typeof candidateSchema>;

const decisionSchema = z.object({
  outcome: generationAuditDecisionSchema,
  reasonCodes: uniqueArray(reasonCodeSchema, 32).default([]),
});

export const generationAuditMetadataSchema = z
  .object({
    schemaVersion: z.literal(GENERATION_AUDIT_METADATA_VERSION),
    job: generationAuditJobSchema,
    release: generationReleaseTupleSchema,
    contextManifest: contextManifestSchema,
    stageMetrics: generationStageMetricsSchema,
    candidate: candidateSchema.optional(),
    failure: generationFailureSchema,
    degraded: generationDegradedStateMetadataSchema,
    decision: decisionSchema,
  })
  .superRefine((metadata, context) => {
    if (metadata.decision.outcome === "PUBLISHED") {
      if (!metadata.candidate || !["ACCEPTED", "PUBLISHED"].includes(metadata.candidate.acceptanceDecision)) {
        context.addIssue({
          code: "custom",
          path: ["decision", "outcome"],
          message: "A published audit needs an accepted candidate record.",
        });
      }

      if (metadata.failure.category !== "NONE") {
        context.addIssue({
          code: "custom",
          path: ["failure", "category"],
          message: "A published audit cannot carry a failure category.",
        });
      }
    }
  });

export type GenerationAuditMetadata = z.infer<typeof generationAuditMetadataSchema>;

export type GenerationAuditValidationCode =
  | "invalid_metadata"
  | "metadata_too_large"
  | "invalid_transition";

export class GenerationAuditValidationError extends Error {
  constructor(
    public readonly code: GenerationAuditValidationCode,
    message: string,
    public readonly issues: readonly unknown[] = [],
  ) {
    super(message);
    this.name = "GenerationAuditValidationError";
  }
}

const SENSITIVE_KEY_PATTERN = /^(?:prompt|prompttext|promptbody|fullprompt|rawprompt|source|sourcetext|sourcecontent|sourcematerial|rawsource|rawsourcematerial|content|contenttext|input|inputtext|output|outputtext|raw|secret|credential|authorization|password|apikey|accesstoken|refreshtoken|token)$/;

const SAFE_AUDIT_KEY_NAMES = new Set(
  [
    "schemaVersion",
    "status",
    "job",
    "jobId",
    "idempotencyKey",
    "kind",
    "stage",
    "checkpoint",
    "attempt",
    "retryCount",
    "maxAttempts",
    "release",
    "releaseId",
    "provider",
    "model",
    "endpointMode",
    "generationPromptVersion",
    "verificationPromptVersion",
    "responseSchemaVersion",
    "validatorVersion",
    "contextBuilderVersion",
    "skillSpecSchemaVersion",
    "blueprintVersion",
    "qualityVersion",
    "fingerprint",
    "contextManifest",
    "version",
    "manifestHash",
    "sourceRevisionIds",
    "sourceFileIds",
    "sectionIds",
    "chunkIds",
    "pageNumbers",
    "contentHashes",
    "sourceKind",
    "mediaCount",
    "selectedEvidenceCount",
    "extractionConfidence",
    "evidenceOmitted",
    "stageMetrics",
    "requestedCount",
    "candidateCount",
    "acceptedCount",
    "rejectedCount",
    "unfilledSlotCount",
    "attemptCount",
    "latencyMs",
    "inputTokens",
    "outputTokens",
    "estimatedCostMicros",
    "candidate",
    "candidateId",
    "exerciseSpecVersion",
    "skillSpecVersion",
    "skillSpecFingerprint",
    "blueprintSlot",
    "exerciseFamily",
    "provenance",
    "evidenceAnchorIds",
    "acceptanceDecision",
    "acceptanceReasonCodes",
    "verifier",
    "decision",
    "independentAnswerMatch",
    "premisesConsistent",
    "deterministicChecksPassed",
    "sourceSupported",
    "explanationConsistent",
    "scopeSupported",
    "unambiguous",
    "duplicateFree",
    "repairAncestorId",
    "failure",
    "category",
    "code",
    "retryable",
    "degraded",
    "state",
    "fallbackProvider",
    "fallbackModel",
    "reasonCode",
    "outcome",
    "reasonCodes",
  ].map((key) => key.replace(/[^a-z0-9]/gi, "").toLowerCase()),
);

function normalizeKey(key: string) {
  return key.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSensitiveKey(key: string) {
  const normalized = normalizeKey(key);

  return (
    SENSITIVE_KEY_PATTERN.test(normalized) ||
    normalized.endsWith("prompttext") ||
    normalized.endsWith("sourcecontent") ||
    normalized.endsWith("sourcematerial") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("accesstoken") ||
    normalized.endsWith("refreshtoken")
  );
}

/**
 * Removes known raw-input, credential, and secret fields without mutating the
 * caller's value. The schemas below also strip unknown fields, so the only
 * strings that can survive the persistence builders are bounded identifiers,
 * versions, hashes, and reason codes.
 */
export function redactGenerationAuditMetadata(input: unknown): unknown {
  return redactValue(input, undefined, new WeakSet<object>());
}

function redactValue(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
  if (key && (isSensitiveKey(key) || !SAFE_AUDIT_KEY_NAMES.has(normalizeKey(key)))) {
    return undefined;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return undefined;
    }

    seen.add(value);
    const result = value.map((item) => redactValue(item, undefined, seen)).filter((item) => item !== undefined);
    seen.delete(value);
    return result;
  }

  if (value !== null && typeof value === "object") {
    if (seen.has(value)) {
      return undefined;
    }

    seen.add(value);
    const result = Object.fromEntries(
      Object.entries(value).flatMap(([entryKey, entryValue]) => {
        const redacted = redactValue(entryValue, entryKey, seen);
        return redacted === undefined ? [] : [[entryKey, redacted]];
      }),
    );
    seen.delete(value);
    return result;
  }

  return value;
}

function jsonByteSize(value: unknown) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 0 : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

export function getGenerationAuditMetadataByteSize(value: unknown) {
  return jsonByteSize(value);
}

function assertJsonByteLimit(value: unknown, maximum: number, label: string) {
  const byteSize = jsonByteSize(value);

  if (!Number.isFinite(byteSize) || byteSize > maximum) {
    throw new GenerationAuditValidationError(
      "metadata_too_large",
      `${label} exceeds the maximum of ${maximum} bytes.`,
    );
  }
}

function parseOrThrow<T>(schema: z.ZodType<T>, input: unknown, label: string): T {
  const result = schema.safeParse(redactGenerationAuditMetadata(input));

  if (!result.success) {
    const issueSummary = result.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
      .join("; ");
    throw new GenerationAuditValidationError(
      "invalid_metadata",
      `${label} failed audit validation${issueSummary ? `: ${issueSummary}` : "."}`,
      result.error.issues,
    );
  }

  return result.data;
}

export function buildGenerationReleaseTuple(input: unknown): GenerationReleaseTuple {
  const tuple = parseOrThrow(generationReleaseTupleSchema, input, "Generation release tuple");
  assertJsonByteLimit(tuple, 4_096, "Generation release tuple");
  return tuple;
}

export function buildContextManifest(input: unknown): ContextManifest {
  const manifest = parseOrThrow(contextManifestSchema, input, "Context manifest");
  assertJsonByteLimit(manifest, MAX_GENERATION_AUDIT_CONTEXT_MANIFEST_BYTES, "Context manifest");
  return manifest;
}

export function buildGenerationAuditMetadata(input: unknown): GenerationAuditMetadata {
  const redacted = redactGenerationAuditMetadata(input);
  assertJsonByteLimit(redacted, MAX_GENERATION_AUDIT_METADATA_BYTES, "Generation audit metadata");
  const metadata = parseOrThrow(generationAuditMetadataSchema, redacted, "Generation audit metadata");
  assertJsonByteLimit(metadata, MAX_GENERATION_AUDIT_METADATA_BYTES, "Generation audit metadata");
  return metadata;
}

export type SafeGenerationAuditMetadataResult =
  | { status: "valid"; metadata: GenerationAuditMetadata }
  | {
      status: "invalid";
      code: GenerationAuditValidationCode;
      message: string;
      issues: readonly unknown[];
    };

export function safeBuildGenerationAuditMetadata(input: unknown): SafeGenerationAuditMetadataResult {
  try {
    return { status: "valid", metadata: buildGenerationAuditMetadata(input) };
  } catch (error) {
    if (error instanceof GenerationAuditValidationError) {
      return {
        status: "invalid",
        code: error.code,
        message: error.message,
        issues: error.issues,
      };
    }

    return {
      status: "invalid",
      code: "invalid_metadata",
      message: "Generation audit metadata failed validation.",
      issues: [],
    };
  }
}

export type GenerationJobState = z.infer<typeof generationJobStateSchema>;

export const generationJobStateSchema = z
  .object({
    status: generationJobStatusSchema,
    stage: generationJobStageSchema,
    attempt: z.number().int().min(0).max(100),
    retryCount: z.number().int().min(0).max(100),
  })
  .superRefine((state, context) => {
    const validPair =
      (state.status === "PENDING" && state.stage === "QUEUED") ||
      (state.status === "RUNNING" &&
        ["PLANNING", "GENERATING", "VALIDATING", "VERIFYING", "ADJUDICATING", "PUBLISHING"].includes(
          state.stage,
        )) ||
      (state.status === "SUCCEEDED" && state.stage === "COMPLETE") ||
      (state.status === "FAILED" && state.stage === "FAILED");

    if (!validPair) {
      context.addIssue({
        code: "custom",
        path: ["stage"],
        message: "Job status and stage do not describe a valid lifecycle state.",
      });
    }
  });

export type GenerationJobTransitionResult =
  | { valid: true; from: GenerationJobState; to: GenerationJobState }
  | { valid: false; code: string; message: string; issues: readonly unknown[] };

function invalidTransition(message: string, issues: readonly unknown[] = []): GenerationJobTransitionResult {
  return { valid: false, code: "invalid_transition", message, issues };
}

function validTransition(from: GenerationJobState, to: GenerationJobState): GenerationJobTransitionResult {
  return { valid: true, from, to };
}

export function validateGenerationJobTransition(fromInput: unknown, toInput: unknown): GenerationJobTransitionResult {
  const fromResult = generationJobStateSchema.safeParse(redactGenerationAuditMetadata(fromInput));
  const toResult = generationJobStateSchema.safeParse(redactGenerationAuditMetadata(toInput));

  if (!fromResult.success || !toResult.success) {
    return invalidTransition("Job transition contains an invalid lifecycle state.", [
      ...(fromResult.success ? [] : fromResult.error.issues),
      ...(toResult.success ? [] : toResult.error.issues),
    ]);
  }

  const from = fromResult.data;
  const to = toResult.data;

  if (JSON.stringify(from) === JSON.stringify(to)) {
    return validTransition(from, to);
  }

  if (from.status === "SUCCEEDED") {
    return invalidTransition("A successful generation job cannot transition again.");
  }

  if (from.status === "FAILED") {
    const retryCountersAdvanced =
      to.attempt === from.attempt + 1 && to.retryCount === from.retryCount + 1;
    const requeued = to.status === "PENDING" && to.stage === "QUEUED";
    const directlyClaimed = to.status === "RUNNING" && to.stage === "PLANNING";

    if (retryCountersAdvanced && (requeued || directlyClaimed)) {
      return validTransition(from, to);
    }

    return invalidTransition("A failed job must advance attempt and retry counts before retrying.");
  }

  if (from.status === "PENDING") {
    if (to.status === "FAILED" && to.stage === "FAILED" && to.attempt === from.attempt && to.retryCount === from.retryCount) {
      return validTransition(from, to);
    }

    const expectedAttempt = from.attempt === 0 ? 1 : from.attempt;
    if (
      to.status === "RUNNING" &&
      to.stage === "PLANNING" &&
      to.attempt === expectedAttempt &&
      to.retryCount === from.retryCount
    ) {
      return validTransition(from, to);
    }

    return invalidTransition("A pending job can only start planning or fail before execution.");
  }

  if (from.status === "RUNNING") {
    const allowedRunningPredecessors: Partial<
      Record<GenerationJobState["stage"], readonly GenerationJobState["stage"][]>
    > = {
      PLANNING: ["PLANNING"],
      GENERATING: ["PLANNING", "GENERATING"],
      VALIDATING: ["GENERATING", "VALIDATING"],
      VERIFYING: ["VALIDATING", "VERIFYING"],
      ADJUDICATING: ["VERIFYING", "ADJUDICATING"],
      PUBLISHING: ["VERIFYING", "ADJUDICATING", "PUBLISHING"],
    };
    const allowedPredecessors = allowedRunningPredecessors[to.stage] ?? [];
    if (
      to.status === "RUNNING" &&
      allowedPredecessors.includes(from.stage) &&
      to.attempt === from.attempt &&
      to.retryCount === from.retryCount
    ) {
      return validTransition(from, to);
    }

    if (
      to.status === "FAILED" &&
      to.stage === "FAILED" &&
      to.attempt === from.attempt &&
      to.retryCount === from.retryCount
    ) {
      return validTransition(from, to);
    }

    if (
      from.stage === "PUBLISHING" &&
      to.status === "SUCCEEDED" &&
      to.stage === "COMPLETE" &&
      to.attempt === from.attempt &&
      to.retryCount === from.retryCount
    ) {
      return validTransition(from, to);
    }
  }

  return invalidTransition("Job transition skips, regresses, or mutates an unsupported lifecycle state.");
}

export function isValidGenerationJobTransition(fromInput: unknown, toInput: unknown) {
  return validateGenerationJobTransition(fromInput, toInput).valid;
}

export function assertGenerationJobTransition(fromInput: unknown, toInput: unknown): GenerationJobState {
  const result = validateGenerationJobTransition(fromInput, toInput);

  if (!result.valid) {
    throw new GenerationAuditValidationError("invalid_transition", result.message, result.issues);
  }

  return result.to;
}
