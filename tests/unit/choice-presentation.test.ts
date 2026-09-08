import { describe, expect, it } from "vitest";
import { isUsableChoicePresentation } from "@/lib/answer-checking";

describe("choice presentation eligibility", () => {
  const spec = { kind: "choice", correctChoiceId: "right" };
  it("accepts a usable objectively answerable choice exercise", () => {
    expect(
      isUsableChoicePresentation(spec, [
        { id: "right", label: "Right" },
        { id: "wrong", label: "Wrong" },
      ]),
    ).toBe(true);
  });
  it.each([
    { choices: null },
    { choices: [] },
    { choices: [{ id: "right" }] },
    { choices: [{ id: "right", label: " " }] },
    {
      choices: [
        { id: "right", label: "Right" },
        { id: "right", label: "Again" },
      ],
    },
    { choices: [{ id: "wrong", label: "No correct choice" }] },
    { choices: [{ id: "", label: "No identifier" }] },
  ])("rejects unusable options: %j", ({ choices }) => {
    expect(isUsableChoicePresentation(spec, choices)).toBe(false);
  });
  it("rejects a mismatched answer contract", () => {
    expect(
      isUsableChoicePresentation({ kind: "text", accepted: ["right"] }, [
        { id: "right", label: "Right" },
      ]),
    ).toBe(false);
  });
});
