import { parseEnvList } from "./env";

export type AlphaAccessDecision =
  | {
      allowed: true;
      reason: "open" | "email" | "domain";
    }
  | {
      allowed: false;
      reason: "missing-email" | "not-allowed";
      message: string;
    };

type AlphaAccessEnvLike = Record<string, string | undefined>;

export function checkAlphaAccessForEmail(
  email: string | null | undefined,
  env: AlphaAccessEnvLike = process.env,
): AlphaAccessDecision {
  const allowedEmails = normalizeEmailList(parseEnvList(env.ALPHA_ALLOWED_EMAILS));
  const allowedDomains = normalizeDomainList(parseEnvList(env.ALPHA_ALLOWED_DOMAINS));

  if (allowedEmails.size === 0 && allowedDomains.size === 0) {
    return {
      allowed: true,
      reason: "open",
    };
  }

  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return {
      allowed: false,
      reason: "missing-email",
      message: "This alpha is invite-only. Sign in with the email address that was invited.",
    };
  }

  if (allowedEmails.has(normalizedEmail)) {
    return {
      allowed: true,
      reason: "email",
    };
  }

  const domain = normalizedEmail.split("@")[1];

  if (domain && allowedDomains.has(domain)) {
    return {
      allowed: true,
      reason: "domain",
    };
  }

  return {
    allowed: false,
    reason: "not-allowed",
    message: "This alpha is invite-only. Ask the founder to add this email before continuing.",
  };
}

function normalizeEmailList(values: string[]): Set<string> {
  return new Set(values.map(normalizeEmail).filter(Boolean));
}

function normalizeDomainList(values: string[]): Set<string> {
  return new Set(
    values
      .map((value) => value.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
  );
}

function normalizeEmail(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}
