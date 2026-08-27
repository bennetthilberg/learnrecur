import "server-only";

import type { AuthInfo as McpAuthInfo } from "@modelcontextprotocol/server";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { z } from "zod";

import { AgentConnectionStatus } from "@/generated/prisma/client";
import { parseScopeClaim } from "@/lib/agent-access/workos-gate";
import { getPrisma } from "@/lib/prisma";

export const AGENT_ACCESS_SCOPES = [
  "skills:create",
  "materials:read",
  "sources:upload",
] as const;

export type AgentAccessScope = (typeof AGENT_ACCESS_SCOPES)[number];

export type DisabledAgentAccessConfig = { enabled: false };
export type EnabledAgentAccessConfig = {
  enabled: true;
  resourceUrl: string;
  resourceHost: string;
  resourceOrigin: string;
  workosIssuer: string;
  workosApiKey: string;
  oauthCookieSecret: string;
  allowedOrigins: string[];
  allowedClientIds: string[];
  allowVerifiedCimdClients: boolean;
  permissionVersion: number;
};
export type AgentAccessConfig = DisabledAgentAccessConfig | EnabledAgentAccessConfig;

export type AgentAccessTokenClaims = {
  subject: string;
  sessionId: string;
  clientId: string;
  expiresAt: number;
  scopes: AgentAccessScope[];
};

export type AgentAuthContext = AgentAccessTokenClaims & {
  userId: string;
  connectionId: string;
  clientName: string;
  clientDomain: string;
  resourceUrl: string;
};

export class AgentAccessAuthorizationError extends Error {
  constructor(readonly code: "authentication_required" | "permission_denied", message: string) {
    super(message);
    this.name = "AgentAccessAuthorizationError";
  }
}

const jwksByIssuer = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

type AgentAuthFailureReason =
  | "jwt_invalid"
  | "jwks_provider_unavailable"
  | "claims_invalid"
  | "client_not_allowed"
  | "identity_mapping_missing_or_disabled"
  | "authorized_grant_lookup_http_error"
  | "authorized_grant_response_invalid"
  | "authorized_grant_match_count"
  | "authorized_grant_pkce_missing"
  | "authorized_grant_scope_mismatch"
  | "connection_mismatch_or_inactive"
  | "verification_exception";

type AgentAuthFailureDetails =
  | { status: number }
  | { matchCount: number }
  | { errorName: string }
  | Record<string, never>;

const agentAuthFailureLastLoggedAt = new Map<AgentAuthFailureReason, number>();
const AGENT_AUTH_FAILURE_LOG_INTERVAL_MS = 60_000;

function recordAgentAuthFailure(
  reason: AgentAuthFailureReason,
  details: AgentAuthFailureDetails = {},
) {
  const now = Date.now();
  const lastLoggedAt = agentAuthFailureLastLoggedAt.get(reason);
  if (lastLoggedAt !== undefined && now - lastLoggedAt < AGENT_AUTH_FAILURE_LOG_INTERVAL_MS) {
    return;
  }
  agentAuthFailureLastLoggedAt.set(reason, now);
  console.warn("[agent-access] bearer authentication rejected", { reason, ...details });
}

export function isJwksProviderFailure(error: unknown) {
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = error.code;
  return (
    code === "ERR_JOSE_GENERIC" ||
    code === "ERR_JWK_INVALID" ||
    code === "ERR_JWKS_INVALID" ||
    code === "ERR_JWKS_TIMEOUT"
  );
}

