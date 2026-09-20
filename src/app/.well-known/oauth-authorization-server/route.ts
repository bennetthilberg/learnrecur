import { metadataCorsOptionsRequestHandler } from "mcp-handler";

import { getAgentAccessConfig } from "@/lib/agent-access/auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const config = getAgentAccessConfig();
  if (!config.enabled) return new Response("Not found", { status: 404 });

  try {
    const response = await fetch(
      `${config.workosIssuer}/.well-known/oauth-authorization-server`,
      { cache: "no-store", redirect: "error" },
    );
    if (!response.ok) {
      return Response.json(
        { error: "authorization_server_unavailable" },
        { status: 502, headers: { "cache-control": "no-store" } },
      );
    }
    const metadata = await response.json() as Record<string, unknown>;
    return Response.json(metadata, {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "public, max-age=300",
      },
    });
  } catch {
    return Response.json(
      { error: "authorization_server_unavailable" },
      { status: 502, headers: { "cache-control": "no-store" } },
    );
  }
}

export const OPTIONS = metadataCorsOptionsRequestHandler();
