import { describe, expect, it } from "vitest";

import { ModelReleaseState } from "@/generated/prisma/client";
import {
  canTransitionRelease,
  evaluateCanary,
  fingerprintReleaseTuple,
  isCanarySelected,
} from "@/lib/ai-generation-evals/release-control";

describe("generation release controls", () => {
  it("fingerprints version tuples independent of object key order", () => {
    expect(fingerprintReleaseTuple({ model: "m", prompt: "p" })).toBe(
      fingerprintReleaseTuple({ prompt: "p", model: "m" }),
    );
  });

  it("assigns canaries deterministically and enforces percentage bounds", () => {
    const input = { jobId: "job-1", releaseFingerprint: "a".repeat(64), canaryPercent: 7 };
    expect(isCanarySelected(input)).toBe(isCanarySelected(input));
    expect(isCanarySelected({ ...input, canaryPercent: 0 })).toBe(false);
    expect(isCanarySelected({ ...input, canaryPercent: 100 })).toBe(true);
    expect(() => isCanarySelected({ ...input, canaryPercent: 101 })).toThrow();
  });

  it("rolls back critical or schema failures and pauses reliability regressions", () => {
    expect(evaluateCanary({
      sampleCount: 1,
      acceptedCount: 1,
      criticalDefects: 1,
      schemaFailures: 0,
      fallbackCount: 0,
      p95LatencyMs: 1_000,
    }).action).toBe("rollback");

    expect(evaluateCanary({
      sampleCount: 20,
      acceptedCount: 10,
      criticalDefects: 0,
      schemaFailures: 0,
      fallbackCount: 10,
      p95LatencyMs: 1_000,
    }).action).toBe("pause");
  });

  it("approves only after the evidence threshold", () => {
    const healthy = {
      acceptedCount: 29,
      criticalDefects: 0,
      schemaFailures: 0,
      fallbackCount: 1,
      p95LatencyMs: 20_000,
    };
    expect(evaluateCanary({ ...healthy, sampleCount: 29 }).action).toBe("continue");
    expect(evaluateCanary({ ...healthy, sampleCount: 30, acceptedCount: 30 }).action).toBe("approve");
  });

  it("permits reversible release transitions but never resurrects terminal releases", () => {
    expect(canTransitionRelease(ModelReleaseState.DRAFT, ModelReleaseState.CANARY)).toBe(true);
    expect(canTransitionRelease(ModelReleaseState.APPROVED, ModelReleaseState.ROLLED_BACK)).toBe(true);
    expect(canTransitionRelease(ModelReleaseState.ROLLED_BACK, ModelReleaseState.CANARY)).toBe(false);
  });
});
