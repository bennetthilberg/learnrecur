import { createHash } from "node:crypto";

import { ModelReleaseState } from "@/generated/prisma/client";

export const DEFAULT_CANARY_POLICY = {
  minimumSampleCount: 30,
  maximumCriticalDefects: 0,
  maximumSchemaFailureRate: 0,
  maximumFallbackRate: 0.25,
  minimumAcceptedYield: 0.6,
  maximumP95LatencyMs: 90_000,
} as const;

export type CanaryPolicy = {
  minimumSampleCount: number;
  maximumCriticalDefects: number;
  maximumSchemaFailureRate: number;
  maximumFallbackRate: number;
  minimumAcceptedYield: number;
  maximumP95LatencyMs: number;
};

export type CanaryObservation = {
  sampleCount: number;
  acceptedCount: number;
  criticalDefects: number;
  schemaFailures: number;
  fallbackCount: number;
  p95LatencyMs: number;
};

export type CanaryDecision = {
  action: "continue" | "approve" | "pause" | "rollback";
  reasons: string[];
};

export function fingerprintReleaseTuple(tuple: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(tuple)).digest("hex");
}

export function isCanarySelected(input: {
  jobId: string;
  releaseFingerprint: string;
  canaryPercent: number;
}): boolean {
  if (!Number.isInteger(input.canaryPercent) || input.canaryPercent < 0 || input.canaryPercent > 100) {
    throw new Error("Canary percentage must be an integer from 0 to 100.");
  }
  if (input.canaryPercent === 0) return false;
  if (input.canaryPercent === 100) return true;

  const digest = createHash("sha256")
    .update(`${input.releaseFingerprint}:${input.jobId}`)
    .digest();
  return digest.readUInt32BE(0) % 100 < input.canaryPercent;
}

export function evaluateCanary(
  observation: CanaryObservation,
  policy: CanaryPolicy = DEFAULT_CANARY_POLICY,
): CanaryDecision {
  validateObservation(observation);
  if (observation.sampleCount === 0 && observation.criticalDefects === 0) {
    return {
      action: "continue",
      reasons: [`0 samples observed; ${policy.minimumSampleCount} required.`],
    };
  }
  const schemaFailureRate = rate(observation.schemaFailures, observation.sampleCount);
  const fallbackRate = rate(observation.fallbackCount, observation.sampleCount);
  const acceptedYield = rate(observation.acceptedCount, observation.sampleCount);
  const criticalReasons = [
    observation.criticalDefects > policy.maximumCriticalDefects
      ? `${observation.criticalDefects} critical defect(s) exceeded the limit.`
      : null,
    schemaFailureRate > policy.maximumSchemaFailureRate
      ? `Schema failure rate ${schemaFailureRate.toFixed(3)} exceeded ${policy.maximumSchemaFailureRate.toFixed(3)}.`
      : null,
  ].filter((reason): reason is string => reason !== null);

  if (criticalReasons.length) {
    return { action: "rollback", reasons: criticalReasons };
  }

  const stopReasons = [
    fallbackRate > policy.maximumFallbackRate
      ? `Fallback rate ${fallbackRate.toFixed(3)} exceeded ${policy.maximumFallbackRate.toFixed(3)}.`
      : null,
    acceptedYield < policy.minimumAcceptedYield
      ? `Accepted yield ${acceptedYield.toFixed(3)} fell below ${policy.minimumAcceptedYield.toFixed(3)}.`
      : null,
    observation.p95LatencyMs > policy.maximumP95LatencyMs
      ? `P95 latency ${observation.p95LatencyMs}ms exceeded ${policy.maximumP95LatencyMs}ms.`
      : null,
  ].filter((reason): reason is string => reason !== null);

  if (stopReasons.length) {
    return { action: "pause", reasons: stopReasons };
  }
  if (observation.sampleCount < policy.minimumSampleCount) {
    return {
      action: "continue",
      reasons: [`${observation.sampleCount} samples observed; ${policy.minimumSampleCount} required.`],
    };
  }
  return { action: "approve", reasons: ["All canary stop conditions passed."] };
}

export function canTransitionRelease(
  from: ModelReleaseState,
  to: ModelReleaseState,
): boolean {
  const transitions: Record<ModelReleaseState, readonly ModelReleaseState[]> = {
    DRAFT: [ModelReleaseState.CANARY, ModelReleaseState.REJECTED],
    CANARY: [ModelReleaseState.APPROVED, ModelReleaseState.PAUSED, ModelReleaseState.ROLLED_BACK],
    APPROVED: [ModelReleaseState.PAUSED, ModelReleaseState.ROLLED_BACK],
    PAUSED: [ModelReleaseState.CANARY, ModelReleaseState.ROLLED_BACK, ModelReleaseState.REJECTED],
    ROLLED_BACK: [],
    REJECTED: [],
  };
  return transitions[from].includes(to);
}

function validateObservation(observation: CanaryObservation) {
  const counts = [
    observation.sampleCount,
    observation.acceptedCount,
    observation.criticalDefects,
    observation.schemaFailures,
    observation.fallbackCount,
    observation.p95LatencyMs,
  ];
  if (counts.some((value) => !Number.isInteger(value) || value < 0)) {
    throw new Error("Canary observations require non-negative integer counts and latency.");
  }
  if (
    observation.acceptedCount > observation.sampleCount ||
    observation.schemaFailures > observation.sampleCount ||
    observation.fallbackCount > observation.sampleCount
  ) {
    throw new Error("Canary event counts cannot exceed the sample count.");
  }
  if (observation.sampleCount === 0 && observation.p95LatencyMs !== 0) {
    throw new Error("P95 latency must be zero when no canary samples exist.");
  }
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
