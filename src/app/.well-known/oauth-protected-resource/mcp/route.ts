import { metadataCorsOptionsRequestHandler, protectedResourceHandler } from "mcp-handler";

import { getAgentAccessConfig } from "@/lib/agent-access/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(request: Request) {
  const config = getAgentAccessConfig();
  if (!config.enabled) return new Response("Not found", { status: 404 });
  return protectedResourceHandler({
    authServerUrls: [config.workosIssuer],
    resourceUrl: config.resourceUrl,
  })(request);
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
