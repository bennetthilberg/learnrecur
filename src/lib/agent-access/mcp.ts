import "server-only";

import type {
  AuthInfo,
  CallToolResult,
  JSONObject,
  McpServer,
  ServerContext,
  ToolCallback,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import {
  AgentAccessAuthorizationError,
  getAgentAccessConfig,
  requireAgentAuthContext,
  type AgentAccessScope,
} from "@/lib/agent-access/auth";
import {
  agentAddFromMaterialSchema,
  agentAddFromSpecsSchema,
  agentAddFromTextSchema,
  agentContinueOperationSchema,
  agentGetMaterialOutlineSchema,
  agentGetOperationSchema,
  agentListMaterialsSchema,
  agentPrepareFilesSchema,
  agentRetryOperationSchema,
  agentSearchMaterialExcerptsSchema,
  agentStartFilesSchema,
} from "@/lib/agent-access/contracts";
import {
  getAgentMaterialOutline,
  listAgentMaterials,
  searchAgentMaterialExcerpts,
} from "@/lib/agent-access/materials";
import {
  AgentOperationError,
  createAgentMaterialOperation,
  continueAgentOperation,
  prepareAgentFileOperation,
  retryFailedAgentOperationItems,
  startAgentFileOperation,
  createAgentSpecOperation,
  createAgentTextOperation,
  getAgentOperation,
} from "@/lib/agent-access/operations";
import { agentGetPracticeSettingsSchema, agentListPracticeTargetsSchema, agentUpdatePracticeSettingsSchema } from "./practice-contracts";
import { getAgentPracticeSettings, listAgentPracticeTargets, updateAgentPracticeSettings } from "./practice";

export function registerLearnRecurMcpTools(server: McpServer) {
  registerTool(server, {
    name: "practice.list_targets", title: "Find collections and skills for practice settings",
    description: "List owned collection or skill IDs and names, optionally filtered by name. Bounded to 50 per page; pass next_cursor as after_id for the next page. Does not expose source content or answers.",
    schema: agentListPracticeTargetsSchema, scopes: ["practice:read"], readOnly: true, handler: listAgentPracticeTargets,
  });
  registerTool(server, {
    name: "practice.get_settings", title: "Read practice settings",
    description: "Read account defaults or owned collection/skill overrides and effective inherited settings. Null overrides inherit skill → collection → user → Balanced; text defaults to Natural. invalid_fields identifies malformed stored policies needing repair. Mixed review is the account default; a browser session can override it temporarily.",
    schema: agentGetPracticeSettingsSchema, scopes: ["practice:read"], readOnly: true, handler: getAgentPracticeSettings,
  });
  registerTool(server, {
    name: "practice.update_settings", title: "Update practice settings",
    description: "Patch only supplied settings. User: practicePreference (BALANCED or RECALL_FIRST), mixedReview. Collection: nullable practicePreference and textPolicy. Skill: nullable practicePreference and textPolicy, alreadyStudied. Null restores inheritance. Text policies are version 2 Natural, Exact, or Custom case/whitespace rules; diacritics are always preserved. A policy change retires future text stock without regrading history or resetting schedules; up to 500 inheriting skills per collection edit. Preparation may be deferred until practice opens. Requires practice:write consent; creation permission alone is insufficient.",
    schema: agentUpdatePracticeSettingsSchema, scopes: ["practice:write"], readOnly: false, handler: updateAgentPracticeSettings,
  });
  registerTool(server, {
    name: "skills.add_from_specs",
    title: "Add skills from structured specifications",
    description: "Queue one to ten independent LearnRecur skills. LearnRecur verifies exercises and activates each skill asynchronously. Text candidates use policyVersion 2, preserve diacritics, and must match the skill or collection text profile. Skills may explicitly declare alreadyStudied and a nullable practicePreference override.",
    schema: agentAddFromSpecsSchema,
    scopes: ["skills:create"],
    readOnly: false,
    handler: createAgentSpecOperation,
  });
  registerTool(server, {
    name: "skills.add_from_text",
    title: "Add a skill from pasted text",
    description: "Queue one source-grounded skill from bounded pasted text and a learning intent. URLs are not accepted.",
    schema: agentAddFromTextSchema,
    scopes: ["skills:create"],
    readOnly: false,
    handler: createAgentTextOperation,
  });
  registerTool(server, {
    name: "skills.add_from_material",
    title: "Add skills from a saved material",
    description: "Queue up to ten skills from an owned, ready material revision. The expected revision prevents stale planning.",
    schema: agentAddFromMaterialSchema,
    scopes: ["skills:create", "materials:read"],
    readOnly: false,
    handler: createAgentMaterialOperation,
  });
  registerTool(server, {
    name: "skills.prepare_files",
    title: "Prepare private source file uploads",
    description: "Create one to five ten-minute private upload URLs for a combined-source skill.",
    schema: agentPrepareFilesSchema,
    scopes: ["skills:create", "sources:upload"],
    readOnly: false,
    handler: prepareAgentFileOperation,
  });
  registerTool(server, {
    name: "skills.start_files",
    title: "Start a prepared file operation",
    description: "Validate uploaded private files, generate one source-grounded skill, verify exercises, and activate asynchronously.",
    schema: agentStartFilesSchema,
    scopes: ["skills:create", "sources:upload"],
    readOnly: false,
    handler: startAgentFileOperation,
  });
  registerTool(server, {
    name: "materials.list",
    title: "List saved materials",
    description: "List sanitized metadata for owned materials whose active revision is ready.",
    schema: agentListMaterialsSchema,
    scopes: ["materials:read"],
    readOnly: true,
    handler: listAgentMaterials,
  });
  registerTool(server, {
    name: "materials.get_outline",
    title: "Get a material outline",
    description: "Return headings, hierarchy, and page ranges without storage keys or source URLs.",
    schema: agentGetMaterialOutlineSchema,
    scopes: ["materials:read"],
    readOnly: true,
    handler: getAgentMaterialOutline,
  });
  registerTool(server, {
    name: "materials.search_excerpts",
    title: "Search material excerpts",
    description: "Search existing indexed chunks and return at most five bounded, sanitized excerpts.",
    schema: agentSearchMaterialExcerptsSchema,
    scopes: ["materials:read"],
    readOnly: true,
    handler: searchAgentMaterialExcerpts,
  });
  registerTool(server, {
    name: "operations.get",
    title: "Get skill operation progress",
    description: "Return compact aggregate and per-item progress for an operation created by this connection.",
    schema: agentGetOperationSchema,
    scopes: ["skills:create"],
    readOnly: true,
    handler: (auth, input) => getAgentOperation(auth, input.operation_id),
  });
  registerTool(server, {
    name: "operations.continue",
    title: "Continue an operation with clarification",
    description: "Supply bounded clarification for a material operation that is waiting for input.",
    schema: agentContinueOperationSchema,
    scopes: ["skills:create"],
    readOnly: false,
    handler: continueAgentOperation,
  });
  registerTool(server, {
    name: "operations.retry_failed",
    title: "Retry failed operation items",
    description: "Retry up to ten failed items without changing successful siblings.",
    schema: agentRetryOperationSchema,
    scopes: ["skills:create"],
    readOnly: false,
    handler: retryFailedAgentOperationItems,
  });
}

export function validateMcpHttpRequest(request: Request): Response | null {
  const config = getAgentAccessConfig();
  if (!config.enabled) return new Response("Not found", { status: 404 });
  const requestUrl = new URL(request.url);
  if (requestUrl.protocol !== "https:") {
    return jsonError(400, "https_required", "The MCP resource requires HTTPS.");
  }
  const host = request.headers.get("host");
  if (!host || normalizedHost(host) !== new URL(config.resourceUrl).host) {
    return jsonError(421, "invalid_host", "The request host does not match the configured MCP resource.");
  }
  const origin = request.headers.get("origin");
  if (origin && !config.allowedOrigins.includes(origin)) {
    return jsonError(403, "invalid_origin", "The request origin is not allowed.");
  }
  return null;
}

export function mcpCorsOptionsResponse(request: Request): Response {
  const rejected = validateMcpHttpRequest(request);
  if (rejected) return rejected;
  const origin = request.headers.get("origin");
  const headers = new Headers({
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers":
      "Authorization, Content-Type, MCP-Protocol-Version, MCP-Method, MCP-Name",
    "access-control-max-age": "600",
    vary: "Origin",
  });
  if (origin) headers.set("access-control-allow-origin", origin);
  return new Response(null, { status: 204, headers });
}

type ToolDefinition<T extends z.ZodType> = {
  name: string;
  title: string;
  description: string;
  schema: T;
  scopes: AgentAccessScope[];
  readOnly: boolean;
  handler: (
    auth: ReturnType<typeof requireAgentAuthContext>,
    input: z.infer<T>,
  ) => Promise<Record<string, unknown>>;
};

function registerTool<T extends z.ZodType>(server: McpServer, definition: ToolDefinition<T>) {
  const callback = (async (
    input: z.infer<T>,
    context: ServerContext,
  ): Promise<CallToolResult> => {
    try {
      const auth = requireAgentAuthContext(
        context.http?.authInfo as AuthInfo | undefined,
        definition.scopes,
      );
      const output = await definition.handler(auth, input as z.infer<T>);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output as JSONObject,
      };
    } catch (error) {
      const publicError = toPublicError(error);
      return {
        isError: true,
        content: [{ type: "text" as const, text: JSON.stringify(publicError) }],
        structuredContent: publicError as JSONObject,
        _meta: publicError.code === "authentication_required"
          ? { "mcp/www_authenticate": authenticationChallenge() }
          : undefined,
      };
    }
  }) as unknown as ToolCallback<T>;
  server.registerTool(
    definition.name,
    {
      title: definition.title,
      description: definition.description,
      inputSchema: definition.schema,
      annotations: {
        readOnlyHint: definition.readOnly,
        destructiveHint: false,
        idempotentHint: definition.readOnly,
        openWorldHint: false,
      },
      _meta: {
        securitySchemes: [{ type: "oauth2", scopes: definition.scopes }],
      },
    },
    callback,
  );
}

