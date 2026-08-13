import { currentUser } from "@clerk/nextjs/server";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";

import { getAgentAccessConfig } from "@/lib/agent-access/auth";
import {
  completeWorkosStandaloneAuth,
  parseExternalAuthCookie,
  WORKOS_EXTERNAL_AUTH_COOKIE,
} from "@/lib/agent-access/oauth-login";
import { ensureDatabaseUser } from "@/lib/users";

export const runtime = "nodejs";

export async function GET() {
  const config = getAgentAccessConfig();
  if (!config.enabled) return new Response("Not found", { status: 404 });
  const cookieStore = await cookies();
  const externalAuthId = parseExternalAuthCookie(
    cookieStore.get(WORKOS_EXTERNAL_AUTH_COOKIE)?.value,
    config.oauthCookieSecret,
  );
  cookieStore.delete(WORKOS_EXTERNAL_AUTH_COOKIE);
  if (!externalAuthId) {
    return NextResponse.redirect(
      new URL("/settings?agentConnection=expired", config.resourceOrigin),
    );
  }

  const clerkUser = await currentUser();
  if (!clerkUser) {
    return NextResponse.redirect(
      new URL("/sign-in?redirect_url=/oauth/workos/complete", config.resourceOrigin),
    );
  }
  const emailAddress = clerkUser.primaryEmailAddress;
  if (!emailAddress?.emailAddress || emailAddress.verification?.status !== "verified") {
    return NextResponse.redirect(
      new URL("/settings?agentConnection=email", config.resourceOrigin),
    );
  }
  const databaseUser = await ensureDatabaseUser(clerkUser);
  if (databaseUser.status !== "ready") {
    return NextResponse.redirect(
      new URL("/settings?agentConnection=failed", config.resourceOrigin),
    );
  }

  try {
    const redirect = await completeWorkosStandaloneAuth({
      externalAuthId,
      clerkUser: {
        id: clerkUser.id,
        email: emailAddress.emailAddress,
        firstName: clerkUser.firstName,
        lastName: clerkUser.lastName,
        name: clerkUser.fullName,
      },
      config,
    });
    return NextResponse.redirect(redirect);
  } catch (error) {
    console.error("[agent-access] WorkOS standalone completion failed", {
      userId: clerkUser.id,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.redirect(
      new URL("/settings?agentConnection=failed", config.resourceOrigin),
    );
  }
}
