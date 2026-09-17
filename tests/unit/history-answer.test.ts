import { expect, it } from "vitest";
import { formatSubmittedHistoryAnswer } from "@/lib/practice/history-answer";
it.each([
  ["b", [{ id: "a", label: "es" }, { id: "b", label: "está" }], "está"],
  [{ raw: "b" }, [{ id: "b", label: "está" }], "está"],
  [{ raw: { secret: true } }, null, "Answer unavailable"],
  ["12x", null, "12x"], [4, null, "4"], ["", null, "No answer"],
  [{ private: "data" }, null, "Answer unavailable"], ["legacy", [], "legacy"],
])("formats the submitted answer without leaking arbitrary objects", (answer, choices, expected) => {
  expect(formatSubmittedHistoryAnswer(answer, choices)).toBe(expected);
});
