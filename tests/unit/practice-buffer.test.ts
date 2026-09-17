import { expect, it } from "vitest";
import { appendPracticeBuffer, PRACTICE_BUFFER_SIZE } from "@/lib/practice/buffer";

it("keeps the existing order, removes duplicates, and bounds lookahead", () => {
  const current = [3, 1];
  expect(appendPracticeBuffer(current, [1, 2, 3, 4], String)).toEqual([3, 1, 2, 4]);
  expect(current).toEqual([3, 1]);
  expect(appendPracticeBuffer(current, Array.from({ length: 30 }, (_, i) => i), String)).toHaveLength(PRACTICE_BUFFER_SIZE);
});
