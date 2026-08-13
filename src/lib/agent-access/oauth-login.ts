import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { EnabledAgentAccessConfig } from "@/lib/agent-access/auth";
import { getPrisma } from "@/lib/prisma";

export const WORKOS_EXTERNAL_AUTH_COOKIE = "lr_workos_external_auth";
export const WORKOS_EXTERNAL_AUTH_COOKIE_MAX_AGE_SECONDS = 300;

type StandaloneClerkUser = {
  id: string;
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
};

export function createExternalAuthCookie(
  externalAuthId: string,
  secret: string,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
): string {
  const id = z.string().trim().min(1).max(200).parse(externalAuthId);
  z.string().min(32).parse(secret);
  const encoded = Buffer.from(
    JSON.stringify({ id, exp: nowEpochSeconds + WORKOS_EXTERNAL_AUTH_COOKIE_MAX_AGE_SECONDS }),
  ).toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

export function parseExternalAuthCookie(
  cookie: string | undefined,
  secret: string,
  nowEpochSeconds = Math.floor(Date.now() / 1_000),
): string | null {
  if (!cookie) return null;
  const [encoded, signature, extra] = cookie.split(".");
  if (!encoded || !signature || extra) return null;
  const expected = sign(encoded, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }
  try {
    const payload = z
      .object({ id: z.string().trim().min(1).max(200), exp: z.number().int() })
      .strict()
      .parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
    return payload.exp >= nowEpochSeconds ? payload.id : null;
  } catch {
    return null;
  }
}

export function requireWorkosCompletionRedirect(value: string, issuer: string): URL {
  const redirect = new URL(value);
  const expectedIssuer = new URL(issuer);
  if (
    redirect.origin !== expectedIssuer.origin ||
    redirect.pathname !== "/oauth/authorize/complete" ||
    redirect.username ||
    redirect.password ||
    redirect.hash
  ) {
    throw new Error("WorkOS returned an unexpected completion redirect.");
  }
  return redirect;
}

export async function completeWorkosStandaloneAuth(input: {
  externalAuthId: string;
  clerkUser: StandaloneClerkUser;
  config: EnabledAgentAccessConfig;
  fetchImpl?: typeof fetch;
}) {
  const fetchImpl = input.fetchImpl ?? fetch;
  if (input.clerkUser.id.length > 64) {
    throw new Error("The Clerk user ID is too long for the WorkOS external identity field.");
  }
  const completionResponse = await fetchImpl(
    "https://api.workos.com/authkit/oauth2/complete",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.config.workosApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        external_auth_id: z.string().trim().min(1).max(200).parse(input.externalAuthId),
        user: {
          id: input.clerkUser.id,
          email: input.clerkUser.email,
          first_name: input.clerkUser.firstName ?? undefined,
          last_name: input.clerkUser.lastName ?? undefined,
          name: input.clerkUser.name ?? undefined,
        },
      }),
      redirect: "error",
    },
  );
  if (!completionResponse.ok) {
    throw new Error(`WorkOS standalone authentication failed with HTTP ${completionResponse.status}.`);
  }
  const completion = z
    .object({ redirect_uri: z.string().url() })
    .parse(await completionResponse.json());
  const redirect = requireWorkosCompletionRedirect(
    completion.redirect_uri,
    input.config.workosIssuer,
  );

  const userResponse = await fetchImpl(
    `https://api.workos.com/user_management/users/external_id/${encodeURIComponent(input.clerkUser.id)}`,
    {
      headers: { authorization: `Bearer ${input.config.workosApiKey}` },
      redirect: "error",
    },
  );
  if (!userResponse.ok) {
    throw new Error(`WorkOS identity lookup failed with HTTP ${userResponse.status}.`);
  }
  const workosUser = z
    .object({ id: z.string().min(1), external_id: z.string().min(1) })
    .passthrough()
    .parse(await userResponse.json());
  if (workosUser.external_id !== input.clerkUser.id) {
    throw new Error("WorkOS returned an identity with a mismatched external ID.");
  }

  const prisma = getPrisma();
  await prisma.$transaction(async (transaction) => {
    const conflicting = await transaction.workosIdentity.findFirst({
      where: {
        OR: [
          { workosUserId: workosUser.id, userId: { not: input.clerkUser.id } },
          { externalId: input.clerkUser.id, workosUserId: { not: workosUser.id } },
        ],
      },
      select: { id: true },
    });
    if (conflicting) throw new Error("WorkOS identity mapping conflicts with another account.");
    await transaction.workosIdentity.upsert({
      where: { userId: input.clerkUser.id },
      update: { workosUserId: workosUser.id, externalId: input.clerkUser.id },
      create: {
        userId: input.clerkUser.id,
        workosUserId: workosUser.id,
        externalId: input.clerkUser.id,
      },
    });
    await transaction.user.update({
      where: { id: input.clerkUser.id },
      data: { agentAccessDisabledAt: null },
    });
  });

  return redirect;
}

function sign(value: string, secret: string) {
  return createHmac("sha256", secret).update(value).digest("base64url");
}
