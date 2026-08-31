import { describe, expect, it } from "vitest";

import {
  MAX_GENERATION_AUDIT_METADATA_BYTES,
  assertGenerationJobTransition,
  buildContextManifest,
  buildGenerationAuditMetadata,
  buildGenerationReleaseTuple,
  getGenerationAuditMetadataByteSize,
  redactGenerationAuditMetadata,
  validateGenerationJobTransition,
} from "@/lib/skills/generation-audit";

const releaseTuple = {
  releaseId: "release-2026-08-31-01",
  provider: "gemini",
  model: "gemini-3.7-flash",
  endpointMode: "vertex",
  generationPromptVersion: "generation-prompt-v3",
  verificationPromptVersion: "verification-prompt-v2",
  responseSchemaVersion: "exercise-schema-v2",
  validatorVersion: "validator-v4",
  contextBuilderVersion: "context-builder-v2",
  skillSpecSchemaVersion: "skill-spec-v1",
  blueprintVersion: "blueprint-v1",
  qualityVersion: "quality-v2",
  fingerprint: "a".repeat(64),
};

const contextManifest = {
  version: 1,
  manifestHash: "d".repeat(64),
  sourceRevisionIds: ["revision-1"],
  sourceFileIds: ["file-1"],
  sectionIds: ["section-1"],
  chunkIds: ["chunk-1"],
  pageNumbers: [3, 4],
  contentHashes: ["b".repeat(64)],
  sourceKind: "pdf" as const,
  mediaCount: 1,
  selectedEvidenceCount: 2,
  extractionConfidence: 0.98,
  evidenceOmitted: false,
};

const auditMetadata = {
  schemaVersion: 1,
  job: {
    jobId: "job-1",
    idempotencyKey: "job-idempotency-1",
    kind: "CHOICE_EXERCISE_GENERATION",
    stage: "VERIFYING",
    checkpoint: "candidate-1",
    attempt: 1,
    retryCount: 0,
    maxAttempts: 3,
  },
  release: releaseTuple,
  contextManifest,
  stageMetrics: {
    requestedCount: 5,
    candidateCount: 6,
    acceptedCount: 1,
    rejectedCount: 5,
    unfilledSlotCount: 0,
    attemptCount: 1,
    retryCount: 0,
    latencyMs: 1_250,
    inputTokens: 1_000,
    outputTokens: 500,
    estimatedCostMicros: 900,
  },
  candidate: {
    candidateId: "candidate-1",
    exerciseSpecVersion: "exercise-spec-v2",
    skillSpecVersion: "skill-spec-v1",
    skillSpecFingerprint: "c".repeat(64),
    blueprintVersion: "blueprint-v1",
    blueprintSlot: "slot-1",
    exerciseFamily: "confidence-interval-interpretation",
    qualityVersion: "quality-v2",
    provenance: {
      kind: "SOURCE_DERIVED",
      sourceRevisionIds: ["revision-1"],
      evidenceAnchorIds: ["chunk-1"],
    },
    acceptanceDecision: "ACCEPTED",
    acceptanceReasonCodes: ["ALL_GATES_PASSED"],
    verifier: {
      releaseId: "release-2026-08-31-verifier-01",
      provider: "meta",
      model: "muse-spark-1.2",
      decision: "ACCEPTED",
      independentAnswerMatch: true,
      premisesConsistent: true,
      deterministicChecksPassed: true,
      sourceSupported: true,
      explanationConsistent: true,
      scopeSupported: true,
      unambiguous: true,
      duplicateFree: true,
    },
  },
  failure: {
    category: "NONE",
    retryable: false,
  },
  degraded: {
    state: "NONE",
  },
  decision: {
    outcome: "PUBLISHED",
    reasonCodes: ["ALL_GATES_PASSED"],
  },
};

