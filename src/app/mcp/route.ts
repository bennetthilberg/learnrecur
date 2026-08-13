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
    serverInfo: { name: "learnrecur", version: "0.1.0-beta" },
    instructions: "Create and inspect private LearnRecur skill operations for the connected account. Never send user IDs, source URLs, storage keys, or verifier decisions.",
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
    resourceUrl: config.resourceUrl,
  })(request);
}

export { handle as GET, handle as POST };
export const OPTIONS = mcpCorsOptionsResponse;
