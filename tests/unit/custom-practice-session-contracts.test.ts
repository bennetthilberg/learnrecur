import { describe, expect, it } from "vitest";

import {
  DEFAULT_CUSTOM_PRACTICE_SESSION_ITEMS,
  MAX_CUSTOM_PRACTICE_SESSION_ITEMS,
  customPracticeSessionCreateInputSchema,
  customPracticeSessionPlanSchema,
  customPracticeSessionScopeSchema,
  createCustomPracticeAttemptId,
  createCustomPracticeSessionItemKey,
  normalizeCustomPracticeSessionScope,
  resolveCustomPracticeSkillPrefill,
} from "@/lib/practice/custom-session-contracts";

const scope = {
  collectionIds: ["collection-b", "collection-a", "collection-a"],
  tags: [" grammar ", "grammar"],
  skillIds: [],
  recentlyMissed: true,
  mixedReview: false,
};

describe("custom practice session contracts", () => {
  it("defaults to a bounded practice-only session", () => {
    expect(
      customPracticeSessionCreateInputSchema.parse({ scope }),
    ).toMatchObject({
      mode: "PRACTICE_ONLY",
      targetCount: DEFAULT_CUSTOM_PRACTICE_SESSION_ITEMS,
    });
  });

  it("normalizes scope lists without changing the selected filters", () => {
    expect(normalizeCustomPracticeSessionScope(scope)).toEqual({
      collectionIds: ["collection-a", "collection-b"],
      tags: ["grammar"],
      skillIds: [],
      recentlyMissed: true,
      mixedReview: false,
    });
  });

  it("keeps selected skills and tags as intersecting scope filters", () => {
    expect(
      customPracticeSessionScopeSchema.parse({
        ...scope,
        tags: ["grammar"],
        skillIds: ["skill-1"],
      }),
    ).toMatchObject({ tags: ["grammar"], skillIds: ["skill-1"] });
  });

  it("only prefills an active owned skill", () => {
    expect(resolveCustomPracticeSkillPrefill(" skill-1 ", ["skill-1", "skill-2"])).toBe(
      "skill-1",
    );
    expect(resolveCustomPracticeSkillPrefill("foreign-skill", ["skill-1"])).toBeNull();
    expect(resolveCustomPracticeSkillPrefill("archived-skill", [])).toBeNull();
  });

  it("rejects a plan with duplicate or non-contiguous items", () => {
    expect(() =>
      customPracticeSessionPlanSchema.parse([
        {
          ordinal: 0,
          itemKey: "item-0",
          skillId: "skill-1",
          exerciseId: "exercise-1",
          attemptId: "custom-session-item-0",
          status: "PENDING",
          presentedAt: null,
          completedAt: null,
        },
        {
          ordinal: 2,
          itemKey: "item-2",
          skillId: "skill-2",
          exerciseId: "exercise-2",
          attemptId: "custom-session-item-2",
          status: "PENDING",
          presentedAt: null,
          completedAt: null,
        },
      ]),
    ).toThrow(/contiguous/i);
  });

  it("bounds target count and produces deterministic retry IDs", () => {
    expect(() =>
      customPracticeSessionCreateInputSchema.parse({
        scope,
        targetCount: MAX_CUSTOM_PRACTICE_SESSION_ITEMS + 1,
      }),
    ).toThrow();

    expect(createCustomPracticeSessionItemKey(4)).toBe("item-4");
    expect(createCustomPracticeAttemptId("session-abc", 4)).toBe(
      "custom-session-abc-item-4",
    );
    expect(createCustomPracticeAttemptId("session-abc", 4)).toBe(
      createCustomPracticeAttemptId("session-abc", 4),
    );
  });
});
