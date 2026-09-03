import { describe, expect, it } from "vitest";

import robots from "@/app/robots";
import {
  getAlphaAccessPolicy,
  isAlphaEmailAllowed,
  isAlphaUserAllowed,
  normalizeAlphaEmail,
} from "@/lib/alpha-access";

describe("alpha access", () => {
  it("keeps non-production environments open", () => {
    const policy = getAlphaAccessPolicy({ NODE_ENV: "test" });

    expect(policy).toEqual({ mode: "open" });
    expect(isAlphaEmailAllowed(policy, "anyone@example.com")).toBe(true);
  });

  it("fails closed in production when the allowlist is empty or invalid", () => {
    expect(getAlphaAccessPolicy({ NODE_ENV: "production" })).toEqual({ mode: "closed" });
    expect(
      getAlphaAccessPolicy({
        NODE_ENV: "production",
        ALPHA_ALLOWED_EMAILS: "approved@example.com, not-an-email",
      }),
    ).toEqual({ mode: "closed" });
  });

  it("allows only normalized exact production email matches", () => {
    const policy = getAlphaAccessPolicy({
      NODE_ENV: "production",
      ALPHA_ALLOWED_EMAILS: " Approved@Example.com, second@example.com\napproved@example.com ",
    });

    expect(policy).toEqual({
      mode: "allowlist",
      allowedEmails: ["approved@example.com", "second@example.com"],
    });
    expect(isAlphaEmailAllowed(policy, "  APPROVED@example.com ")).toBe(true);
    expect(isAlphaEmailAllowed(policy, "approved+other@example.com")).toBe(false);
    expect(isAlphaEmailAllowed(policy, null)).toBe(false);
    expect(normalizeAlphaEmail("  Person@Example.COM ")).toBe("person@example.com");
  });

  it("checks the live verified primary identity for allowlisted users", async () => {
    const policy = getAlphaAccessPolicy({
      NODE_ENV: "production",
      ALPHA_ALLOWED_EMAILS: "approved@example.com",
    });

    await expect(
      isAlphaUserAllowed("user_1", policy, async () => ({
        primaryEmailAddress: {
          emailAddress: "approved@example.com",
          verification: { status: "verified" },
        },
      })),
    ).resolves.toBe(true);
    await expect(
      isAlphaUserAllowed("user_1", policy, async () => ({
        primaryEmailAddress: {
          emailAddress: "approved@example.com",
          verification: { status: "unverified" },
        },
      })),
    ).resolves.toBe(false);
    await expect(
      isAlphaUserAllowed("user_1", policy, async () => ({
        primaryEmailAddress: {
          emailAddress: "removed@example.com",
          verification: { status: "verified" },
        },
      })),
    ).resolves.toBe(false);
  });

  it("fails closed on identity lookup errors without calling Clerk in open mode", async () => {
    let calls = 0;
    const loadUser = async () => {
      calls += 1;
      throw new Error("Clerk unavailable");
    };

    await expect(
      isAlphaUserAllowed("user_1", { mode: "open" }, loadUser),
    ).resolves.toBe(true);
    expect(calls).toBe(0);

    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      isAlphaUserAllowed(
        "user_1",
        { mode: "allowlist", allowedEmails: ["approved@example.com"] },
        loadUser,
      ),
    ).resolves.toBe(false);
    expect(calls).toBe(1);
    consoleError.mockRestore();
  });

  it("disallows all crawlers", () => {
    expect(robots()).toEqual({
      rules: {
        userAgent: "*",
        disallow: "/",
      },
    });
  });
});
