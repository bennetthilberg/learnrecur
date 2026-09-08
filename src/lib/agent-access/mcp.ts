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
  agentCollectionCreateSchema,
  agentCollectionLifecycleSchema,
  agentCollectionUpdateSchema,
  agentCustomSessionCreateSchema,
  agentCustomSessionGetSchema,
  agentCustomSessionMutationSchema,
  agentNeedsAttentionSchema,
  agentProgressSummarySchema,
  agentReadinessGetSchema,
  agentReadinessRepairSchema,
  agentReminderGetSchema,
  agentReminderUpdateSchema,
  agentSetupApplySchema,
  agentSetupGetSchema,
  agentSetupPreviewSchema,
  agentSkillBatchUpdateSchema,
  agentSkillGetSchema,
  agentSkillLifecycleSchema,
  agentSkillSearchSchema,
  agentSkillUpdateSchema,
} from "@/lib/agent-access/contracts";
import {
  agentCompleteMaterialUploadSchema,
  agentGetMaterialStatusSchema,
  agentImportMaterialUrlSchema,
  agentPrepareMaterialUploadSchema,
  agentRetryMaterialIngestionSchema,
} from "@/lib/agent-access/material-ingestion-contracts";
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
import {
  getAgentSkill,
  searchAgentSkills,
  updateAgentSkill,
  lifecycleAgentSkill,
  batchUpdateAgentSkills,
  createAgentCollection,
  updateAgentCollection,
  lifecycleAgentCollection,
} from "@/lib/agent-access/library";
import { getAgentReminders, updateAgentReminders } from "@/lib/agent-access/reminders";
import { getAgentNeedsAttention, getAgentProgressSummary, getAgentReadiness, repairAgentReadiness } from "@/lib/agent-access/progress";
import { applyAgentSetup, getAgentSetupPlan, previewAgentSetup } from "@/lib/agent-access/setup";
import { createAgentCustomSession, getAgentCustomSession, resumeAgentCustomSession, stopAgentCustomSession } from "@/lib/agent-access/custom-sessions";
import {
  completeAgentMaterialUpload,
  getAgentMaterialStatus,
  getAgentMaterialOperationStatus,
  importAgentMaterialUrl,
  prepareAgentMaterialUpload,
  retryAgentMaterialIngestion,
} from "@/lib/agent-access/material-ingestion";
import { AgentMaterialIngestionError } from "@/lib/agent-access/material-ingestion";
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
    description: "Read account settings plus owned collection/skill practice and text overrides with effective inherited values. Practice preference inheritance resolves skill → collection → user → Balanced; text defaults to Natural. User desiredRetention is an account-only nullable setting; null resolves to the 0.90 product default. invalid_fields identifies malformed stored policies needing repair. Mixed review is the account default; custom-session setup can select a per-session value.",
    schema: agentGetPracticeSettingsSchema, scopes: ["practice:read"], readOnly: true, handler: getAgentPracticeSettings,
  });
  registerTool(server, {
    name: "practice.update_settings", title: "Update practice settings",
    description: "Patch only supplied settings. User: practicePreference, mixedReview, dailyNewSkillLimit, practiceTimezone, desiredRetention (0.70-0.99 or null for the ts-fsrs default), and practiceDayStartMinutes (0-1439). Collection: nullable practicePreference and textPolicy. Skill: nullable practicePreference and textPolicy, alreadyStudied. Null restores inheritance. A policy change retires future text stock without regrading history or resetting schedules. Requires practice:write consent; creation permission alone is insufficient.",
    schema: agentUpdatePracticeSettingsSchema, scopes: ["practice:write"], readOnly: false, handler: updateAgentPracticeSettings,
  });
  registerTool(server, {
    name: "practice.sessions.create",
    title: "Create a bounded practice session",
    description: "Create a persisted practice-only or scheduled session from owned skills, collections, tags, or recent misses. Creation does not submit answers or fabricate review history.",
    schema: agentCustomSessionCreateSchema,
    scopes: ["practice:write"],
    readOnly: false,
    handler: createAgentCustomSession,
  });
  registerTool(server, {
    name: "practice.sessions.get",
    title: "Read a practice session",
    description: "Read the persisted scope and bounded item status for one owned custom practice session without exposing answer keys.",
    schema: agentCustomSessionGetSchema,
    scopes: ["practice:read"],
    readOnly: true,
    handler: getAgentCustomSession,
  });
  registerTool(server, {
    name: "practice.sessions.stop",
    title: "Stop a practice session",
    description: "Stop one owned custom practice session so it can be resumed later.",
    schema: agentCustomSessionMutationSchema,
    scopes: ["practice:write"],
    readOnly: false,
    handler: stopAgentCustomSession,
  });
  registerTool(server, {
    name: "practice.sessions.resume",
    title: "Resume a practice session",
    description: "Resume one owned custom practice session without submitting a review answer.",
    schema: agentCustomSessionMutationSchema,
    scopes: ["practice:write"],
    readOnly: false,
    handler: resumeAgentCustomSession,
  });
  registerTool(server, {
    name: "skills.search",
    title: "Search the skill library",
    description: "Search owned skills with objective, guidance, tags, source links, schedule readiness, and optional safe exercise previews. Reads do not reserve new-skill allowance or create review attempts.",
    schema: agentSkillSearchSchema,
    scopes: ["skills:read"],
    readOnly: true,
    handler: searchAgentSkills,
  });
  registerTool(server, {
    name: "skills.get",
    title: "Read a skill",
    description: "Read one owned skill with objective, guidance, provenance links, schedule state, readiness, generation status, and safe previews that omit answer keys.",
    schema: agentSkillGetSchema,
    scopes: ["skills:read"],
    readOnly: true,
    handler: getAgentSkill,
  });
  registerTool(server, {
    name: "skills.update",
    title: "Update a skill",
    description: "Update draft skill content or safe active metadata and guidance. Active objective meaning cannot be changed through this tool; create a new skill to preserve the original review history.",
    schema: agentSkillUpdateSchema,
    scopes: ["skills:write"],
    readOnly: false,
    handler: updateAgentSkill,
  });
  registerTool(server, {
    name: "skills.lifecycle",
    title: "Change skill lifecycle state",
    description: "Pause, resume, archive, or restore one owned skill while preserving its review history.",
    schema: agentSkillLifecycleSchema,
    scopes: ["skills:write"],
    readOnly: false,
    destructiveHint: true,
    handler: lifecycleAgentSkill,
  });
  for (const action of ["pause", "resume", "archive", "restore"] as const) {
    registerTool(server, {
      name: `skills.${action}`,
      title: `${action[0].toUpperCase()}${action.slice(1)} a skill`,
      description: `Safely ${action} one owned skill while preserving its review history.`,
      schema: z.strictObject({ skill_id: z.string().trim().min(1).max(200) }),
      scopes: ["skills:write"],
      readOnly: false,
      destructiveHint: true,
      handler: (auth, input) => lifecycleAgentSkill(auth, { ...input, action }),
    });
  }
  registerTool(server, {
    name: "skills.batch_update",
    title: "Move or tag skills in bulk",
    description: "Move or tag up to 50 owned skills. Collection moves use the native policy invalidation path; stale siblings are reported individually without claiming success.",
    schema: agentSkillBatchUpdateSchema,
    scopes: ["skills:write"],
    readOnly: false,
    handler: batchUpdateAgentSkills,
  });
  registerTool(server, {
    name: "collections.create",
    title: "Create a collection",
    description: "Create one owned active collection with a bounded name and description.",
    schema: agentCollectionCreateSchema,
    scopes: ["collections:write"],
    readOnly: false,
    handler: createAgentCollection,
  });
  registerTool(server, {
    name: "collections.update",
    title: "Update a collection",
    description: "Update an owned collection with an optional updated_at concurrency check.",
    schema: agentCollectionUpdateSchema,
    scopes: ["collections:write"],
    readOnly: false,
    handler: updateAgentCollection,
  });
  registerTool(server, {
    name: "collections.lifecycle",
    title: "Archive or restore a collection",
    description: "Archive or restore an owned collection while retaining its skills and source links.",
    schema: agentCollectionLifecycleSchema,
    scopes: ["collections:write"],
    readOnly: false,
    destructiveHint: true,
    handler: lifecycleAgentCollection,
  });
  for (const action of ["archive", "restore"] as const) {
    registerTool(server, {
      name: `collections.${action}`,
      title: `${action[0].toUpperCase()}${action.slice(1)} a collection`,
      description: `${action[0].toUpperCase()}${action.slice(1)} one owned collection while retaining its skills and source links.`,
      schema: z.strictObject({ collection_id: z.string().trim().min(1).max(200) }),
      scopes: ["collections:write"],
      readOnly: false,
      destructiveHint: true,
      handler: (auth, input) => lifecycleAgentCollection(auth, { ...input, action }),
    });
  }
  registerTool(server, {
    name: "reminders.get",
    title: "Read reminder settings",
    description: "Read the account reminder preference and current due-skill count without changing practice state.",
    schema: agentReminderGetSchema,
    scopes: ["reminders:read"],
    readOnly: true,
    handler: getAgentReminders,
  });
  registerTool(server, {
    name: "reminders.update",
    title: "Update reminder settings",
    description: "Patch the account reminder preference with a verified account email and valid local timezone.",
    schema: agentReminderUpdateSchema,
    scopes: ["reminders:write"],
    readOnly: false,
    handler: updateAgentReminders,
  });
  registerTool(server, {
    name: "progress.summary",
    title: "Read progress summary",
    description: "Read due work, readiness, allowance remaining and local reset time, recent trouble spots, flags, and preparation counts. It does not reserve allowance or write review attempts.",
    schema: agentProgressSummarySchema,
    scopes: ["progress:read"],
    readOnly: true,
    handler: getAgentProgressSummary,
  });
  registerTool(server, {
    name: "progress.needs_attention",
    title: "Read needs-attention findings",
    description: "Read bounded repeated-miss and preparation findings derived from valid scheduled review evidence. It does not treat practice-only previews as review history.",
    schema: agentNeedsAttentionSchema,
    scopes: ["progress:read"],
    readOnly: true,
    handler: getAgentNeedsAttention,
  });
  registerTool(server, {
    name: "readiness.get",
    title: "Read skill readiness",
    description: "Read bounded exercise readiness and the latest preparation job for owned skills.",
    schema: agentReadinessGetSchema,
    scopes: ["progress:read"],
    readOnly: true,
    handler: getAgentReadiness,
  });
  registerTool(server, {
    name: "readiness.repair",
    title: "Repair skill readiness",
    description: "Queue preparation, retry preparation, update active practice guidance, or flag one exercise using the existing bounded repair paths.",
    schema: agentReadinessRepairSchema,
    scopes: ["skills:write"],
    readOnly: false,
    handler: repairAgentReadiness,
  });
  registerTool(server, {
    name: "setup.preview",
    title: "Preview a durable setup plan",
    description: "Validate a bounded plan for selected skills, collections, practice settings, and reminders. The preview stores a connection-bound plan but makes no learner configuration changes and does no surprise AI work.",
    schema: agentSetupPreviewSchema,
    scopes: ["setup:write"],
    readOnly: false,
    handler: previewAgentSetup,
  });
  registerTool(server, {
    name: "setup.apply",
    title: "Apply a setup plan",
    description: "Apply one previously previewed, connection-bound setup plan with stale-state checks, durable partial results, safe child-operation idempotency, and retryable asynchronous creation status.",
    schema: agentSetupApplySchema,
    scopes: ["setup:write"],
    readOnly: false,
    handler: applyAgentSetup,
  });
  registerTool(server, {
    name: "setup.get",
    title: "Read setup plan status",
    description: "Read the exact durable status and per-action result of a setup plan owned by this connection.",
    schema: agentSetupGetSchema,
    scopes: ["setup:read"],
    readOnly: true,
    handler: getAgentSetupPlan,
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
    name: "materials.prepare_upload",
    title: "Prepare a reusable material upload",
    description: "Create one private PDF material upload lease. The operation is idempotent and never accepts a caller-supplied storage key.",
    schema: agentPrepareMaterialUploadSchema,
    scopes: ["sources:upload"],
    readOnly: false,
    handler: prepareAgentMaterialUpload,
  });
  registerTool(server, {
    name: "materials.complete_upload",
    title: "Complete a reusable material upload",
    description: "Finalize one private uploaded PDF and queue bounded extraction. It returns the durable operation status and does not claim readiness while processing is pending.",
    schema: agentCompleteMaterialUploadSchema,
    scopes: ["sources:upload"],
    readOnly: false,
    handler: completeAgentMaterialUpload,
  });
  registerTool(server, {
    name: "materials.import_url",
    title: "Import a reusable web material",
    description: "Import a bounded same-origin public HTTPS page selection into the private material library with SSRF-safe validation and durable processing status.",
    schema: agentImportMaterialUrlSchema,
    scopes: ["sources:upload"],
    readOnly: false,
    handler: importAgentMaterialUrl,
  });
  registerTool(server, {
    name: "materials.get_status",
    title: "Read material ingestion status",
    description: "Read the owned material revision processing state and readiness without exposing storage keys.",
    schema: agentGetMaterialStatusSchema,
    scopes: ["materials:read"],
    readOnly: true,
    handler: getAgentMaterialStatus,
  });
  registerTool(server, {
    name: "materials.retry_ingestion",
    title: "Retry material ingestion",
    description: "Retry one owned failed or stalled material revision with durable idempotency and exact status reporting.",
    schema: agentRetryMaterialIngestionSchema,
    scopes: ["sources:upload"],
    readOnly: false,
    handler: retryAgentMaterialIngestion,
  });
  registerTool(server, {
    name: "operations.get",
    title: "Get skill operation progress",
    description: "Return compact aggregate and per-item progress for an operation created by this connection.",
    schema: agentGetOperationSchema,
    scopes: ["skills:create", "materials:read", "sources:upload"],
    alternativeScopes: [["skills:create"], ["materials:read"], ["sources:upload"]],
    readOnly: true,
    handler: async (auth, input) =>
      (await getAgentMaterialOperationStatus(auth, input.operation_id)) ??
      getAgentOperation(auth, input.operation_id),
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
  alternativeScopes?: readonly (readonly AgentAccessScope[])[];
  readOnly: boolean;
  destructiveHint?: boolean;
  handler: (
    auth: ReturnType<typeof requireAgentAuthContext>,
    input: z.infer<T>,
  ) => Promise<Record<string, unknown>>;
};

function registerTool<T extends z.ZodType>(server: McpServer, definition: ToolDefinition<T>) {
  const securitySchemes = definition.alternativeScopes?.length
    ? definition.alternativeScopes.map((scopes) => ({
        type: "oauth2" as const,
        scopes: [...scopes],
      }))
    : [{ type: "oauth2" as const, scopes: definition.scopes }];
  const callback = (async (
    input: z.infer<T>,
    context: ServerContext,
  ): Promise<CallToolResult> => {
    try {
      const auth = requireAgentAuthContext(
        context.http?.authInfo as AuthInfo | undefined,
        definition.scopes,
        definition.alternativeScopes,
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
        destructiveHint: definition.destructiveHint ?? false,
        idempotentHint: definition.readOnly,
        openWorldHint: false,
      },
      _meta: {
        securitySchemes,
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
    return {
      code: error.code,
      message: error.message,
      retryable: error.code === "rate_limited" || error.code === "setup_in_progress",
    };
  }
  if (error instanceof AgentMaterialIngestionError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
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
