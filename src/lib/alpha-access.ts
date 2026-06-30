const splitList = (value: string | undefined): string[] =>
  (value ?? "")
    .split(/[,\s]+/)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

type AlphaAccessEnv = {
  ALPHA_ALLOWED_DOMAINS?: string;
  ALPHA_ALLOWED_EMAILS?: string;
  LEARNRECUR_STRICT_ENV?: string;
  NODE_ENV?: string;
  VERCEL_ENV?: string;
};

export type AlphaAccessConfig = {
  allowedEmails: string[];
  allowedDomains: string[];
};

export type AlphaAccessResult =
  | { allowed: true }
  | { allowed: false; reason: "missing-email" | "not-allowed" | "missing-allowlist" };

export function getAlphaAccessConfig(env: AlphaAccessEnv = process.env): AlphaAccessConfig {
  return {
    allowedEmails: splitList(env.ALPHA_ALLOWED_EMAILS),
    allowedDomains: splitList(env.ALPHA_ALLOWED_DOMAINS)
      .map((domain) => domain.replace(/^@/, ""))
      .filter(Boolean),
  };
}

export function hasAlphaAccessAllowlist(env: AlphaAccessEnv = process.env): boolean {
  const config = getAlphaAccessConfig(env);

  return config.allowedEmails.length > 0 || config.allowedDomains.length > 0;
}

export function checkAlphaAccessForEmail(
  email: string | null | undefined,
  config: AlphaAccessConfig = getAlphaAccessConfig(),
  env: AlphaAccessEnv = process.env,
): AlphaAccessResult {
  const hasAllowlist = config.allowedEmails.length > 0 || config.allowedDomains.length > 0;

  if (!hasAllowlist) {
    return shouldRequireAlphaAccessAllowlist(env)
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

function shouldRequireAlphaAccessAllowlist(env: AlphaAccessEnv): boolean {
  if (env.LEARNRECUR_STRICT_ENV === "1") {
    return true;
  }

  if (env.VERCEL_ENV && env.VERCEL_ENV !== "production") {
    return false;
  }

  return env.NODE_ENV === "production" || env.VERCEL_ENV === "production";
}
