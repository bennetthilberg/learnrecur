import { shouldCheckProductionEnv } from "./env";

const splitList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

export type AlphaAccessConfig = {
  allowedEmails: string[];
  allowedDomains: string[];
};

export type AlphaAccessResult =
  | { allowed: true }
  | { allowed: false; reason: "missing-email" | "not-allowed" | "missing-allowlist" };

export function getAlphaAccessConfig(env: NodeJS.ProcessEnv = process.env): AlphaAccessConfig {
  return {
    allowedEmails: splitList(env.ALPHA_ALLOWED_EMAILS),
    allowedDomains: splitList(env.ALPHA_ALLOWED_DOMAINS).map((domain) => domain.replace(/^@/, "")),
  };
}

export function hasAlphaAccessAllowlist(env: NodeJS.ProcessEnv = process.env): boolean {
  const config = getAlphaAccessConfig(env);

  return config.allowedEmails.length > 0 || config.allowedDomains.length > 0;
}

export function checkAlphaAccessForEmail(
  email: string | null | undefined,
  config: AlphaAccessConfig = getAlphaAccessConfig(),
  env: NodeJS.ProcessEnv = process.env,
): AlphaAccessResult {
  const hasAllowlist = config.allowedEmails.length > 0 || config.allowedDomains.length > 0;

  if (!hasAllowlist) {
    return shouldCheckProductionEnv(env)
      ? { allowed: false, reason: "missing-allowlist" }
      : { allowed: true };
  }

  const normalizedEmail = email?.trim().toLowerCase();

  if (!normalizedEmail) {
    return { allowed: false, reason: "missing-email" };
  }

  if (config.allowedEmails.includes(normalizedEmail)) {
    return { allowed: true };
  }

  const domain = normalizedEmail.split("@").at(1);

  if (domain && config.allowedDomains.includes(domain)) {
    return { allowed: true };
  }

  return { allowed: false, reason: "not-allowed" };
}
