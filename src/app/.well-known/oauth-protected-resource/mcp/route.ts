import { metadataCorsOptionsRequestHandler } from "mcp-handler";

import { AGENT_ACCESS_SCOPES, getAgentAccessConfig } from "@/lib/agent-access/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET() {
  const config = getAgentAccessConfig();
  if (!config.enabled) return new Response("Not found", { status: 404 });
  return Response.json(
    {
      resource: config.resourceUrl,
      authorization_servers: [config.workosIssuer],
      scopes_supported: AGENT_ACCESS_SCOPES,
      bearer_methods_supported: ["header"],
    },
    {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=300",
      },
    },
  );
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