describe("generation audit metadata", () => {
  it("builds a bounded, versioned metadata envelope with release, evidence, and quality decisions", () => {
    const result = buildGenerationAuditMetadata(auditMetadata);

    expect(result.schemaVersion).toBe(1);
    expect(result.job).toMatchObject({
      jobId: "job-1",
      idempotencyKey: "job-idempotency-1",
      stage: "VERIFYING",
    });
    expect(result.release).toEqual(releaseTuple);
    expect(result.contextManifest).toEqual(contextManifest);
    expect(result.candidate).toMatchObject({
      exerciseFamily: "confidence-interval-interpretation",
      acceptanceDecision: "ACCEPTED",
    });
    expect(result.candidate?.verifier).toMatchObject({
      model: "muse-spark-1.2",
      premisesConsistent: true,
    });
    expect(getGenerationAuditMetadataByteSize(result)).toBeLessThanOrEqual(
      MAX_GENERATION_AUDIT_METADATA_BYTES,
    );
  });

  it("builds component contracts with trimming but never accepts source text or prompt text", () => {
    const tuple = buildGenerationReleaseTuple({
      ...releaseTuple,
      provider: " gemini ",
    });
    const manifest = buildContextManifest({
      ...contextManifest,
      sourceText: "private source material must not be retained",
      promptText: "private prompt must not be retained",
    });

    expect(tuple.provider).toBe("gemini");
    expect(manifest).toEqual(contextManifest);
    expect(JSON.stringify(manifest)).not.toContain("private source material");
    expect(JSON.stringify(manifest)).not.toContain("private prompt");
  });

  it("redacts sensitive diagnostic keys before validation and persistence", () => {
    const unsafeInput = {
      ...auditMetadata,
      prompt: "the complete private prompt",
      rawSourceMaterial: "the complete private source",
      debug: {
        promptText: "another private prompt",
        sourceText: "another private source",
        safeCode: "SCHEMA_MISMATCH",
      },
      contextManifest: {
        ...contextManifest,
        sourceContent: "private source content",
      },
    };

    const redacted = redactGenerationAuditMetadata(unsafeInput);
    const result = buildGenerationAuditMetadata(unsafeInput);
    const serialized = JSON.stringify({ redacted, result });

    expect(serialized).not.toContain("complete private prompt");
    expect(serialized).not.toContain("complete private source");
    expect(serialized).not.toContain("another private prompt");
    expect(serialized).not.toContain("another private source");
    expect(result).toMatchObject({
      job: auditMetadata.job,
      contextManifest,
    });
  });

  it("rejects oversized envelopes instead of truncating audit evidence", () => {
    expect(() =>
      buildGenerationAuditMetadata({
        ...auditMetadata,
        decision: {
          outcome: "QUARANTINED",
          reasonCodes: ["x".repeat(MAX_GENERATION_AUDIT_METADATA_BYTES)],
        },
      }),
    ).toThrow(/maximum.*bytes|too large/i);
  });

  it.each([
    ["negative metric", { ...auditMetadata, stageMetrics: { ...auditMetadata.stageMetrics, latencyMs: -1 } }],
    ["invalid hash", { ...auditMetadata, release: { ...releaseTuple, fingerprint: "not-a-hash" } }],
    ["missing fallback details", { ...auditMetadata, degraded: { state: "FALLBACK_USED" } }],
    [
      "accepted candidate without verifier proof",
      {
        ...auditMetadata,
        candidate: {
          ...auditMetadata.candidate,
          verifier: { ...auditMetadata.candidate.verifier, premisesConsistent: false },
        },
      },
    ],
  ])("rejects unsafe or internally inconsistent metadata: %s", (_label, input) => {
    expect(() => buildGenerationAuditMetadata(input)).toThrow();
  });
});

describe("generation job state transitions", () => {
  it.each([
    [
      "starts planning",
      { status: "PENDING", stage: "QUEUED", attempt: 0, retryCount: 0 },
      { status: "RUNNING", stage: "PLANNING", attempt: 1, retryCount: 0 },
    ],
    [
      "advances through stages",
      { status: "RUNNING", stage: "PLANNING", attempt: 1, retryCount: 0 },
      { status: "RUNNING", stage: "GENERATING", attempt: 1, retryCount: 0 },
    ],
    [
      "publishes a completed job",
      { status: "RUNNING", stage: "PUBLISHING", attempt: 1, retryCount: 0 },
      { status: "SUCCEEDED", stage: "COMPLETE", attempt: 1, retryCount: 0 },
    ],
    [
      "fails with a recorded attempt",
      { status: "RUNNING", stage: "VERIFYING", attempt: 1, retryCount: 0 },
      { status: "FAILED", stage: "FAILED", attempt: 1, retryCount: 0 },
    ],
    [
      "requeues a failed job with a new attempt",
      { status: "FAILED", stage: "FAILED", attempt: 1, retryCount: 0 },
      { status: "PENDING", stage: "QUEUED", attempt: 2, retryCount: 1 },
    ],
    [
      "allows an idempotent repeated terminal state",
      { status: "SUCCEEDED", stage: "COMPLETE", attempt: 1, retryCount: 0 },
      { status: "SUCCEEDED", stage: "COMPLETE", attempt: 1, retryCount: 0 },
    ],
  ])("accepts %s", (_label, from, to) => {
    expect(validateGenerationJobTransition(from, to)).toMatchObject({ valid: true });
    expect(assertGenerationJobTransition(from, to)).toEqual(to);
  });

  it.each([
    [
      "skips directly from pending to success",
      { status: "PENDING", stage: "QUEUED", attempt: 0, retryCount: 0 },
      { status: "SUCCEEDED", stage: "COMPLETE", attempt: 0, retryCount: 0 },
    ],
    [
      "regresses a running stage",
      { status: "RUNNING", stage: "VERIFYING", attempt: 1, retryCount: 0 },
      { status: "RUNNING", stage: "GENERATING", attempt: 1, retryCount: 0 },
    ],
    [
      "resurrects a successful job",
      { status: "SUCCEEDED", stage: "COMPLETE", attempt: 1, retryCount: 0 },
      { status: "RUNNING", stage: "PLANNING", attempt: 2, retryCount: 1 },
    ],
    [
      "retries without incrementing counters",
      { status: "FAILED", stage: "FAILED", attempt: 1, retryCount: 1 },
      { status: "PENDING", stage: "QUEUED", attempt: 1, retryCount: 1 },
    ],
    [
      "changes the attempt without a retry",
      { status: "RUNNING", stage: "VERIFYING", attempt: 1, retryCount: 0 },
      { status: "SUCCEEDED", stage: "COMPLETE", attempt: 2, retryCount: 1 },
    ],
  ])("rejects %s", (_label, from, to) => {
    const result = validateGenerationJobTransition(from, to);

    expect(result.valid).toBe(false);
    expect(() => assertGenerationJobTransition(from, to)).toThrow();
  });
});