export function getAgentAccessConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentAccessConfig {
  if (env.AGENT_SKILL_CREATION_ENABLED !== "1") return { enabled: false };

  const parsed = z
    .object({
      MCP_RESOURCE_URL: z.string().url(),
      MCP_ALLOWED_ORIGINS: z.string().trim().min(1),
      MCP_ALLOWED_CLIENT_IDS: z.string().trim().default(""),
      WORKOS_AUTHKIT_ISSUER: z.string().url(),
      WORKOS_API_KEY: z.string().trim().min(1),
      AGENT_OAUTH_COOKIE_SECRET: z.string().min(32),
      MCP_ALLOW_VERIFIED_CIMD_CLIENTS: z.enum(["0", "1"]).default("0"),
      AGENT_PERMISSION_VERSION: z.coerce.number().int().positive().default(1),
    })
    .parse(env);
  const resource = requireSecureUrl(parsed.MCP_RESOURCE_URL, "MCP_RESOURCE_URL", true);
  const issuer = requireSecureUrl(parsed.WORKOS_AUTHKIT_ISSUER, "WORKOS_AUTHKIT_ISSUER", false);
  const allowedOrigins = normalizeCsv(parsed.MCP_ALLOWED_ORIGINS).map((value) =>
    requireOrigin(value, "MCP_ALLOWED_ORIGINS"),
  );
  const allowedClientIds = normalizeCsv(parsed.MCP_ALLOWED_CLIENT_IDS);
  const allowVerifiedCimdClients = parsed.MCP_ALLOW_VERIFIED_CIMD_CLIENTS === "1";

  if (!allowedOrigins.includes(resource.origin)) {
    throw new Error("MCP_ALLOWED_ORIGINS must include the MCP resource origin.");
  }
  if (allowedClientIds.length === 0 && !allowVerifiedCimdClients) {
    throw new Error(
      "Agent access requires at least one client admission mechanism: MCP_ALLOWED_CLIENT_IDS or MCP_ALLOW_VERIFIED_CIMD_CLIENTS=1.",
    );
  }

  return {
    enabled: true,
    resourceUrl: resource.toString(),
    resourceHost: resource.hostname,
    resourceOrigin: resource.origin,
    workosIssuer: withoutTrailingSlash(issuer.toString()),
    workosApiKey: parsed.WORKOS_API_KEY,
    oauthCookieSecret: parsed.AGENT_OAUTH_COOKIE_SECRET,
    allowedOrigins,
    allowedClientIds,
    allowVerifiedCimdClients,
    permissionVersion: parsed.AGENT_PERMISSION_VERSION,
  };
}

export function isAgentClientIdAllowed(
  clientId: string,
  config: Pick<EnabledAgentAccessConfig, "allowedClientIds" | "allowVerifiedCimdClients">,
) {
  if (config.allowedClientIds.includes(clientId)) return true;
  if (!config.allowVerifiedCimdClients) return false;

  try {
    const metadataUrl = new URL(clientId);
    return (
      metadataUrl.protocol === "https:" &&
      metadataUrl.pathname !== "/" &&
      !metadataUrl.username &&
      !metadataUrl.password &&
      !metadataUrl.search &&
      !metadataUrl.hash
    );
  } catch {
    return false;
  }
}

export function parseAgentAccessTokenClaims(payload: JWTPayload): AgentAccessTokenClaims {
  const subject = requiredStringClaim(payload, "sub");
  const sessionId = requiredStringClaim(payload, "sid");
  const clientId = requiredStringClaim(payload, "client_id");
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) {
    throw new Error("Agent access token requires a numeric exp claim.");
  }
  const scopes = parseScopeClaim(payload.scope ?? payload.scopes).filter(
    (scope): scope is AgentAccessScope =>
      (AGENT_ACCESS_SCOPES as readonly string[]).includes(scope),
  );
  if (scopes.length === 0) {
    throw new Error("Agent access token requires at least one supported custom scope.");
  }

  return { subject, sessionId, clientId, expiresAt: payload.exp, scopes };
}

