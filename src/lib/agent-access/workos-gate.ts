import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

export const workosAuthorizationServerMetadataSchema = z
  .object({
    issuer: nonEmptyString.url(),
    authorization_endpoint: nonEmptyString.url(),
    token_endpoint: nonEmptyString.url(),
    jwks_uri: nonEmptyString.url(),
    code_challenge_methods_supported: z.array(nonEmptyString),
    grant_types_supported: z.array(nonEmptyString),
  })
  .passthrough();

export type WorkosGateTokenEvidence = {
  issuer: string;
  audience: string | string[];
  subject: string;
  sessionId: string;
  expiresAt: number;
  scopes: string[];
};

export type WorkosGateEvidence = {
  canonicalResource: string;
  expectedClerkUserId: string;
  requiredScopes: string[];
  metadata: z.infer<typeof workosAuthorizationServerMetadataSchema>;
  initialToken: WorkosGateTokenEvidence;
  refreshedToken: WorkosGateTokenEvidence;
  workosUser: {
    id: string;
    externalId: string | null;
  };
  authorizedApplication: {
    applicationId: string;
    clientId: string;
    oauthResource: string | null;
    grantedScopes: string[];
    usesPkce: boolean;
  };
  refreshRotated: boolean;
  reusedRefreshRejected: boolean;
  grantDeletionSucceeded: boolean;
  refreshAfterDeletionRejected: boolean;
};

export type WorkosGateCheck = {
  id: string;
  passed: boolean;
  message: string;
};

export type WorkosGateResult = {
  passed: boolean;
  checks: WorkosGateCheck[];
};

export function parseScopeClaim(value: unknown): string[] {
  if (typeof value === "string") {
    return normalizeScopes(value.split(/\s+/));
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return normalizeScopes(value);
  }

  return [];
}

export function evaluateWorkosGateEvidence(
  evidence: WorkosGateEvidence,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
): WorkosGateResult {
  const requiredScopes = new Set(normalizeScopes(evidence.requiredScopes));
  const initialScopes = new Set(normalizeScopes(evidence.initialToken.scopes));
  const refreshedScopes = new Set(normalizeScopes(evidence.refreshedToken.scopes));
  const grantedScopes = new Set(
    normalizeScopes(evidence.authorizedApplication.grantedScopes),
  );
  const exactAudience = (audience: string | string[]) =>
    typeof audience === "string"
      ? audience === evidence.canonicalResource
      : audience.length === 1 && audience[0] === evidence.canonicalResource;
  const hasEveryScope = (scopes: Set<string>) =>
    [...requiredScopes].every((scope) => scopes.has(scope));

  const checks: WorkosGateCheck[] = [
    check(
      "metadata_issuer",
      evidence.metadata.issuer === evidence.initialToken.issuer &&
        evidence.metadata.issuer === evidence.refreshedToken.issuer,
      "Metadata issuer matches both signed tokens.",
    ),
    check(
      "authorization_code_pkce",
      evidence.metadata.code_challenge_methods_supported.includes("S256") &&
        evidence.metadata.grant_types_supported.includes("authorization_code") &&
        evidence.metadata.grant_types_supported.includes("refresh_token") &&
        evidence.authorizedApplication.usesPkce,
      "Authorization code, refresh token, and PKCE S256 are enforced.",
    ),
    check(
      "exact_resource_audience",
      exactAudience(evidence.initialToken.audience) &&
        exactAudience(evidence.refreshedToken.audience) &&
        evidence.authorizedApplication.oauthResource === evidence.canonicalResource,
      "Initial token, refreshed token, and grant are bound to the exact MCP resource.",
    ),
    check(
      "immutable_identity_mapping",
      evidence.initialToken.subject === evidence.refreshedToken.subject &&
        evidence.initialToken.subject === evidence.expectedClerkUserId &&
        evidence.workosUser.externalId === evidence.expectedClerkUserId,
      "The token subject and WorkOS external identity match the immutable Clerk user ID.",
    ),
    check(
      "stable_grant",
      evidence.initialToken.sessionId.length > 0 &&
        evidence.initialToken.sessionId === evidence.refreshedToken.sessionId &&
        evidence.authorizedApplication.applicationId.length > 0 &&
        evidence.authorizedApplication.clientId.length > 0,
      "The grant identity remains stable across refresh.",
    ),
    check(
      "custom_scopes",
      hasEveryScope(initialScopes) &&
        hasEveryScope(refreshedScopes) &&
        hasEveryScope(grantedScopes),
      "Required custom scopes are present on the grant and both tokens.",
    ),
    check(
      "token_expiry",
      evidence.initialToken.expiresAt > nowEpochSeconds &&
        evidence.refreshedToken.expiresAt > nowEpochSeconds,
      "Both access tokens are unexpired.",
    ),
    check(
      "refresh_rotation",
      evidence.refreshRotated && evidence.reusedRefreshRejected,
      "Refresh rotation succeeds and reuse is rejected.",
    ),
    check(
      "grant_revocation",
      evidence.grantDeletionSucceeded && evidence.refreshAfterDeletionRejected,
      "Deleting the authorized application prevents further refresh.",
    ),
  ];

  return {
    passed: checks.every((entry) => entry.passed),
    checks,
  };
}

function normalizeScopes(scopes: string[]): string[] {
  return [...new Set(scopes.map((scope) => scope.trim()).filter(Boolean))].sort();
}

function check(id: string, passed: boolean, message: string): WorkosGateCheck {
  return { id, passed, message };
}
