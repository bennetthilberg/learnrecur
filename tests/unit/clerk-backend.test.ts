import { afterEach, describe, expect, it, vi } from "vitest";
const createClient = vi.hoisted(() => vi.fn(() => ({ users: {} })));
vi.mock("@clerk/backend", () => ({ createClerkClient: createClient }));
import { createClerkServiceClient } from "@/lib/clerk/backend";

describe("Clerk outside a Next.js request", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
  it("uses the current worker secret without a publishable key or request context", () => {
    vi.stubEnv("CLERK_SECRET_KEY", "worker-secret");
    createClerkServiceClient();
    expect(createClient).toHaveBeenCalledWith({ secretKey: "worker-secret" });
    vi.stubEnv("CLERK_SECRET_KEY", "rotated-secret");
    createClerkServiceClient();
    expect(createClient).toHaveBeenLastCalledWith({ secretKey: "rotated-secret" });
  });
  it("rejects missing credentials before attempting a provider call", () => {
    vi.stubEnv("CLERK_SECRET_KEY", "");
    expect(() => createClerkServiceClient()).toThrow("CLERK_SECRET_KEY is required");
    expect(createClient).not.toHaveBeenCalled();
  });
});