export async function verifyAgentBearerToken(
  _request: Request,
  bearerToken?: string,
): Promise<McpAuthInfo | undefined> {
  const config = getAgentAccessConfig();
  if (!config.enabled || !bearerToken) return undefined;

  try {
    if (!jwksByIssuer.has(config.workosIssuer)) {
      jwksByIssuer.set(
        config.workosIssuer,
        createRemoteJWKSet(new URL(`${config.workosIssuer}/oauth2/jwks`)),
      );
    }
    const jwks = jwksByIssuer.get(config.workosIssuer);
    if (!jwks) return undefined;
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(bearerToken, jwks, {
        issuer: config.workosIssuer,
        audience: config.resourceUrl,
      }));
    } catch (error) {
      recordAgentAuthFailure(
        isJwksProviderFailure(error) ? "jwks_provider_unavailable" : "jwt_invalid",
      );
      return undefined;
    }
    let claims: AgentAccessTokenClaims;
    try {
      claims = parseAgentAccessTokenClaims(payload);
    } catch {
      recordAgentAuthFailure("claims_invalid");
      return undefined;
    }
    if (!isAgentClientIdAllowed(claims.clientId, config)) {
      recordAgentAuthFailure("client_not_allowed");
      return undefined;
    }
    const context = await resolveAgentAuthContext(claims, config);
    if (!context) return undefined;

    return {
      token: bearerToken,
      clientId: context.clientId,
      scopes: context.scopes,
      expiresAt: context.expiresAt,
      resource: new URL(config.resourceUrl),
      extra: {
        userId: context.userId,
        connectionId: context.connectionId,
        workosSubject: context.subject,
        workosSessionId: context.sessionId,
        clientName: context.clientName,
        clientDomain: context.clientDomain,
      },
    };
  } catch (error) {
    recordAgentAuthFailure("verification_exception", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return undefined;
  }
}

export function requireAgentAuthContext(
  authInfo: McpAuthInfo | undefined,
  requiredScopes: readonly AgentAccessScope[],
): AgentAuthContext {
  if (!authInfo) {
    throw new AgentAccessAuthorizationError(
      "authentication_required",
      "Connect LearnRecur and approve the required permissions.",
    );
  }
  const missingScope = requiredScopes.find((scope) => !authInfo.scopes.includes(scope));
  if (missingScope) {
    throw new AgentAccessAuthorizationError(
      "permission_denied",
      `Agent permission ${missingScope} is required.`,
    );
  }
  const value = z
    .object({
      userId: z.string().min(1),
      connectionId: z.string().min(1),
      workosSubject: z.string().min(1),
      workosSessionId: z.string().min(1),
      clientName: z.string().min(1),
      clientDomain: z.string().min(1),
    })
    .parse(authInfo.extra);
  if (!authInfo.resource || typeof authInfo.expiresAt !== "number") {
    throw new Error("Agent authentication metadata is incomplete.");
  }
  return {
    userId: value.userId,
    connectionId: value.connectionId,
    subject: value.workosSubject,
    sessionId: value.workosSessionId,
    clientId: authInfo.clientId,
    clientName: value.clientName,
    clientDomain: value.clientDomain,
    resourceUrl: authInfo.resource.toString(),
    expiresAt: authInfo.expiresAt,
    scopes: authInfo.scopes.filter(
      (scope): scope is AgentAccessScope =>
        (AGENT_ACCESS_SCOPES as readonly string[]).includes(scope),
    ),
  };
}

