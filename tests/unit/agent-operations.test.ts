import { describe, expect, it } from "vitest";

import { AgentOperationItemStatus, AgentOperationStatus } from "@/generated/prisma/client";
import { reduceAgentOperationStatus } from "@/lib/agent-access/operations";

describe("reduceAgentOperationStatus", () => {
  it.each([
    [[AgentOperationItemStatus.ACTIVE], AgentOperationStatus.SUCCEEDED],
    [[AgentOperationItemStatus.REUSED], AgentOperationStatus.SUCCEEDED],
    [[AgentOperationItemStatus.FAILED], AgentOperationStatus.FAILED],
    [[AgentOperationItemStatus.CANCELED], AgentOperationStatus.CANCELED],
    [[AgentOperationItemStatus.ACTIVE, AgentOperationItemStatus.FAILED], AgentOperationStatus.PARTIAL],
    [[AgentOperationItemStatus.QUEUED], AgentOperationStatus.QUEUED],
    [[AgentOperationItemStatus.PLANNING], AgentOperationStatus.PLANNING],
    [[AgentOperationItemStatus.GENERATING], AgentOperationStatus.GENERATING],
    [[AgentOperationItemStatus.VERIFYING], AgentOperationStatus.VERIFYING],
    [[AgentOperationItemStatus.ACTIVATING], AgentOperationStatus.ACTIVATING],
    [[AgentOperationItemStatus.NEEDS_INPUT], AgentOperationStatus.NEEDS_INPUT],
    [[AgentOperationItemStatus.NEEDS_REVIEW], AgentOperationStatus.NEEDS_REVIEW],
  ])("reduces %j to %s", (items, expected) => {
    expect(reduceAgentOperationStatus(items)).toBe(expected);
  });

  it("prioritizes user review over background work", () => {
    expect(
      reduceAgentOperationStatus([
        AgentOperationItemStatus.NEEDS_REVIEW,
        AgentOperationItemStatus.GENERATING,
      ]),
    ).toBe(AgentOperationStatus.NEEDS_REVIEW);
  });
});
