import { config as loadEnv } from "dotenv";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";

import {
  evaluateWorkosGateEvidence,
  parseScopeClaim,
  workosAuthorizationServerMetadataSchema,
  type WorkosGateTokenEvidence,
} from "../src/lib/agent-access/workos-gate";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

const gateEnvSchema = z.object({
  MCP_RESOURCE_URL: z.string().url(),
  WORKOS_AUTHKIT_ISSUER: z.string().url(),
  WORKOS_API_KEY: z.string().trim().min(1),
  WORKOS_MCP_GATE_EXPECTED_CLERK_USER_ID: z.string().trim().min(1),
  WORKOS_MCP_GATE_CLIENT_ID: z.string().trim().min(1),
  WORKOS_MCP_GATE_CLIENT_SECRET: z.string().optional().default(""),
  WORKOS_MCP_GATE_ACCESS_TOKEN: z.string().trim().min(1),
  WORKOS_MCP_GATE_REFRESH_TOKEN: z.string().trim().min(1),
  WORKOS_MCP_GATE_REVOCATION_CLIENT_ID: z.string().trim().min(1),
  WORKOS_MCP_GATE_REVOCATION_CLIENT_SECRET: z.string().optional().default(""),
  WORKOS_MCP_GATE_REVOCATION_REFRESH_TOKEN: z.string().trim().min(1),
  WORKOS_MCP_GATE_ALLOW_DESTRUCTIVE: z.literal("1"),
});

type AuthorizedApplication = {
  oauth_resource?: string | null;
  granted_scopes?: string[];
  application?: {
    id?: string;
    client_id?: string;
    uses_pkce?: boolean;
  };
};

async function main() {
  const parsedEnv = gateEnvSchema.safeParse(process.env);

  if (!parsedEnv.success) {
    console.error("WorkOS MCP staging gate did not run. Missing or invalid inputs:");
    for (const issue of parsedEnv.error.issues) {
      console.error(`- ${issue.path.join(".") || "environment"}: ${issue.message}`);
    }
    console.error(
      "Use two disposable staging grants. The gate rotates one refresh-token family and deletes the other grant.",
    );
    process.exit(2);
  }

  const env = parsedEnv.data;
  const issuer = withoutTrailingSlash(env.WORKOS_AUTHKIT_ISSUER);
  const metadata = workosAuthorizationServerMetadataSchema.parse(
    await fetchJson(`${issuer}/.well-known/oauth-authorization-server`),
  );
  if (withoutTrailingSlash(metadata.issuer) !== issuer) {
    throw new Error("WorkOS metadata issuer does not exactly match WORKOS_AUTHKIT_ISSUER.");
  }

  const jwks = createRemoteJWKSet(new URL(metadata.jwks_uri));
  const initialToken = await verifyAccessToken(
    env.WORKOS_MCP_GATE_ACCESS_TOKEN,
    metadata.issuer,
    env.MCP_RESOURCE_URL,
    jwks,
  );
  const workosUser = await fetchWorkosUser(initialToken.subject, env.WORKOS_API_KEY);
  const applications = await listAuthorizedApplications(
    initialToken.subject,
    env.WORKOS_API_KEY,
  );
  const rotationApplication = requireAuthorizedApplication(
    applications,
    env.WORKOS_MCP_GATE_CLIENT_ID,
    env.MCP_RESOURCE_URL,
  );
  const revocationApplication = requireAuthorizedApplication(
    applications,
    env.WORKOS_MCP_GATE_REVOCATION_CLIENT_ID,
    env.MCP_RESOURCE_URL,
  );

  const firstRefresh = await exchangeRefreshToken({
    endpoint: metadata.token_endpoint,
    clientId: env.WORKOS_MCP_GATE_CLIENT_ID,
    clientSecret: env.WORKOS_MCP_GATE_CLIENT_SECRET,
    refreshToken: env.WORKOS_MCP_GATE_REFRESH_TOKEN,
  });
  const refreshedToken = await verifyAccessToken(
    firstRefresh.accessToken,
    metadata.issuer,
    env.MCP_RESOURCE_URL,
    jwks,
  );
  const reusedRefreshRejected = await refreshIsRejected({
    endpoint: metadata.token_endpoint,
    clientId: env.WORKOS_MCP_GATE_CLIENT_ID,
    clientSecret: env.WORKOS_MCP_GATE_CLIENT_SECRET,
    refreshToken: env.WORKOS_MCP_GATE_REFRESH_TOKEN,
  });

  const grantDeletionSucceeded = await deleteAuthorizedApplication({
    userId: initialToken.subject,
    applicationId: revocationApplication.application?.id ?? "",
    apiKey: env.WORKOS_API_KEY,
  });
  const refreshAfterDeletionRejected = await refreshIsRejected({
    endpoint: metadata.token_endpoint,
    clientId: env.WORKOS_MCP_GATE_REVOCATION_CLIENT_ID,
    clientSecret: env.WORKOS_MCP_GATE_REVOCATION_CLIENT_SECRET,
    refreshToken: env.WORKOS_MCP_GATE_REVOCATION_REFRESH_TOKEN,
  });

  const result = evaluateWorkosGateEvidence({
    canonicalResource: env.MCP_RESOURCE_URL,
    expectedClerkUserId: env.WORKOS_MCP_GATE_EXPECTED_CLERK_USER_ID,
    requiredScopes: ["skills:create", "materials:read", "sources:upload"],
    metadata,
    initialToken,
    refreshedToken,
    workosUser,
    authorizedApplication: {
      applicationId: rotationApplication.application?.id ?? "",
      clientId: rotationApplication.application?.client_id ?? "",
      oauthResource: rotationApplication.oauth_resource ?? null,
      grantedScopes: rotationApplication.granted_scopes ?? [],
      usesPkce: rotationApplication.application?.uses_pkce === true,
    },
    refreshRotated:
      firstRefresh.refreshToken.length > 0 &&
      firstRefresh.refreshToken !== env.WORKOS_MCP_GATE_REFRESH_TOKEN,
    reusedRefreshRejected,
    grantDeletionSucceeded,
    refreshAfterDeletionRejected,
  });

  for (const check of result.checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"} ${check.id}: ${check.message}`);
  }

  if (!result.passed) {
    console.error("WorkOS MCP staging gate failed. Keep AGENT_SKILL_CREATION_ENABLED=0.");
    process.exit(1);
  }

  console.log("WorkOS MCP staging gate passed for the supplied disposable grants.");
}

