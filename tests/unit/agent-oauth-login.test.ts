import { beforeEach, describe, expect, it, vi } from "vitest";

const prismaMocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  queryRaw: vi.fn(),
  findDeletionJob: vi.fn(),
  findConflictingIdentity: vi.fn(),
  upsertIdentity: vi.fn(),
  updateUser: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({ $transaction: prismaMocks.transaction }),
}));

import {
  createExternalAuthCookie,
  completeWorkosStandaloneAuth,
  getWorkosStandaloneAuthErrorCode,
  parseExternalAuthCookie,
  requireWorkosCompletionRedirect,
  WorkosStandaloneAuthError,
} from "@/lib/agent-access/oauth-login";

describe("WorkOS standalone login handoff", () => {
  const secret = "cookie-secret-that-is-at-least-thirty-two-characters";

  beforeEach(() => {
    vi.clearAllMocks();
    prismaMocks.queryRaw.mockResolvedValue([]);
    prismaMocks.findDeletionJob.mockResolvedValue(null);
    prismaMocks.findConflictingIdentity.mockResolvedValue(null);
    prismaMocks.upsertIdentity.mockResolvedValue({});
    prismaMocks.updateUser.mockResolvedValue({});
    prismaMocks.transaction.mockImplementation(async (callback) =>
      callback({
        $queryRaw: prismaMocks.queryRaw,
        accountDeletionJob: { findUnique: prismaMocks.findDeletionJob },
        workosIdentity: {
          findFirst: prismaMocks.findConflictingIdentity,
          upsert: prismaMocks.upsertIdentity,
        },
        user: { update: prismaMocks.updateUser },
      }),
    );
  });

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
    expect(
      requireWorkosCompletionRedirect(
        "https://learnrecur.authkit.app/oauth2/external/callback?state=signed",
        "https://learnrecur.authkit.app",
      ).toString(),
    ).toBe("https://learnrecur.authkit.app/oauth2/external/callback?state=signed");

    expect(() =>
      requireWorkosCompletionRedirect(
        "https://attacker.example/oauth/authorize/complete?state=signed",
        "https://learnrecur.authkit.app",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "completion_redirect_origin_invalid" }),
    );
    expect(() =>
      requireWorkosCompletionRedirect(
        "https://learnrecur.authkit.app/other?state=signed",
        "https://learnrecur.authkit.app",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "completion_redirect_path_invalid" }),
    );
    expect(() =>
      requireWorkosCompletionRedirect(
        "https://learnrecur.authkit.app/oauth/authorize/complete?state=signed#unsafe",
        "https://learnrecur.authkit.app",
      ),
    ).toThrowError(expect.objectContaining({ code: "completion_redirect_unsafe" }));
  });

  it("reduces standalone failures to non-sensitive diagnostic codes", () => {
    expect(
      getWorkosStandaloneAuthErrorCode(
        new WorkosStandaloneAuthError(
          "identity_lookup_http_error",
          "WorkOS identity lookup failed.",
        ),
      ),
    ).toBe("identity_lookup_http_error");
    expect(getWorkosStandaloneAuthErrorCode(new Error("private response body"))).toBe(
      "unexpected",
    );
  });

  it("revokes a newly issued remote grant instead of persisting it during deletion", async () => {
    prismaMocks.findDeletionJob.mockResolvedValue({ id: "deletion-job-1" });
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          redirect_uri: "https://learnrecur.authkit.app/oauth/authorize/complete?state=signed",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ id: "workos-user-1", external_id: "user_1" }),
      )
      .mockResolvedValueOnce(
        Response.json({
          data: [{ application: { id: "app-1" }, oauth_resource: "https://learnrecur.example/mcp" }],
          list_metadata: { after: null },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    await expect(
      completeWorkosStandaloneAuth({
        externalAuthId: "external-auth-1",
        clerkUser: { id: "user_1", email: "user@example.com" },
        config: {
          enabled: true,
          resourceUrl: "https://learnrecur.example/mcp",
          resourceHost: "learnrecur.example",
          resourceOrigin: "https://learnrecur.example",
          workosIssuer: "https://learnrecur.authkit.app",
          workosApiKey: "sk_test_fixture",
          oauthCookieSecret: secret,
          allowedOrigins: ["https://learnrecur.example"],
          allowedClientIds: ["https://client.example/client.json"],
          allowVerifiedCimdClients: false,
          permissionVersion: 1,
        },
        fetchImpl,
      }),
    ).rejects.toMatchObject({ code: "account_deletion_in_progress" });

    expect(prismaMocks.upsertIdentity).not.toHaveBeenCalled();
    expect(String(fetchImpl.mock.calls[2]?.[0])).toContain("authorized_applications");
    expect(fetchImpl.mock.calls[3]?.[1]).toMatchObject({ method: "DELETE" });
  });
});