export function toPublicError(error: unknown): { code: string; message: string; retryable: boolean } {
  if (error instanceof AgentAccessAuthorizationError) {
    return { code: error.code, message: error.message, retryable: false };
  }
  if (error instanceof AgentOperationError) {
    return { code: error.code, message: error.message, retryable: error.code === "rate_limited" };
  }
  if (error && typeof error === "object" && "code" in error && "message" in error) {
    const code = String(error.code);
    const allowed = new Set(["material_not_found", "stale_material_revision", "invalid_cursor"]);
    if (allowed.has(code)) return { code, message: String(error.message), retryable: false };
  }
  if (error instanceof z.ZodError) {
    return { code: "invalid_input", message: "The tool input did not satisfy the published contract.", retryable: false };
  }
  return { code: "internal_error", message: "LearnRecur could not complete the request.", retryable: true };
}

function authenticationChallenge() {
  const config = getAgentAccessConfig();
  if (!config.enabled) return "Bearer";
  return `Bearer resource_metadata="${config.resourceOrigin}/.well-known/oauth-protected-resource/mcp"`;
}

function normalizedHost(host: string) {
  try {
    return new URL(`https://${host}`).host;
  } catch {
    return "";
  }
}

function jsonError(status: number, code: string, message: string) {
  return Response.json({ error: code, error_description: message }, { status });
}
