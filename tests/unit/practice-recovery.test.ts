// @vitest-environment jsdom
import { expect, it } from "vitest";
import { z } from "zod";
import { readRecovery, writeRecovery, recoveryKey } from "@/lib/practice/recovery";
it("keeps the in-flight review separate from the next answer and isolates accounts and scopes", () => {
  const key = recoveryKey("one", "normal", "all");
  const schema = z.object({ answer: z.string(), attemptId: z.string() });
  const recovery = { current: { answer: "next", attemptId: "2" }, pending: { answer: "first", attemptId: "1" } };
  expect(writeRecovery(key, recovery)).toBe(true);
  expect(readRecovery(key, schema)).toEqual({ version: 1, ...recovery });
  expect(readRecovery(recoveryKey("two", "normal", "all"), schema)).toBeNull();
  expect(readRecovery(recoveryKey("one", "normal", "collection"), schema)).toBeNull();
  sessionStorage.setItem(key, '{"version":1,"current":{"answer":42}}');
  expect(readRecovery(key, schema)).toBeNull();
  expect(writeRecovery(key, null)).toBe(true);
  expect(sessionStorage.getItem(key)).toBeNull();
});
