import { describe, expect, it } from "vitest";

import {
  summarizeReadinessPreparationStatus,
  type ReadinessPreparationStatus,
} from "@/lib/agent-access/progress";
import type { RefillQueueResult } from "@/lib/skills/refill-jobs";

function queued(): RefillQueueResult {
  return {
    status: "queued",
    skillId: "skill-1",
    generationJobId: "job-1",
    requestedCount: 1,
    readyExerciseCount: 0,
    targetReadyCount: 5,
    message: "queued",
  };
}

function notQueued(
  reason: Extract<RefillQueueResult, { status: "not-queued" }>["reason"],
): RefillQueueResult {
  return { status: "not-queued", reason, message: reason };
}

describe("readiness preparation status", () => {
  it.each([
    [[queued()], "queued"],
    [[notQueued("already-at-target")], "ready"],
    [[notQueued("job-in-progress")], "in-progress"],
    [[notQueued("quota-exceeded")], "not-queued"],
    [[queued(), notQueued("already-at-target")], "partial"],
  ] as const)("summarizes %j as %s", (results, expected) => {
    expect(summarizeReadinessPreparationStatus(results)).toBe(
      expected as ReadinessPreparationStatus,
    );
  });

  it("does not claim an empty preparation result was queued", () => {
    expect(summarizeReadinessPreparationStatus([])).toBe("not-queued");
  });
});
