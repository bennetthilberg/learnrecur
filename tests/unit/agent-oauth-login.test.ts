import { describe, expect, it } from "vitest";

import {
  createExternalAuthCookie,
  parseExternalAuthCookie,
  requireWorkosCompletionRedirect,
} from "@/lib/agent-access/oauth-login";

describe("WorkOS standalone login handoff", () => {
  const secret = "cookie-secret-that-is-at-least-thirty-two-characters";

  it("round-trips a short-lived signed external auth transaction", () => {
    const cookie = createExternalAuthCookie("ext_auth_123", secret, 1_000);

    expect(parseExternalAuthCookie(cookie, secret, 1_299)).toBe("ext_auth_123");
    expect(parseExternalAuthCookie(cookie, secret, 1_301)).toBeNull();
  });

  it("rejects tampering and oversized transaction identifiers", () => {
    const cookie = createExternalAuthCookie("ext_auth_123", secret, 1_000);

    expect(parseExternalAuthCookie(`${cookie}x`, secret, 1_100)).toBeNull();
    expect(() => createExternalAuthCookie("x".repeat(201), secret, 1_000)).toThrow();
  });

  it("only accepts the configured AuthKit completion redirect", () => {
    expect(
      requireWorkosCompletionRedirect(
        "https://learnrecur.authkit.app/oauth/authorize/complete?state=signed",
        "https://learnrecur.authkit.app",
      ).toString(),
    ).toBe("https://learnrecur.authkit.app/oauth/authorize/complete?state=signed");

    expect(() =>
      requireWorkosCompletionRedirect(
        "https://attacker.example/oauth/authorize/complete?state=signed",
        "https://learnrecur.authkit.app",
      ),
    ).toThrow();
    expect(() =>
      requireWorkosCompletionRedirect(
        "https://learnrecur.authkit.app/other?state=signed",
        "https://learnrecur.authkit.app",
      ),
    ).toThrow();
  });
});
