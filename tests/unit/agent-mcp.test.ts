import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerLearnRecurMcpTools,
  mcpCorsOptionsResponse,
  toPublicError,
  validateMcpHttpRequest,
} from "@/lib/agent-access/mcp";
import { AgentOperationError } from "@/lib/agent-access/operations";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

function enable() {
  Object.assign(process.env, {
    AGENT_SKILL_CREATION_ENABLED: "1",
    MCP_RESOURCE_URL: "https://learnrecur.com/mcp",
    MCP_ALLOWED_ORIGINS: "https://learnrecur.com,https://claude.ai",
    MCP_ALLOWED_CLIENT_IDS: "https://claude.ai/client.json",
    WORKOS_AUTHKIT_ISSUER: "https://learnrecur-staging.authkit.app",
    WORKOS_API_KEY: "sk_test_example",
    AGENT_OAUTH_COOKIE_SECRET: "a-secure-cookie-secret-at-least-32-bytes",
  });
}

describe("validateMcpHttpRequest", () => {
  it("is not discoverable while the feature is disabled", () => {
    delete process.env.AGENT_SKILL_CREATION_ENABLED;
    expect(validateMcpHttpRequest(new Request("https://learnrecur.com/mcp"))?.status).toBe(404);
  });

  it("rejects host-header and browser-origin confusion", () => {
    enable();
    expect(validateMcpHttpRequest(new Request("https://internal/mcp", { headers: { host: "evil.example" } }))?.status).toBe(421);
    expect(validateMcpHttpRequest(new Request("https://learnrecur.com/mcp", { headers: { host: "learnrecur.com", origin: "https://evil.example" } }))?.status).toBe(403);
  });

  it("accepts a configured host and optional configured origin", () => {
    enable();
    expect(validateMcpHttpRequest(new Request("https://learnrecur.com/mcp", { headers: { host: "learnrecur.com", origin: "https://claude.ai" } }))).toBeNull();
    expect(validateMcpHttpRequest(new Request("https://learnrecur.com/mcp", { headers: { host: "learnrecur.com" } }))).toBeNull();
  });

  it("rejects plaintext transport and returns bounded CORS to allowed origins", () => {
    enable();
    expect(
      validateMcpHttpRequest(
        new Request("http://learnrecur.com/mcp", { headers: { host: "learnrecur.com" } }),
      )?.status,
    ).toBe(400);
    const response = mcpCorsOptionsResponse(
      new Request("https://learnrecur.com/mcp", {
        method: "OPTIONS",
        headers: { host: "learnrecur.com", origin: "https://claude.ai" },
      }),
    );
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    expect(response.headers.get("access-control-allow-headers")).toContain("MCP-Protocol-Version");
  });
});

describe("toPublicError", () => {
  it("keeps stable operation codes without leaking internals", () => {
    expect(toPublicError(new AgentOperationError("idempotency_conflict", "Use a new key."))).toEqual({
      code: "idempotency_conflict",
      message: "Use a new key.",
      retryable: false,
    });
    expect(toPublicError(new AgentOperationError("setup_in_progress", "Retry after the current result is available."))).toEqual({
      code: "setup_in_progress",
      message: "Retry after the current result is available.",
      retryable: true,
    });
    expect(toPublicError(new AgentOperationError("setup_stale", "Preview a new plan."))).toEqual({
      code: "setup_stale",
      message: "Preview a new plan.",
      retryable: false,
    });
    expect(toPublicError(new Error("postgres password secret"))).toEqual({
      code: "internal_error",
      message: "LearnRecur could not complete the request.",
      retryable: true,
    });
  });
});

describe("registerLearnRecurMcpTools", () => {
  it("publishes the complete bounded beta tool surface", () => {
    const registerTool = vi.fn();
    registerLearnRecurMcpTools({ registerTool } as never);
    expect(registerTool.mock.calls.map(([name]) => name)).toEqual([
      "practice.list_targets",
      "practice.get_settings",
      "practice.update_settings",
      "practice.sessions.create",
      "practice.sessions.get",
      "practice.sessions.stop",
      "practice.sessions.resume",
      "skills.search",
      "skills.get",
      "skills.update",
      "skills.lifecycle",
      "skills.pause",
      "skills.resume",
      "skills.archive",
      "skills.restore",
      "skills.batch_update",
      "collections.create",
      "collections.update",
      "collections.lifecycle",
      "collections.archive",
      "collections.restore",
      "reminders.get",
      "reminders.update",
      "progress.summary",
      "progress.needs_attention",
      "readiness.get",
      "readiness.repair",
      "setup.preview",
      "setup.apply",
      "setup.get",
      "skills.add_from_specs",
      "skills.add_from_text",
      "skills.add_from_material",
      "skills.prepare_files",
      "skills.start_files",
      "materials.list",
      "materials.get_outline",
      "materials.search_excerpts",
      "materials.prepare_upload",
      "materials.complete_upload",
      "materials.import_url",
      "materials.get_status",
      "materials.retry_ingestion",
      "operations.get",
      "operations.continue",
      "operations.retry_failed",
    ]);
  });

  it("marks lifecycle mutations as potentially destructive", () => {
    const registerTool = vi.fn();
    registerLearnRecurMcpTools({ registerTool } as never);
    const optionsFor = (name: string) =>
      registerTool.mock.calls.find(([registeredName]) => registeredName === name)?.[1] as {
        annotations: { destructiveHint: boolean };
      };

    expect(optionsFor("skills.lifecycle").annotations.destructiveHint).toBe(true);
    expect(optionsFor("skills.archive").annotations.destructiveHint).toBe(true);
    expect(optionsFor("collections.lifecycle").annotations.destructiveHint).toBe(true);
    expect(optionsFor("collections.archive").annotations.destructiveHint).toBe(true);
    expect(optionsFor("skills.update").annotations.destructiveHint).toBe(false);
    expect(optionsFor("progress.summary").annotations.destructiveHint).toBe(false);
  });
});

describe("MCP resource discovery", () => {
  it("publishes exact protected-resource metadata and challenges missing bearer tokens", async () => {
    enable();
    const metadataRoute = await import(
      "@/app/.well-known/oauth-protected-resource/mcp/route"
    );
    const metadataResponse = metadataRoute.GET();
    expect(metadataResponse.status).toBe(200);
    await expect(metadataResponse.json()).resolves.toMatchObject({
      resource: "https://learnrecur.com/mcp",
      authorization_servers: ["https://learnrecur-staging.authkit.app"],
      scopes_supported: ["skills:create", "skills:read", "skills:write", "collections:read", "collections:write", "materials:read", "sources:upload", "practice:read", "practice:write", "reminders:read", "reminders:write", "progress:read", "setup:read", "setup:write"],
      bearer_methods_supported: ["header"],
    });

    const mcpRoute = await import("@/app/mcp/route");
    const response = await mcpRoute.POST(
      new Request("https://learnrecur.com/mcp", {
        method: "POST",
        headers: {
          host: "learnrecur.com",
          "content-type": "application/json",
          "mcp-protocol-version": "2026-07-28",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://learnrecur.com/.well-known/oauth-protected-resource/mcp"',
    );
  });
});
