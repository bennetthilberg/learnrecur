import { describe, expect, it } from "vitest";
import { composeStructuredPrompt, normalizeGeneratedPrompt, readStructuredPrompt } from "@/lib/practice/structured-prompt";

describe("structured exercise prompts", () => {
  it("preserves non-English instructions and math without guessing prefixes", () => {
    const parts = { instruction: "Complétez la phrase.", content: "Carlos ____ médecin.\n\\(x^2 + 1\\)" };
    const prompt = composeStructuredPrompt(parts);
    expect(readStructuredPrompt(prompt, parts)).toEqual(parts);
    expect(normalizeGeneratedPrompt({ ...parts, choices: ["est", "sont"] })).toEqual({ prompt, promptLayout: parts, choices: ["est", "sont"] });
  });
  it("allows questions without separate instructions", () => {
    expect(readStructuredPrompt("2 + 2 = ?", { instruction: "", content: "2 + 2 = ?" })).toEqual({ instruction: "", content: "2 + 2 = ?" });
  });
  it("rejects layouts that change, omit, or duplicate canonical question text", () => {
    for (const parts of [null, {}, { instruction: "Solve:", content: "Different question" }, { instruction: "Question", content: "Question" }, { instruction: "", content: "" }]) {
      expect(readStructuredPrompt("Question", parts)).toBeNull();
    }
    expect(readStructuredPrompt("a  b", { instruction: "", content: "a b" })).toBeNull();
  });
  it("leaves legacy and malformed candidates for the existing strict validator", () => {
    const legacy = { prompt: "Choose the correct answer", choices: [] };
    expect(normalizeGeneratedPrompt(legacy)).toBe(legacy);
    for (const value of [{ instruction: "Only instructions" }, { instruction: 3, content: "Question" }, { instruction: "", content: "Question", prompt: "Different" }]) {
      expect(normalizeGeneratedPrompt(value)).toBe(value);
    }
  });
});

it("renders structured instructions without changing the legacy fallback", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { createElement } = await import("react");
  const { PracticePrompt } = await import("@/app/practice/practice-prompt");
  const layout = { instruction: "Complétez la phrase.", content: "Carlos ____ médecin." };
  const html = renderToStaticMarkup(createElement(PracticePrompt, { text: composeStructuredPrompt(layout), layout }));
  expect(html).toContain('class="practiceInstruction"');
  expect(html).toContain("Complétez la phrase.");
  const fallback = renderToStaticMarkup(createElement(PracticePrompt, { text: "Original question", layout }));
  expect(fallback).toContain("Original question");
  expect(fallback).not.toContain("Complétez");
});

it("carries structured parts through choice, text, and math candidate validation", async () => {
  const { validateGeneratedChoiceExercises, validateGeneratedExactInputExercises, validateGeneratedMathExercises } = await import("@/lib/skills");
  const layout = { instruction: "Complétez la phrase.", content: "Carlos ____ médecin." };
  const choice = validateGeneratedChoiceExercises({ exercises: [{ ...layout, choices: [{ id: "a", label: "est" }, { id: "b", label: "sont" }, { id: "c", label: "sommes" }], correctChoiceId: "a", explanation: "Carlos takes the singular form est." }] }, { minValidExercises: 1 });
  const text = validateGeneratedExactInputExercises({ exercises: [{ ...layout, answerKind: "TEXT", answerSpec: { kind: "text", accepted: ["est"], normalizeCase: true, normalizeWhitespace: true, normalizeDiacritics: true }, correctAnswerDisplay: "est" }] });
  const mathLayout = { instruction: "Réduisez cette expression.", content: "x + x" };
  const math = validateGeneratedMathExercises({ exercises: [{ ...mathLayout, answerKind: "MATH", answerSpec: { kind: "math", acceptedExpressions: ["2x"], equivalence: "basic-symbolic" }, correctAnswerDisplay: "2x" }] });
  for (const [result, parts] of [[choice, layout], [text, layout], [math, mathLayout]] as const) {
    expect(result.status, JSON.stringify(result)).toBe("ready");
    if (result.status === "ready") expect(result.exercises[0]).toMatchObject({ prompt: composeStructuredPrompt(parts), promptLayout: parts });
  }
});
