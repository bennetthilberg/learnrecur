import { describe, expect, it } from "vitest";
import { checkAnswer, textAnswerSpecSchema } from "@/lib/answer-checking";
import {
  NATURAL_TEXT_POLICY, EXACT_TEXT_POLICY, resolvePracticePreference,
  resolveTextPolicy, textPolicySchema, textAnswerContract,
} from "@/lib/practice/policies";

describe("effective practice policy", () => {
  it("resolves explicit Balanced and resets through skill, collection, user, fallback", () => {
    expect(resolvePracticePreference({})).toBe("BALANCED");
    expect(resolvePracticePreference({ user: "RECALL_FIRST" })).toBe("RECALL_FIRST");
    expect(resolvePracticePreference({ user: "RECALL_FIRST", collection: "BALANCED" })).toBe("BALANCED");
    expect(resolvePracticePreference({ user: "BALANCED", collection: "RECALL_FIRST", skill: "BALANCED" })).toBe("BALANCED");
    expect(resolvePracticePreference({ user: "BALANCED", collection: "RECALL_FIRST", skill: null })).toBe("RECALL_FIRST");
    expect(resolveTextPolicy({ collection: EXACT_TEXT_POLICY })).toEqual(EXACT_TEXT_POLICY);
    expect(resolveTextPolicy({ collection: EXACT_TEXT_POLICY, skill: NATURAL_TEXT_POLICY })).toEqual(NATURAL_TEXT_POLICY);
    expect(resolveTextPolicy({})).toEqual(NATURAL_TEXT_POLICY);
  });
  it("rejects contradictory named profiles and unsupported versions", () => {
    expect(textPolicySchema.safeParse({ ...EXACT_TEXT_POLICY, normalizeCase: true }).success).toBe(false);
    expect(textPolicySchema.safeParse({ ...NATURAL_TEXT_POLICY, version: 3 }).success).toBe(false);
  });
});

describe("versioned faithful text grading", () => {
  it.each([["año", "ano"], ["él", "el"], ["habló", "hablo"], ["côte", "cote"], ["schön", "schon"]])("preserves %s / %s", (accepted, answer) => {
    expect(checkAnswer({ answerSpec: textAnswerContract([accepted], NATURAL_TEXT_POLICY), submittedAnswer: answer }).isCorrect).toBe(false);
  });
  it("accepts canonical Unicode, intentional case/space leniency, and explicit alternatives", () => {
    const answerSpec = textAnswerContract(["Él llegó", "Ella llegó"], NATURAL_TEXT_POLICY);
    expect(checkAnswer({ answerSpec, submittedAnswer: "  E\u0301L   LLEGO\u0301  " }).isCorrect).toBe(true);
    expect(checkAnswer({ answerSpec, submittedAnswer: "Ella llegó" }).isCorrect).toBe(true);
  });
  it("preserves technical case and exact whitespace including leading spaces", () => {
    const answerSpec = textAnswerContract(["  Content-Type"], EXACT_TEXT_POLICY);
    expect(checkAnswer({ answerSpec, submittedAnswer: "  Content-Type" }).isCorrect).toBe(true);
    for (const submittedAnswer of ["Content-Type", "  content-type", " Content-Type"]) {
      expect(checkAnswer({ answerSpec, submittedAnswer }).isCorrect).toBe(false);
    }
  });
  it("keeps legacy interpretation and rejects v2 blanket folding", () => {
    expect(checkAnswer({ answerSpec: {kind:"text", accepted:["Año Nuevo"]}, submittedAnswer: "ano nuevo" }).isCorrect).toBe(true);
    expect(textAnswerSpecSchema.safeParse({ ...textAnswerContract(["año"], NATURAL_TEXT_POLICY), normalizeDiacritics: true }).success).toBe(false);
  });
});