async function resolveAgentAuthContext(
  claims: AgentAccessTokenClaims,
  config: EnabledAgentAccessConfig,
): Promise<AgentAuthContext | null> {
  const prisma = getPrisma();
  const identity = await prisma.workosIdentity.findUnique({
    where: { externalId: claims.subject },
    include: { user: { select: { agentAccessDisabledAt: true } } },
  });
  if (
    !identity ||
    identity.externalId !== identity.userId ||
    claims.subject !== identity.externalId ||
    identity.user.agentAccessDisabledAt
  ) {
    recordAgentAuthFailure("identity_mapping_missing_or_disabled");
    return null;
  }

  let connection = await prisma.agentConnection.findUnique({
    where: { workosSessionId: claims.sessionId },
  });
  if (!connection) {
    const grant = await fetchAuthorizedGrant({
      workosUserId: identity.workosUserId,
      clientId: claims.clientId,
      resourceUrl: config.resourceUrl,
      apiKey: config.workosApiKey,
    });
    if (!grant) {
      return null;
    }
    if (!grant.usesPkce) {
      recordAgentAuthFailure("authorized_grant_pkce_missing");
      return null;
    }
    if (!claims.scopes.every((scope) => grant.scopes.includes(scope))) {
      recordAgentAuthFailure("authorized_grant_scope_mismatch");
      return null;
    }
    connection = await prisma.agentConnection.create({
      data: {
        userId: identity.userId,
        workosIdentityId: identity.id,
        workosSubject: claims.subject,
        workosSessionId: claims.sessionId,
        workosApplicationId: grant.applicationId,
        clientId: claims.clientId,
        clientName: grant.clientName,
        clientDomain: clientDomain(claims.clientId),
        resourceUrl: config.resourceUrl,
        scopes: claims.scopes,
        permissionVersion: config.permissionVersion,
      },
    });
  }

  if (
    connection.userId !== identity.userId ||
    connection.workosSubject !== claims.subject ||
    connection.clientId !== claims.clientId ||
    connection.resourceUrl !== config.resourceUrl ||
    connection.permissionVersion !== config.permissionVersion ||
    connection.status !== AgentConnectionStatus.ACTIVE ||
    !claims.scopes.every((scope) => connection.scopes.includes(scope))
  ) {
    recordAgentAuthFailure("connection_mismatch_or_inactive");
    return null;
  }

  await prisma.agentConnection.update({
    where: { id: connection.id },
    data: { lastUsedAt: new Date() },
  });
  return {
    ...claims,
    userId: identity.userId,
    connectionId: connection.id,
    clientName: connection.clientName,
    clientDomain: connection.clientDomain,
    resourceUrl: connection.resourceUrl,
  };
}

async function fetchAuthorizedGrant(input: {
  workosUserId: string;
  clientId: string;
  resourceUrl: string;
  apiKey: string;
}) {
  const response = await fetch(
    `https://api.workos.com/user_management/users/${encodeURIComponent(input.workosUserId)}/authorized_applications?limit=100`,
    {
      headers: { authorization: `Bearer ${input.apiKey}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    recordAgentAuthFailure("authorized_grant_lookup_http_error", {
      status: response.status,
    });
    return null;
  }
  const parsed = z
    .object({
      data: z.array(
        z.object({
          oauth_resource: z.string().nullable().optional(),
          granted_scopes: z.array(z.string()),
          application: z.object({
            id: z.string(),
            client_id: z.string(),
            name: z.string(),
            uses_pkce: z.boolean(),
          }),
        }),
      ),
    })
    .safeParse(await response.json());
  if (!parsed.success) {
    recordAgentAuthFailure("authorized_grant_response_invalid");
    return null;
  }
  const value = parsed.data;
  const matches = value.data.filter(
    (entry) =>
      entry.application.client_id === input.clientId &&
      (entry.oauth_resource == null || entry.oauth_resource === input.resourceUrl),
  );
  if (matches.length !== 1) {
    recordAgentAuthFailure("authorized_grant_match_count", {
      matchCount: matches.length,
    });
    return null;
  }
  const match = matches[0];
  return {
    applicationId: match.application.id,
    clientName: match.application.name.trim() || clientDomain(input.clientId),
    usesPkce: match.application.uses_pkce,
    scopes: parseScopeClaim(match.granted_scopes),
  };
}

function requiredStringClaim(payload: JWTPayload, claim: string) {
  const value = payload[claim];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Agent access token requires a non-empty ${claim} claim.`);
  }
  return value;
}

function normalizeCsv(value: string) {
  return [...new Set(value.split(",").map((entry) => entry.trim()).filter(Boolean))].sort();
}

function requireSecureUrl(value: string, name: string, requirePath: boolean) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be a credential-free HTTPS URL without query or fragment.`);
  }
  if (requirePath && (url.pathname === "/" || url.pathname.endsWith("/"))) {
    throw new Error(`${name} must contain an exact non-root path without a trailing slash.`);
  }
  return url;
}

function requireOrigin(value: string, name: string) {
  const url = requireSecureUrl(value, name, false);
  if (url.pathname !== "/") throw new Error(`${name} entries must be origins without paths.`);
  return url.origin;
}

function clientDomain(clientId: string) {
  try {
    return new URL(clientId).hostname;
  } catch {
    return "registered client";
  }
}

function withoutTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}
