import { expect, it, vi } from "vitest";
const { auth } = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@clerk/nextjs/server", () => ({ auth }));
import { GET } from "@/app/api/auth/status/route";

it.each([null, "user_private_id"])("returns only a non-cacheable sign-in boolean for %s", async userId => {
  auth.mockResolvedValue({ userId });
  const response = await GET();
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ signedIn: Boolean(userId) });
});
