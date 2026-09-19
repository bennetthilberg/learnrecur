import { describe, expect, it } from "vitest";

import {
  compareIntroductionQueueCandidates,
  compareIntroductionQueuePositions,
  introductionQueueScopeKey,
} from "@/lib/practice/introduction-queue";
import {
  agentGetIntroductionQueueSchema,
  agentUpdateIntroductionQueueSchema,
} from "@/lib/agent-access/practice-contracts";

describe("introduction queue contract", () => {
  it("uses a stable scope key for collected and uncollected skills", () => {
    expect(introductionQueueScopeKey("collection-1")).toBe("collection-1");
    expect(introductionQueueScopeKey(null)).toBe("uncategorized");
  });

  it("keeps pagination ordering deterministic when positions tie", () => {
    expect(
      compareIntroductionQueuePositions(
        { position: 2, entryId: "entry-b" },
        { position: 2, entryId: "entry-a" },
      ),
    ).toBeGreaterThan(0);
  });

  it("interleaves account-wide collection heads while preserving each queue rank", () => {
    const order = new Map([
      ["a-1", { collectionId: "a", position: 0 }],
      ["a-2", { collectionId: "a", position: 1 }],
      ["b-1", { collectionId: "b", position: 0 }],
      ["b-2", { collectionId: "b", position: 1 }],
    ]);
    const candidates = [
      { skillId: "a-2", collectionId: "a" },
      { skillId: "b-2", collectionId: "b" },
      { skillId: "a-1", collectionId: "a" },
      { skillId: "b-1", collectionId: "b" },
    ].sort((left, right) => compareIntroductionQueueCandidates(left, right, order));
    expect(candidates.map((candidate) => candidate.skillId)).toEqual([
      "a-1",
      "b-1",
      "a-2",
      "b-2",
    ]);
  });

  it("requires a complete unique queue replacement and bounded pagination", () => {
    expect(
      agentGetIntroductionQueueSchema.parse({ collection_id: null, limit: 50 }),
    ).toMatchObject({ collection_id: null, limit: 50 });
    expect(() =>
      agentUpdateIntroductionQueueSchema.parse({
        collection_id: "collection-1",
        expected_version: 3,
        skill_ids: ["skill-1", "skill-1"],
        idempotency_key: "queue-update-1",
      }),
    ).toThrow();
    expect(() =>
      agentGetIntroductionQueueSchema.parse({ collection_id: "collection-1", limit: 51 }),
    ).toThrow();
  });
});
