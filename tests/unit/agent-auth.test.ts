import { describe, expect, it } from "vitest";

import {
  deriveConnectionScopesFromAuthorizedGrant,
  getAgentAccessConfig,
  isAgentClientIdAllowed,
  isJwksProviderFailure,
  parseAgentAccessTokenClaims,
} from "@/lib/agent-access/auth";

describe("agent access configuration", () => {
  it("is disabled by default without requiring WorkOS secrets", () => {
    expect(getAgentAccessConfig({ NODE_ENV: "test" })).toEqual({ enabled: false });
  });

  it("requires exact HTTPS resource, issuer, origin, and client allowlists when enabled", () => {
    const config = getAgentAccessConfig({
      NODE_ENV: "production",
      AGENT_SKILL_CREATION_ENABLED: "1",
      MCP_RESOURCE_URL: "https://learnrecur.com/mcp",
      MCP_ALLOWED_ORIGINS: "https://learnrecur.com,https://chatgpt.com",
      MCP_ALLOWED_CLIENT_IDS: "https://agent.example/client.json,client_static_1",
      WORKOS_AUTHKIT_ISSUER: "https://learnrecur.authkit.app",
      WORKOS_API_KEY: "sk_test_workos",
      AGENT_OAUTH_COOKIE_SECRET: "a".repeat(32),
      MCP_ALLOW_VERIFIED_CIMD_CLIENTS: "1",
    });

    expect(config).toMatchObject({
      enabled: true,
      resourceUrl: "https://learnrecur.com/mcp",
      allowedOrigins: ["https://chatgpt.com", "https://learnrecur.com"],
      allowedClientIds: ["client_static_1", "https://agent.example/client.json"],
      allowVerifiedCimdClients: true,
      permissionVersion: 1,
    });

    expect(() =>
      getAgentAccessConfig({
        NODE_ENV: "production",
        AGENT_SKILL_CREATION_ENABLED: "1",
        MCP_RESOURCE_URL: "http://localhost:3000/mcp",
      }),
    ).toThrow();
  });

  it("admits WorkOS-verified HTTPS metadata clients without opening opaque client IDs", () => {
    const config = getAgentAccessConfig({
      NODE_ENV: "production",
      AGENT_SKILL_CREATION_ENABLED: "1",
      MCP_RESOURCE_URL: "https://learnrecur.com/mcp",
      MCP_ALLOWED_ORIGINS: "https://learnrecur.com",
      MCP_ALLOWED_CLIENT_IDS: "client_static_1",
      MCP_ALLOW_VERIFIED_CIMD_CLIENTS: "1",
      WORKOS_AUTHKIT_ISSUER: "https://learnrecur.authkit.app",
      WORKOS_API_KEY: "sk_test_workos",
      AGENT_OAUTH_COOKIE_SECRET: "a".repeat(32),
    });

    expect(isAgentClientIdAllowed("client_static_1", config)).toBe(true);
    expect(isAgentClientIdAllowed("https://agent.example/oauth/client.json", config)).toBe(true);
    expect(isAgentClientIdAllowed("client_unregistered", config)).toBe(false);
    expect(isAgentClientIdAllowed("http://agent.example/oauth/client.json", config)).toBe(false);
    expect(isAgentClientIdAllowed("https://agent.example", config)).toBe(false);
    expect(isAgentClientIdAllowed("https://user:pass@agent.example/client.json", config)).toBe(false);
    expect(isAgentClientIdAllowed("https://agent.example/client.json?redirect=evil", config)).toBe(false);
    expect(isAgentClientIdAllowed("https://agent.example/client.json#fragment", config)).toBe(false);
  });

  it("allows CIMD-only admission without a dummy static client ID", () => {
    const config = getAgentAccessConfig({
      NODE_ENV: "production",
      AGENT_SKILL_CREATION_ENABLED: "1",
      MCP_RESOURCE_URL: "https://learnrecur.com/mcp",
      MCP_ALLOWED_ORIGINS: "https://learnrecur.com",
      MCP_ALLOW_VERIFIED_CIMD_CLIENTS: "1",
      WORKOS_AUTHKIT_ISSUER: "https://learnrecur.authkit.app",
      WORKOS_API_KEY: "sk_test_workos",
      AGENT_OAUTH_COOKIE_SECRET: "a".repeat(32),
    });

    expect(config).toMatchObject({
      enabled: true,
      allowedClientIds: [],
      allowVerifiedCimdClients: true,
    });
  });

  it("fails closed when no client admission mechanism is configured", () => {
    expect(() =>
      getAgentAccessConfig({
        NODE_ENV: "production",
        AGENT_SKILL_CREATION_ENABLED: "1",
        MCP_RESOURCE_URL: "https://learnrecur.com/mcp",
        MCP_ALLOWED_ORIGINS: "https://learnrecur.com",
        WORKOS_AUTHKIT_ISSUER: "https://learnrecur.authkit.app",
        WORKOS_API_KEY: "sk_test_workos",
        AGENT_OAUTH_COOKIE_SECRET: "a".repeat(32),
      }),
    ).toThrow(/client admission/i);
  });

  it("keeps metadata clients behind an explicit launch switch", () => {
    const config = getAgentAccessConfig({
      NODE_ENV: "production",
      AGENT_SKILL_CREATION_ENABLED: "1",
      MCP_RESOURCE_URL: "https://learnrecur.com/mcp",
      MCP_ALLOWED_ORIGINS: "https://learnrecur.com",
      MCP_ALLOWED_CLIENT_IDS: "client_static_1",
      WORKOS_AUTHKIT_ISSUER: "https://learnrecur.authkit.app",
      WORKOS_API_KEY: "sk_test_workos",
      AGENT_OAUTH_COOKIE_SECRET: "a".repeat(32),
    });

    expect(config).toMatchObject({ allowVerifiedCimdClients: false });
    expect(isAgentClientIdAllowed("https://agent.example/oauth/client.json", config)).toBe(false);
  });

  it("requires subject, grant, client, expiry, and supported custom scopes", () => {
    expect(
      parseAgentAccessTokenClaims({
        sub: "user_clerk_1",
        sid: "app_consent_1",
        client_id: "client_static_1",
        exp: 2_000_000_000,
        scope: "skills:create materials:read offline_access",
      }),
    ).toEqual({
      subject: "user_clerk_1",
      sessionId: "app_consent_1",
      clientId: "client_static_1",
      expiresAt: 2_000_000_000,
      scopes: ["materials:read", "skills:create"],
    });

    expect(() =>
      parseAgentAccessTokenClaims({
        sub: "user_clerk_1",
        sid: "app_consent_1",
        exp: 2_000_000_000,
        scope: "skills:create",
      }),
    ).toThrow(/client_id/);
    expect(() =>
      parseAgentAccessTokenClaims({
        sub: "user_clerk_1",
        sid: "app_consent_1",
        client_id: "client_static_1",
        exp: 2_000_000_000,
        scope: "openid profile",
      }),
    ).toThrow(/custom scope/i);
  });

  it("separates remote JWKS failures from invalid bearer tokens", () => {
    expect(isJwksProviderFailure(Object.assign(new Error("timeout"), {
      code: "ERR_JWKS_TIMEOUT",
    }))).toBe(true);
    expect(isJwksProviderFailure(Object.assign(new Error("bad response"), {
      code: "ERR_JOSE_GENERIC",
    }))).toBe(true);
    expect(isJwksProviderFailure(new TypeError("network error"))).toBe(true);
    expect(isJwksProviderFailure(Object.assign(new Error("bad signature"), {
      code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
    }))).toBe(false);
    expect(isJwksProviderFailure(new Error("invalid token"))).toBe(false);
  });

  it("uses signed token scopes when WorkOS omits custom grant scopes", () => {
    expect(
      deriveConnectionScopesFromAuthorizedGrant({
        usesPkce: true,
        tokenScopes: ["materials:read", "skills:create", "sources:upload"],
      }),
    ).toEqual(["materials:read", "skills:create", "sources:upload"]);
    expect(
      deriveConnectionScopesFromAuthorizedGrant({
        usesPkce: false,
        tokenScopes: ["skills:create"],
      }),
    ).toBeNull();
  });
});
