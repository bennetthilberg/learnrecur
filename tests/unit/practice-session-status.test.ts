import { afterEach, expect, it, vi } from "vitest";
import { practiceSessionEnded } from "@/lib/practice/session-status";

afterEach(() => vi.unstubAllGlobals());
it.each([true, false, undefined])("only reports an explicit ended session: %s", async signedIn => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ signedIn })));
  expect(await practiceSessionEnded()).toBe(signedIn === false);
});
it("does not mislabel an offline save as an ended session", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  expect(await practiceSessionEnded()).toBe(false);
});
it("does not infer an ended session from a server failure", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
  expect(await practiceSessionEnded()).toBe(false);
});
