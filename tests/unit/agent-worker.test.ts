import { describe, expect, it } from "vitest";

import { SkillStatus } from "@/generated/prisma/client";
import {
  buildSkillDraftInputFromSnapshot,
  classifyAgentDuplicate,
  normalizeAgentItemErrorCode,
} from "@/lib/agent-access/worker";

const baseMatch = {
  score: 1,
  lexicalScore: 1,
  semanticScore: null,
  reasons: ["normalized-title-objective" as const],
  skill: {
    id: "skill-1",
    title: "Binary search",
    objective: "Apply binary search to sorted arrays.",
    status: SkillStatus.ACTIVE,
    collectionName: null,
    tags: [],
    contentFingerprint: "fingerprint",
  },
};

describe("classifyAgentDuplicate", () => {
  it("reuses exact matches without spending quota", () => {
    expect(classifyAgentDuplicate({ ...baseMatch, confidence: "exact" })).toEqual({
      action: "reuse",
      confidence: "exact",
      skillId: "skill-1",
    });
  });

  it.each(["likely", "possible"] as const)("routes %s matches to user review", (confidence) => {
    expect(classifyAgentDuplicate({ ...baseMatch, confidence })).toEqual({
      action: "review",
      confidence,
      skillId: "skill-1",
    });
  });

  it("creates only when no match exists", () => {
    expect(classifyAgentDuplicate(null)).toEqual({ action: "create", confidence: null });
  });
});

describe("buildSkillDraftInputFromSnapshot", () => {
  it("adapts structured agent guidance to the canonical draft form contract", () => {
    expect(
      buildSkillDraftInputFromSnapshot({
        title: "Estimate binary search comparisons",
        objective: "Bound the comparisons required by binary search.",
        rules: ["Keep the possible half.", "Stop when the interval is empty."],
        examples: ["Eight items need at most four comparisons."],
        exerciseConstraints: "Use small positive list sizes.",
        tags: ["algorithms", "binary search"],
        collection: "Computer science",
      }),
    ).toEqual({
      title: "Estimate binary search comparisons",
      objective: "Bound the comparisons required by binary search.",
      rules: "Keep the possible half.\nStop when the interval is empty.",
      examples: "Eight items need at most four comparisons.",
      exerciseConstraints: "Use small positive list sizes.",
      tags: ["algorithms", "binary search"],
      collectionName: "Computer science",
    });
  });
});

describe("normalizeAgentItemErrorCode", () => {
  it("stores domain reasons in the public underscore format", () => {
    expect(normalizeAgentItemErrorCode("skill-not-draft")).toBe("SKILL_NOT_DRAFT");
    expect(normalizeAgentItemErrorCode("verification_failed")).toBe("VERIFICATION_FAILED");
  });
});
