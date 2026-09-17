import { describe, expect, it } from "vitest";
import { getInstantPracticeFeedback } from "@/lib/practice/instant-feedback";

const base = { correctAnswerDisplay: "es", explanation: "Use ser for identity.", choices: [{ id: "a", label: "es" }, { id: "b", label: "está" }] };

describe("instant practice feedback", () => {
  it.each([["a", true, "GOOD"], ["b", false, "AGAIN"]])("checks choice %s locally", (answer, correct, rating) => {
    expect(getInstantPracticeFeedback({ ...base, answerSpec: { kind: "choice", correctChoiceId: "a" } }, String(answer))).toMatchObject({ status: "checked", answerCheck: { isCorrect: correct }, proposedRating: rating, correctChoiceId: "a", correctAnswerDisplay: "es", explanation: base.explanation });
  });
  it("preserves accent-sensitive text grading", () => {
    const exercise = { ...base, answerSpec: { kind: "text", policyVersion: 2, accepted: ["sí"], normalizeCase: true, normalizeWhitespace: true, normalizeDiacritics: false } };
    expect(getInstantPracticeFeedback(exercise, "si").answerCheck.isCorrect).toBe(false);
    expect(getInstantPracticeFeedback(exercise, " SÍ ").answerCheck.isCorrect).toBe(true);
  });
  it("does not offer a rating for malformed input", () => {
    expect(getInstantPracticeFeedback({ ...base, answerSpec: { kind: "numeric", accepted: [2], tolerance: 0.001 } }, "garbage")).toMatchObject({ proposedRating: null, answerCheck: { status: "invalid-input" } });
  });
});
