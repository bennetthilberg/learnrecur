import "server-only";

import { createClerkServiceClient } from "@/lib/clerk/backend";
import { normalizeAlphaEmail, parseAlphaAllowlist } from "@/lib/alpha-policy";
export { normalizeAlphaEmail } from "@/lib/alpha-policy";

export type AlphaAccessPolicy =
  | { mode: "open" }
  | { mode: "closed" }
  | { mode: "allowlist"; allowedEmails: readonly string[] };

export type AlphaUserSnapshot = {
  primaryEmailAddress?: {
    emailAddress?: string | null;
    verification?: { status?: string | null } | null;
  } | null;
};

export type AlphaUserLoader = (userId: string) => Promise<AlphaUserSnapshot>;

export function getAlphaAccessPolicy(
  env: NodeJS.ProcessEnv = process.env,
): AlphaAccessPolicy {
  if (env.NODE_ENV !== "production") {
    return { mode: "open" };
  }

  const normalizedEmails = parseAlphaAllowlist(env.ALPHA_ALLOWED_EMAILS);
  if (!normalizedEmails) {
    return { mode: "closed" };
  }

  return {
    mode: "allowlist",
    allowedEmails: normalizedEmails,
  };
}

export function isAlphaEmailAllowed(
  policy: AlphaAccessPolicy,
  email: unknown,
): boolean {
  if (policy.mode === "open") {
    return true;
  }

  if (policy.mode === "closed") {
    return false;
  }

  const normalizedEmail = normalizeAlphaEmail(email);

  if (!normalizedEmail) return false;
  const domainRule = `*@${normalizedEmail.slice(normalizedEmail.lastIndexOf("@") + 1)}`;
  return policy.allowedEmails.includes(normalizedEmail) || policy.allowedEmails.includes(domainRule);
}

export async function isAlphaUserAllowed(
  userId: string,
  policy: AlphaAccessPolicy = getAlphaAccessPolicy(),
  loadUser: AlphaUserLoader = loadClerkAlphaUser,
): Promise<boolean> {
  if (policy.mode === "open") {
    return true;
  }

  if (policy.mode === "closed") {
    return false;
  }

  try {
    const user = await loadUser(userId);
    const primaryEmail = user.primaryEmailAddress;

    return (
      primaryEmail?.verification?.status === "verified" &&
      isAlphaEmailAllowed(policy, primaryEmail.emailAddress)
    );
  } catch {
    console.error("[alpha-access] Clerk user lookup failed");
    return false;
  }
}

async function loadClerkAlphaUser(userId: string): Promise<AlphaUserSnapshot> {
  const client = await createClerkServiceClient();
  const user = await client.users.getUser(userId);
  const primaryEmail = user.primaryEmailAddress;

  return {
    primaryEmailAddress: primaryEmail
      ? {
          emailAddress: primaryEmail.emailAddress,
          verification: { status: primaryEmail.verification?.status ?? null },
        }
      : null,
  };
}
