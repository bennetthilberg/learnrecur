import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthInfo } from "@modelcontextprotocol/server";

import type { AgentAccessScope, AgentAuthContext } from "@/lib/agent-access/auth";
import { AgentOperationError } from "@/lib/agent-access/operations";

type SetupHandler = (
  auth: AgentAuthContext,
  input: unknown,
) => Promise<Record<string, unknown>>;

const { applyAgentSetup, previewAgentSetup } = vi.hoisted(() => ({
  applyAgentSetup: vi.fn<SetupHandler>(),
  previewAgentSetup: vi.fn<SetupHandler>(),
}));

vi.mock("@/lib/agent-access/setup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-access/setup")>()),
  applyAgentSetup,
  previewAgentSetup,
}));

import { registerLearnRecurMcpTools } from "@/lib/agent-access/mcp";

type RegisteredTool = {
  options: {
    _meta: {
      securitySchemes: Array<{ type: "oauth2"; scopes: string[] }>;
    };
  };
  callback: (
    input: Record<string, unknown>,
    context: { http: { authInfo: AuthInfo } },
  ) => Promise<{ isError?: boolean; structuredContent?: unknown }>;
};

function registeredTools() {
  const tools = new Map<string, RegisteredTool>();
  registerLearnRecurMcpTools({
    registerTool(
      name: string,
      options: RegisteredTool["options"],
      callback: RegisteredTool["callback"],
    ) {
      tools.set(name, { options, callback });
    },
  } as never);
  return tools;
}

function authInfo(scopes: AgentAccessScope[]): AuthInfo {
  return {
    token: "test-token",
    clientId: "https://agent.example/client.json",
    scopes,
    expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
    resource: new URL("https://learnrecur.com/mcp"),
    extra: {
      userId: "user-1",
      connectionId: "connection-1",
      workosSubject: "user-1",
      workosSessionId: "session-1",
      clientName: "Test agent",
      clientDomain: "agent.example",
    },
  };
}

function dynamicPracticePlanHandler(
  auth: AgentAuthContext,
  input: unknown,
) {
  if (!auth.scopes.includes("practice:write")) {
    throw new AgentOperationError(
      "permission_denied",
      "Agent permission practice:write is required for this setup plan.",
    );
  }
  return Promise.resolve({ plan_id: String((input as { plan_id?: string }).plan_id), status: "succeeded" });
}

describe("MCP setup registry authorization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    applyAgentSetup.mockImplementation(dynamicPracticePlanHandler);
    previewAgentSetup.mockImplementation(dynamicPracticePlanHandler);
  });

  it("advertises only base setup consent while the service checks plan scopes", () => {
    const tools = registeredTools();

    expect(tools.get("setup.preview")?.options._meta.securitySchemes).toEqual([
      { type: "oauth2", scopes: ["setup:write"] },
    ]);
    expect(tools.get("setup.apply")?.options._meta.securitySchemes).toEqual([
      { type: "oauth2", scopes: ["setup:write"] },
    ]);
  });

  it("passes a practice-only plan to dynamic preflight and denies missing practice consent", async () => {
    const tools = registeredTools();
    const apply = tools.get("setup.apply");
    if (!apply) throw new Error("setup.apply was not registered");

    const allowed = await apply.callback(
      { plan_id: "practice-plan" },
      { http: { authInfo: authInfo(["setup:write", "practice:write"]) } },
    );
    expect(allowed.isError).not.toBe(true);
    expect(allowed.structuredContent).toEqual({
      plan_id: "practice-plan",
      status: "succeeded",
    });
    expect(applyAgentSetup).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ["setup:write", "practice:write"] }),
      { plan_id: "practice-plan" },
    );

    const denied = await apply.callback(
      { plan_id: "practice-plan" },
      { http: { authInfo: authInfo(["setup:write"]) } },
    );
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toEqual({
      code: "permission_denied",
      message: "Agent permission practice:write is required for this setup plan.",
      retryable: false,
    });
  });
});
