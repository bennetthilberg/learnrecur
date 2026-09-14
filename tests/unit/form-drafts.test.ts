// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { formDraftKey, readFormDraft, writeFormDraft } from "@/lib/forms/drafts";
const schema = z.object({ title: z.string() });
afterEach(() => { sessionStorage.clear(); vi.restoreAllMocks(); });
it("isolates accounts and scopes and invalidates drafts when saved values change", () => {
  const key = formDraftKey("alice", "settings");
  expect(writeFormDraft(key, "original", { title: "Edited" })).toBe(true);
  expect(readFormDraft(key, "original", schema)).toEqual({ title: "Edited" });
  expect(readFormDraft(formDraftKey("bob", "settings"), "original", schema)).toBeNull();
  expect(readFormDraft(formDraftKey("alice", "creation"), "original", schema)).toBeNull();
  expect(readFormDraft(key, "updated-on-server", schema)).toBeNull();
  writeFormDraft(key, "original", null);
  expect(readFormDraft(key, "original", schema)).toBeNull();
});
it("rejects malformed, oversized and wrong-shaped data", () => {
  for (const raw of ["not json", JSON.stringify({ baseline: "a", value: { title: 5 } }), "x".repeat(200_001)]) {
    sessionStorage.setItem("key", raw);
    expect(readFormDraft("key", "a", schema)).toBeNull();
  }
  expect(writeFormDraft("key", "a", { title: "x".repeat(200_001) })).toBe(false);
});
it("reports unavailable browser storage without crashing", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(writeFormDraft("key", "a", { title: "hello" })).toBe(false);
});
it("recovers the latest draft when writes fail, including removal over older saved data", () => {
  const key = formDraftKey("fallback", "settings");
  expect(writeFormDraft(key, "a", { title: "Old" })).toBe(true);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(writeFormDraft(key, "a", { title: "Latest" })).toBe(false);
  expect(readFormDraft(key, "a", schema)).toEqual({ title: "Latest" });
  expect(readFormDraft(formDraftKey("another", "settings"), "a", schema)).toBeNull();
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("unavailable"); });
  expect(writeFormDraft(key, "a", null)).toBe(false);
  expect(readFormDraft(key, "a", schema)).toBeNull();
});
