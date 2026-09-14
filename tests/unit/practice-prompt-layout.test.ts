import { describe, expect, it } from "vitest";
import { splitPracticePrompt } from "@/lib/practice/prompt-layout";

describe("practice prompt layout", () => {
  it.each([" ", "\n", "\n\n", "\r\n\r\n"])("separates explicit directions with %j", (separator) => {
    expect(splitPracticePrompt(`Choose the correct verb:${separator}Carlos y Mateo ___ médicos.`)).toEqual({
      instruction: "Choose the correct verb:", content: "Carlos y Mateo ___ médicos.",
    });
  });
  it("retains math and multi-paragraph content", () => {
    expect(splitPracticePrompt("Simplify the expression.\n\n$x + x$\n\nGive an exact answer.")).toEqual({
      instruction: "Simplify the expression.", content: "$x + x$\n\nGive an exact answer.",
    });
  });
  it.each(["What is 2 + 2?", "Choose the correct verb.", "At 12:30, Carlos left.\nWhen did he arrive?", "A triangle has three sides.\nCalculate its area.", "Calculate $a:b$ for the following values:\n$a=2$", "Complete:"])("preserves an unsplit prompt: %s", (prompt) => {
    expect(splitPracticePrompt(prompt)).toEqual({ instruction: null, content: prompt });
  });
});
