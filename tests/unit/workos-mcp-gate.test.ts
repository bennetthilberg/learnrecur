import { describe, expect, it } from "vitest";

import {
  evaluateWorkosGateEvidence,
  parseScopeClaim,
  type WorkosGateEvidence,
} from "@/lib/agent-access/workos-gate";

const canonicalResource = "https://learnrecur.com/mcp";

function validEvidence(): WorkosGateEvidence {
  return {
    canonicalResource,
    expectedClerkUserId: "user_clerk_123",
    requiredScopes: ["skills:create", "materials:read", "sources:upload"],
    metadata: {
      issuer: "https://learnrecur-staging.authkit.app",
      authorization_endpoint:
        "https://learnrecur-staging.authkit.app/oauth2/authorize",
      token_endpoint: "https://learnrecur-staging.authkit.app/oauth2/token",
      jwks_uri: "https://learnrecur-staging.authkit.app/oauth2/jwks",
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    },
    initialToken: {
      issuer: "https://learnrecur-staging.authkit.app",
      audience: canonicalResource,
      subject: "user_clerk_123",
      sessionId: "app_consent_123",
      expiresAt: 2_000_000_000,
      scopes: ["skills:create", "materials:read", "sources:upload"],
    },
    refreshedToken: {
      issuer: "https://learnrecur-staging.authkit.app",
      audience: canonicalResource,
      subject: "user_clerk_123",
      sessionId: "app_consent_123",
      expiresAt: 2_000_000_100,
      scopes: ["skills:create", "materials:read", "sources:upload"],
    },
    workosUser: {
      id: "user_workos_123",
      externalId: "user_clerk_123",
    },
    authorizedApplication: {
      applicationId: "conn_app_123",
      clientId: "client_123",
      oauthResource: null,
      usesPkce: true,
    },
    refreshRotated: true,
    reusedRefreshRejected: true,
    grantDeletionSucceeded: true,
    refreshAfterDeletionRejected: true,
  };
}

describe("WorkOS MCP release gate", () => {
  it("passes only complete, audience-bound, scope-bound evidence", () => {
    const result = evaluateWorkosGateEvidence(validEvidence(), 1_900_000_000);

    expect(result.passed).toBe(true);
    expect(result.checks.every((check) => check.passed)).toBe(true);
  });

  it.each([
    ["wrong audience", (evidence: WorkosGateEvidence) => {
      evidence.initialToken.audience = "https://learnrecur.com/api";
    }],
    ["wrong advertised grant resource", (evidence: WorkosGateEvidence) => {
      evidence.authorizedApplication.oauthResource = "https://learnrecur.com/api";
    }],
    ["email-style identity remapping", (evidence: WorkosGateEvidence) => {
      evidence.workosUser.externalId = "learner@example.com";
    }],
    ["token subject that is not the Clerk user", (evidence: WorkosGateEvidence) => {
      evidence.initialToken.subject = "user_workos_123";
      evidence.refreshedToken.subject = "user_workos_123";
    }],
    ["changed grant after refresh", (evidence: WorkosGateEvidence) => {
      evidence.refreshedToken.sessionId = "app_consent_other";
    }],
    ["missing custom scope on the signed token", (evidence: WorkosGateEvidence) => {
      evidence.refreshedToken.scopes = ["skills:create"];
    }],
    ["reusable refresh token", (evidence: WorkosGateEvidence) => {
      evidence.reusedRefreshRejected = false;
    }],
    ["grant deletion that leaves refresh usable", (evidence: WorkosGateEvidence) => {
      evidence.refreshAfterDeletionRejected = false;
    }],
  ])("fails closed for %s", (_label, mutate) => {
    const evidence = validEvidence();
    mutate(evidence);

    const result = evaluateWorkosGateEvidence(evidence, 1_900_000_000);

    expect(result.passed).toBe(false);
    expect(result.checks.some((check) => !check.passed)).toBe(true);
  });

  it("trusts custom scopes from both verified tokens instead of the authorized-app response", () => {
    const evidence = validEvidence();

    const result = evaluateWorkosGateEvidence(evidence, 1_900_000_000);

    expect(result.checks.find((check) => check.id === "custom_scopes")).toEqual({
      id: "custom_scopes",
      passed: true,
      message: "Required custom scopes are present on both signed tokens.",
    });
  });

  it("normalizes space- and array-based scope claims without accepting other values", () => {
    expect(parseScopeClaim("skills:create materials:read skills:create")).toEqual([
      "materials:read",
      "skills:create",
    ]);
    expect(parseScopeClaim(["sources:upload", "skills:create"])).toEqual([
      "skills:create",
      "sources:upload",
    ]);
    expect(parseScopeClaim({ scope: "skills:create" })).toEqual([]);
  });
});
