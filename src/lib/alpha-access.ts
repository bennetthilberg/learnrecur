import "server-only";

import { clerkClient } from "@clerk/nextjs/server";
import { z } from "zod";

const emailSchema = z.string().email();

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

export function normalizeAlphaEmail(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.normalize("NFKC").trim().toLowerCase();

  return emailSchema.safeParse(normalized).success ? normalized : null;
}

export function getAlphaAccessPolicy(
  env: NodeJS.ProcessEnv = process.env,
): AlphaAccessPolicy {
  if (env.NODE_ENV !== "production") {
    return { mode: "open" };
  }

  const configuredEmails = (env.ALPHA_ALLOWED_EMAILS ?? "")
    .split(/[,\n]/u)
    .map((value) => value.trim())
    .filter(Boolean);

  if (configuredEmails.length === 0) {
    return { mode: "closed" };
  }

  const normalizedEmails = configuredEmails.map(normalizeAlphaEmail);

  if (normalizedEmails.some((email) => email === null)) {
    return { mode: "closed" };
  }

  return {
    mode: "allowlist",
    allowedEmails: [...new Set(normalizedEmails as string[])],
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

  return normalizedEmail !== null && policy.allowedEmails.includes(normalizedEmail);
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
  const client = await clerkClient();
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
