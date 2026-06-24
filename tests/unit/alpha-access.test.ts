import { describe, expect, it } from "vitest";

import { checkAlphaAccessForEmail } from "@/lib/alpha-access";

describe("alpha access checks", () => {
  it("allows everyone when no alpha allowlist is configured", () => {
    expect(
      checkAlphaAccessForEmail("learner@example.com", {
        ALPHA_ALLOWED_EMAILS: "",
        ALPHA_ALLOWED_DOMAINS: "",
      }),
    ).toEqual({
      allowed: true,
      reason: "open",
    });
  });

  it("allows exact emails case-insensitively", () => {
    expect(
      checkAlphaAccessForEmail("Ada@Example.com", {
        ALPHA_ALLOWED_EMAILS: " ada@example.com,grace@example.com ",
        ALPHA_ALLOWED_DOMAINS: "",
      }),
    ).toEqual({
      allowed: true,
      reason: "email",
    });
  });

  it("allows configured domains with or without a leading at sign", () => {
    expect(
      checkAlphaAccessForEmail("learner@school.edu", {
        ALPHA_ALLOWED_EMAILS: "",
        ALPHA_ALLOWED_DOMAINS: "@school.edu example.org",
      }),
    ).toEqual({
      allowed: true,
      reason: "domain",
    });
  });

  it("denies missing or unlisted emails when an allowlist is configured", () => {
    expect(
      checkAlphaAccessForEmail(null, {
        ALPHA_ALLOWED_EMAILS: "founder@example.com",
        ALPHA_ALLOWED_DOMAINS: "",
      }),
    ).toMatchObject({
      allowed: false,
      reason: "missing-email",
    });

    expect(
      checkAlphaAccessForEmail("other@example.com", {
        ALPHA_ALLOWED_EMAILS: "founder@example.com",
        ALPHA_ALLOWED_DOMAINS: "",
      }),
    ).toMatchObject({
      allowed: false,
      reason: "not-allowed",
    });
  });
});
