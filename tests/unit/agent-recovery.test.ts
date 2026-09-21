import { describe, expect, it } from "vitest";

import {
  AGENT_OPERATION_CLEANUP_MARGIN_MS,
  AGENT_OPERATION_ACTIVATION_RESERVE_MS,
  AGENT_OPERATION_SOFT_DEADLINE_MS,
  AGENT_OPERATION_STALE_AFTER_MS,
  isAgentOperationClaimStale,
  shouldDeferAgentOperation,
} from "@/lib/agent-access/recovery-policy";

describe("agent activation recovery policy", () => {
  const now = new Date("2026-09-21T12:00:00.000Z");

  it.each([
    [new Date(now.getTime() - AGENT_OPERATION_STALE_AFTER_MS - 1), true],
    [new Date(now.getTime() - AGENT_OPERATION_STALE_AFTER_MS), true],
    [new Date(now.getTime() - AGENT_OPERATION_STALE_AFTER_MS + 1), false],
  ])("classifies a claim at %s as stale=%s", (claimedAt, stale) => {
    expect(isAgentOperationClaimStale(claimedAt, now)).toBe(stale);
  });

  it("defers work when the durable cleanup margin is all that remains", () => {
    expect(
      shouldDeferAgentOperation(
        new Date(now.getTime() + AGENT_OPERATION_CLEANUP_MARGIN_MS),
        now,
      ),
    ).toBe(true);
    expect(
      shouldDeferAgentOperation(
        new Date(now.getTime() + AGENT_OPERATION_ACTIVATION_RESERVE_MS),
        now,
      ),
    ).toBe(true);
    expect(
      shouldDeferAgentOperation(
        new Date(now.getTime() + AGENT_OPERATION_ACTIVATION_RESERVE_MS + 1),
        now,
      ),
    ).toBe(false);
  });

  it("keeps the soft delivery deadline below the stale recovery threshold", () => {
    expect(AGENT_OPERATION_SOFT_DEADLINE_MS).toBeLessThan(AGENT_OPERATION_STALE_AFTER_MS);
  });
});
