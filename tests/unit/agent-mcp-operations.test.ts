import { beforeEach, describe, expect, it, vi } from "vitest";

const { getAgentMaterialOperationStatus, getAgentOperation } = vi.hoisted(() => ({
  getAgentMaterialOperationStatus: vi.fn(),
  getAgentOperation: vi.fn(),
}));

vi.mock("@/lib/agent-access/material-ingestion", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-access/material-ingestion")>()),
  getAgentMaterialOperationStatus,
}));
vi.mock("@/lib/agent-access/operations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-access/operations")>()),
  getAgentOperation,
}));

import { registerLearnRecurMcpTools } from "@/lib/agent-access/mcp";

const authInfo = {
  token: "test-token",
  clientId: "https://agent.example/client.json",
  scopes: ["materials:read"],
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

type RegisteredTool = {
  options: {
    _meta: {
      securitySchemes: Array<{ type: "oauth2"; scopes: string[] }>;
    };
  };
  callback: (
    input: { operation_id: string },
    context: { http: { authInfo: typeof authInfo } },
  ) => Promise<{ structuredContent?: unknown }>;
};

function registeredTools() {
  const tools = new Map<string, RegisteredTool>();
  registerLearnRecurMcpTools({
    registerTool(name: string, options: RegisteredTool["options"], callback: RegisteredTool["callback"]) {
      tools.set(name, { options, callback });
    },
  } as never);
  return tools;
}

describe("MCP material operation polling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("allows a materials-read connection to poll a terminal material operation", async () => {
    const terminal = {
      operation_id: "operation-1",
      operation_uri: "learnrecur://material-operations/operation-1",
      status: "succeeded",
      material_id: "material-1",
      material_revision_id: "revision-1",
      source_file_id: "source-1",
      error_code: null,
      error_message: null,
      created_at: "2026-09-08T12:00:00.000Z",
      updated_at: "2026-09-08T12:01:00.000Z",
      completed_at: "2026-09-08T12:01:00.000Z",
      retryable: false,
    };
    getAgentMaterialOperationStatus.mockResolvedValue(terminal);

    const operationTool = registeredTools().get("operations.get");
    if (!operationTool) throw new Error("operations.get was not registered");

    expect(operationTool.options._meta.securitySchemes).toEqual([
      { type: "oauth2", scopes: ["skills:create"] },
      { type: "oauth2", scopes: ["materials:read"] },
      { type: "oauth2", scopes: ["sources:upload"] },
    ]);

    const result = await operationTool.callback(
      { operation_id: "operation-1" },
      { http: { authInfo } },
    );

    expect(getAgentMaterialOperationStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        connectionId: "connection-1",
        scopes: ["materials:read"],
      }),
      "operation-1",
    );
    expect(getAgentOperation).not.toHaveBeenCalled();
    expect(result.structuredContent).toEqual(terminal);
    expect(result.structuredContent).not.toHaveProperty("poll_after_ms");
  });
});
