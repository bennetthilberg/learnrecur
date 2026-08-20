import { describe, expect, it } from "vitest";

import {
  getAgentAccessConfig,
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
    });

    expect(config).toMatchObject({
      enabled: true,
      resourceUrl: "https://learnrecur.com/mcp",
      allowedOrigins: ["https://chatgpt.com", "https://learnrecur.com"],
      allowedClientIds: ["client_static_1", "https://agent.example/client.json"],
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
});