async function verifyAccessToken(
  token: string,
  issuer: string,
  audience: string,
  jwks: ReturnType<typeof createRemoteJWKSet>,
): Promise<WorkosGateTokenEvidence> {
  const { payload } = await jwtVerify(token, jwks, { issuer, audience });
  const subject = requiredClaim(payload, "sub");
  const sessionId = requiredClaim(payload, "sid");
  if (typeof payload.exp !== "number") {
    throw new Error("Access token is missing a numeric exp claim.");
  }

  return {
    issuer: requiredClaim(payload, "iss"),
    audience: payload.aud ?? "",
    subject,
    sessionId,
    expiresAt: payload.exp,
    scopes: parseScopeClaim(payload.scope ?? payload.scopes),
  };
}

function requiredClaim(payload: JWTPayload, claim: string): string {
  const value = payload[claim];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Access token is missing a non-empty ${claim} claim.`);
  }
  return value;
}

async function fetchWorkosUser(userId: string, apiKey: string) {
  const value = z
    .object({ id: z.string(), external_id: z.string().nullable().optional() })
    .passthrough()
    .parse(
      await fetchJson(`https://api.workos.com/user_management/users/${encodeURIComponent(userId)}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      }),
    );
  return { id: value.id, externalId: value.external_id ?? null };
}

async function listAuthorizedApplications(userId: string, apiKey: string) {
  const value = z
    .object({ data: z.array(z.record(z.string(), z.unknown())) })
    .passthrough()
    .parse(
      await fetchJson(
        `https://api.workos.com/user_management/users/${encodeURIComponent(userId)}/authorized_applications?limit=100`,
        { headers: { authorization: `Bearer ${apiKey}` } },
      ),
    );
  return value.data as AuthorizedApplication[];
}

function requireAuthorizedApplication(
  applications: AuthorizedApplication[],
  clientId: string,
  resource: string,
) {
  const application = applications.find(
    (entry) =>
      entry.application?.client_id === clientId && entry.oauth_resource === resource,
  );
  if (!application?.application?.id) {
    throw new Error(`No authorized application matches the configured client and MCP resource.`);
  }
  return application;
}

async function exchangeRefreshToken(input: {
  endpoint: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: input.clientId,
    refresh_token: input.refreshToken,
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  const response = await fetch(input.endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Refresh exchange failed with HTTP ${response.status}.`);
  const value = z
    .object({
      access_token: z.string().min(1),
      refresh_token: z.string().min(1),
      token_type: z.string(),
    })
    .passthrough()
    .parse(await response.json());
  return { accessToken: value.access_token, refreshToken: value.refresh_token };
}

async function refreshIsRejected(input: {
  endpoint: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: input.clientId,
    refresh_token: input.refreshToken,
  });
  if (input.clientSecret) body.set("client_secret", input.clientSecret);
  const response = await fetch(input.endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "error",
  });
  return !response.ok;
}

async function deleteAuthorizedApplication(input: {
  userId: string;
  applicationId: string;
  apiKey: string;
}) {
  const response = await fetch(
    `https://api.workos.com/user_management/users/${encodeURIComponent(input.userId)}/authorized_applications/${encodeURIComponent(input.applicationId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${input.apiKey}` },
      redirect: "error",
    },
  );
  return response.ok;
}

async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(url, { ...init, redirect: "error" });
  if (!response.ok) throw new Error(`Request to ${new URL(url).origin} failed with HTTP ${response.status}.`);
  return response.json();
}

function withoutTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "WorkOS MCP staging gate failed.");
  process.exit(1);
});
