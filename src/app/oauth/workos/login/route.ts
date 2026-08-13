import { auth } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getAgentAccessConfig } from "@/lib/agent-access/auth";
import {
  createExternalAuthCookie,
  WORKOS_EXTERNAL_AUTH_COOKIE,
  WORKOS_EXTERNAL_AUTH_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/agent-access/oauth-login";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const config = getAgentAccessConfig();
  if (!config.enabled) return new Response("Not found", { status: 404 });
  const externalAuthId = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .safeParse(new URL(request.url).searchParams.get("external_auth_id"));
  if (!externalAuthId.success) {
    return NextResponse.redirect(new URL("/settings?agentConnection=invalid", request.url));
  }

  const { userId } = await auth();
  const destination = userId
    ? new URL("/oauth/workos/complete", request.url)
    : new URL("/sign-in?redirect_url=/oauth/workos/complete", request.url);
  const response = NextResponse.redirect(destination);
  response.cookies.set(
    WORKOS_EXTERNAL_AUTH_COOKIE,
    createExternalAuthCookie(
      externalAuthId.data,
      config.oauthCookieSecret,
    ),
    {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/oauth/workos",
      maxAge: WORKOS_EXTERNAL_AUTH_COOKIE_MAX_AGE_SECONDS,
    },
  );
  return response;
}
