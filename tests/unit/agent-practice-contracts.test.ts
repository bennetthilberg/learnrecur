import { describe, expect, it } from "vitest";
import {
  agentGetPracticeSettingsSchema,
  agentListPracticeTargetsSchema,
  agentUpdatePracticeSettingsSchema,
} from "@/lib/agent-access/practice-contracts";
import { EXACT_TEXT_POLICY } from "@/lib/practice/policies";

describe("MCP practice settings contracts", () => {
  it.each([
    [{ scope: "user" }, { practicePreference: "RECALL_FIRST" }],
    [{ scope: "user" }, { mixedReview: false }],
    [{ scope: "user" }, { desiredRetention: null, practiceDayStartMinutes: 0 }],
    [{ scope: "user" }, { desiredRetention: 0.7 }],
    [{ scope: "user" }, { desiredRetention: 0.99, practiceDayStartMinutes: 1439 }],
    [
      { scope: "collection", id: "c1" },
      { practicePreference: null, textPolicy: EXACT_TEXT_POLICY },
    ],
    [
      { scope: "skill", id: "s1" },
      { alreadyStudied: true, textPolicy: null },
    ],
    [
      { scope: "skill", id: "s1" },
      {
        textPolicy: {
          ...EXACT_TEXT_POLICY,
          profile: "CUSTOM",
          normalizeCase: true,
        },
      },
    ],
  ])("accepts an explicit partial update for %j", (target, changes) => {
    expect(
      agentUpdatePracticeSettingsSchema.parse({ target, changes }),
    ).toEqual({ target, changes });
  });

  it.each([
    [{ scope: "user" }, {}],
    [{ scope: "user" }, { practicePreference: null }],
    [{ scope: "user" }, { textPolicy: EXACT_TEXT_POLICY }],
    [{ scope: "collection", id: "c1" }, { alreadyStudied: true }],
    [{ scope: "skill", id: "s1" }, { mixedReview: true }],
    [{ scope: "user" }, { desiredRetention: 0.69 }],
    [{ scope: "user" }, { practiceDayStartMinutes: 1440 }],
    [{ scope: "skill", id: "s1" }, { alreadyStudied: "true" }],
    [
      { scope: "skill", id: "s1" },
      { textPolicy: { ...EXACT_TEXT_POLICY, normalizeCase: true } },
    ],
    [
      { scope: "skill", id: "s1" },
      { textPolicy: { ...EXACT_TEXT_POLICY, normalizeDiacritics: true } },
    ],
    [{ scope: "skill", id: "s1" }, { repetitions: 10 }],
    [{ scope: "user", id: "someone-else" }, { mixedReview: true }],
    [{ scope: "skill" }, { alreadyStudied: true }],
  ])(
    "rejects invalid scope or unsupported settings %j %j",
    (target, changes) => {
      expect(
        agentUpdatePracticeSettingsSchema.safeParse({ target, changes })
          .success,
      ).toBe(false);
    },
  );

  it("rejects caller-supplied ownership and bounds target discovery", () => {
    expect(
      agentGetPracticeSettingsSchema.safeParse({
        target: { scope: "user" },
        userId: "other",
      }).success,
    ).toBe(false);
    expect(agentListPracticeTargetsSchema.parse({ scope: "skill" })).toEqual({
      scope: "skill",
      limit: 20,
    });
    for (const limit of [0, 51, 1.5]) {
      expect(
        agentListPracticeTargetsSchema.safeParse({ scope: "skill", limit })
          .success,
      ).toBe(false);
    }
    expect(
      agentListPracticeTargetsSchema.safeParse({ scope: "user" }).success,
    ).toBe(false);
  });
});
