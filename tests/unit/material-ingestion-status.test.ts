import { describe, expect, it } from "vitest";

import { MaterialRevisionStatus } from "@/generated/prisma/client";
import {
  MATERIAL_QUEUE_STALE_AFTER_MS,
  getMaterialIngestionDisplayState,
} from "@/lib/materials/ingestion-status";

describe("material ingestion display state", () => {
  const now = new Date("2026-07-10T18:00:00.000Z");

  it("keeps polling a recently queued revision", () => {
    expect(
      getMaterialIngestionDisplayState({
        status: MaterialRevisionStatus.QUEUED,
        updatedAt: new Date(now.getTime() - MATERIAL_QUEUE_STALE_AFTER_MS + 1),
        now,
      }),
    ).toBe("processing");
  });

  it("marks a revision as stalled when the worker has not claimed it in time", () => {
    expect(
      getMaterialIngestionDisplayState({
        status: MaterialRevisionStatus.QUEUED,
        updatedAt: new Date(now.getTime() - MATERIAL_QUEUE_STALE_AFTER_MS),
        now,
      }),
    ).toBe("stalled");
  });

  it("does not time out a worker that already started processing", () => {
    expect(
      getMaterialIngestionDisplayState({
        status: MaterialRevisionStatus.PROCESSING,
        updatedAt: new Date(now.getTime() - MATERIAL_QUEUE_STALE_AFTER_MS * 20),
        now,
      }),
    ).toBe("processing");
  });

  it.each([
    MaterialRevisionStatus.READY,
    MaterialRevisionStatus.FAILED,
  ])("treats %s as inactive", (status) => {
    expect(getMaterialIngestionDisplayState({ status, updatedAt: now, now })).toBe("idle");
  });
});
