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

  it("uses code-point key order so release fingerprints do not depend on locale", () => {
    expect(fingerprintReleaseTuple({ "ä": 1, z: 2, A: 3 })).toBe(
      "e0d8f979d0484efb726de1b2d8e62df0d32d450c6084edf0526f65004795dedf",
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

  it("continues an empty canary until actual observations exist", () => {
    expect(evaluateCanary({
      sampleCount: 0,
      acceptedCount: 0,
      criticalDefects: 0,
      schemaFailures: 0,
      fallbackCount: 0,
      p95LatencyMs: 0,
    })).toEqual({
      action: "continue",
      reasons: ["0 samples observed; 30 required."],
    });
  });

  it("rolls back a critical defect even when no sampled generation was counted", () => {
    expect(evaluateCanary({
      sampleCount: 0,
      acceptedCount: 0,
      criticalDefects: 1,
      schemaFailures: 0,
      fallbackCount: 0,
      p95LatencyMs: 0,
    }).action).toBe("rollback");
  });

  it("rejects latency measurements when no canary samples exist", () => {
    expect(() => evaluateCanary({
      sampleCount: 0,
      acceptedCount: 0,
      criticalDefects: 0,
      schemaFailures: 0,
      fallbackCount: 0,
      p95LatencyMs: 1,
    })).toThrow("P95 latency must be zero when no canary samples exist.");
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
