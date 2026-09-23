import { describe, expect, it } from "vitest";

import {
  AGENT_OPERATION_CLEANUP_MARGIN_MS,
  AGENT_OPERATION_ACTIVATION_RESERVE_MS,
  AGENT_OPERATION_CANDIDATE_VERIFICATION_RESERVE_MS,
  AGENT_OPERATION_RETRY_BASE_DELAY_MS,
  AGENT_OPERATION_RETRY_MAX_DELAY_MS,
  AGENT_OPERATION_SOFT_DEADLINE_MS,
  AGENT_OPERATION_STALE_AFTER_MS,
  buildAgentOperationContinuationCursor,
  getAgentOperationRetryDelayMs,
  getAgentOperationRetryReadyWhere,
  isAgentOperationRetryReady,
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

  it("reserves candidate verification time separately from full activation time", () => {
    expect(AGENT_OPERATION_CANDIDATE_VERIFICATION_RESERVE_MS).toBe(AGENT_OPERATION_CLEANUP_MARGIN_MS);
    expect(AGENT_OPERATION_ACTIVATION_RESERVE_MS).toBeGreaterThan(AGENT_OPERATION_CANDIDATE_VERIFICATION_RESERVE_MS);
  });

  it("backs off transient retries and caps the delay", () => {
    expect([0, 1, 2, 3, 4, 20].map(getAgentOperationRetryDelayMs)).toEqual([
      0,
      AGENT_OPERATION_RETRY_BASE_DELAY_MS,
      AGENT_OPERATION_RETRY_BASE_DELAY_MS * 2,
      AGENT_OPERATION_RETRY_MAX_DELAY_MS,
      AGENT_OPERATION_RETRY_MAX_DELAY_MS,
      AGENT_OPERATION_RETRY_MAX_DELAY_MS,
    ]);
    expect(isAgentOperationRetryReady({
      errorCode: "TRANSIENT_WORKER_FAILURE",
      retryCount: 2,
      updatedAt: now,
      now: new Date(now.getTime() + AGENT_OPERATION_RETRY_BASE_DELAY_MS * 2 - 1),
    })).toBe(false);
  });

  it("filters delayed retries before applying the bounded recovery scan", () => {
    expect(getAgentOperationRetryReadyWhere(now)).toMatchObject({
      OR: [
        { errorCode: null },
        { errorCode: { not: "TRANSIENT_WORKER_FAILURE" } },
        {
          AND: [
            { errorCode: "TRANSIENT_WORKER_FAILURE" },
            { retryCount: { lte: 0 } },
            { updatedAt: { lte: now } },
          ],
        },
        {
          AND: [
            { errorCode: "TRANSIENT_WORKER_FAILURE" },
            { retryCount: 1 },
            { updatedAt: { lte: new Date(now.getTime() - AGENT_OPERATION_RETRY_BASE_DELAY_MS) } },
          ],
        },
        {
          AND: [
            { errorCode: "TRANSIENT_WORKER_FAILURE" },
            { retryCount: 2 },
            { updatedAt: { lte: new Date(now.getTime() - AGENT_OPERATION_RETRY_BASE_DELAY_MS * 2) } },
          ],
        },
        {
          AND: [
            { errorCode: "TRANSIENT_WORKER_FAILURE" },
            { retryCount: { gte: 3 } },
            { updatedAt: { lte: new Date(now.getTime() - AGENT_OPERATION_RETRY_MAX_DELAY_MS) } },
          ],
        },
      ],
    });
  });

  it("uses a stable cursor identity until the durable queue changes", () => {
    const input = {
      operationId: "operation-a",
      operationUpdatedAt: now,
      items: [
        { id: "item-b", retryCount: 1, updatedAt: now },
        { id: "item-a", retryCount: 0, updatedAt: new Date(now.getTime() - 1_000) },
      ],
    };
    const first = buildAgentOperationContinuationCursor(input);
    expect(buildAgentOperationContinuationCursor(input)).toEqual(first);
    expect(first).toMatchObject({
      eventId: expect.stringMatching(/^agent-op-[a-f0-9]{40}$/),
      requestedAt: now.toISOString(),
    });
    expect(buildAgentOperationContinuationCursor({
      ...input,
      items: input.items.map((item) => ({ ...item, retryCount: item.retryCount + 1 })),
    }).eventId).not.toBe(first.eventId);
    expect(buildAgentOperationContinuationCursor({
      ...input,
      operationUpdatedAt: new Date(now.getTime() + 1),
    }).eventId).not.toBe(first.eventId);
  });
});
