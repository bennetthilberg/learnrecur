import { createMcpHandler, withMcpAuth } from "mcp-handler";

import { getAgentAccessConfig, verifyAgentBearerToken } from "@/lib/agent-access/auth";
import {
  mcpCorsOptionsResponse,
  registerLearnRecurMcpTools,
  validateMcpHttpRequest,
} from "@/lib/agent-access/mcp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const mcpHandler = createMcpHandler(
  (server) => registerLearnRecurMcpTools(server),
  {
    serverInfo: { name: "learnrecur", version: "0.3.0-beta" },
    instructions: "Create and inspect private LearnRecur skill operations, read revision-bound material content, audit full exercise contracts, inspect completed practice history, and manage practice settings for the connected account with the required permissions. Use materials.get_outline followed by materials.read_content for ordered source traversal. Use exercises.list_for_audit or exercises.get_for_audit only with explicit audit consent; ordinary skills.search and skills.get previews remain answer-key-free. Use practice.history for private submitted answers and historical grading evidence. Never send user IDs, source URLs, storage keys, or verifier decisions.",
  },
);

async function handle(request: Request) {
  const rejected = validateMcpHttpRequest(request);
  if (rejected) return rejected;
  const config = getAgentAccessConfig();
  if (!config.enabled) return new Response("Not found", { status: 404 });
  return withMcpAuth(mcpHandler, verifyAgentBearerToken, {
    required: true,
    resourceMetadataPath: "/.well-known/oauth-protected-resource/mcp",
    // mcp-handler appends resourceMetadataPath to this value. Supplying the
    // full protected resource would incorrectly advertise
    // /mcp/.well-known/oauth-protected-resource/mcp in the challenge.
    resourceUrl: config.resourceOrigin,
  })(request);
}

export { handle as GET, handle as POST };
export const OPTIONS = mcpCorsOptionsResponse;
