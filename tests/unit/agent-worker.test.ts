import { describe, expect, it } from "vitest";

import { SkillStatus } from "@/generated/prisma/client";
import { classifyAgentDuplicate } from "@/lib/agent-access/worker";

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
