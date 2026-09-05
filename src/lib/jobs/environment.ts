import "server-only";
import { paginateGetParametersByPath, SSMClient } from "@aws-sdk/client-ssm";
import type { JobsConfig } from "./config";

export const WORKER_ENV_KEYS = [
  "DATABASE_URL", "S3_BUCKET_NAME", "CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "NEXT_PUBLIC_APP_URL", "GEMINI_API_KEY", "GEMINI_ENTERPRISE_AGENT_KEY_PLATFORM_KEY",
  "GEMINI_MODEL", "GEMINI_FALLBACK_MODELS", "GEMINI_EMBEDDING_MODEL", "GEMINI_EMBEDDING_API_MODE",
  "META_API_KEY", "META_MUSE_MODEL", "META_MUSE_BASE_URL", "RESEND_API_KEY", "RESEND_FROM_EMAIL",
  "AGENT_SKILL_CREATION_ENABLED", "MCP_RESOURCE_URL", "MCP_ALLOWED_ORIGINS", "MCP_ALLOWED_CLIENT_IDS",
  "WORKOS_AUTHKIT_ISSUER", "WORKOS_API_KEY", "AGENT_OAUTH_COOKIE_SECRET", "MCP_ALLOW_VERIFIED_CIMD_CLIENTS",
  "AGENT_PERMISSION_VERSION",
] as const;

const required = ["DATABASE_URL", "S3_BUCKET_NAME", "CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "NEXT_PUBLIC_APP_URL", "RESEND_API_KEY", "RESEND_FROM_EMAIL"];

export function selectWorkerEnvironment(input: Record<string, string | undefined>): Record<string, string> {
  const values = Object.fromEntries(WORKER_ENV_KEYS.filter((key) => input[key]?.trim()).map((key) => [key, input[key]!]));
  if (Object.values(values).some((value) => value === "[SENSITIVE]") || required.some((key) => !values[key]) || !(values.GEMINI_API_KEY || values.GEMINI_ENTERPRISE_AGENT_KEY_PLATFORM_KEY)) {
    throw new Error("JOB_ENVIRONMENT_INCOMPLETE");
  }
  return values;
}

export async function loadWorkerEnvironment(config: JobsConfig): Promise<void> {
  const revision = process.env.JOBS_CONFIG_REVISION;
  if (revision && !/^[a-zA-Z0-9-]{1,80}$/.test(revision)) throw new Error("JOB_ENVIRONMENT_INVALID");
  const prefix = `/learnrecur/${config.environment}/jobs/${revision ? `${revision}/` : ""}`;
  const client = new SSMClient({ region: config.region, maxAttempts: 3 });
  const values: Record<string, string> = {};
  try {
    for await (const page of paginateGetParametersByPath({ client }, { Path: prefix, Recursive: false, WithDecryption: true })) {
      for (const parameter of page.Parameters ?? []) {
        const key = parameter.Name?.slice(prefix.length);
        if (!parameter.Name?.startsWith(prefix) || !WORKER_ENV_KEYS.includes(key as typeof WORKER_ENV_KEYS[number]) || parameter.Type !== "SecureString" || !parameter.Value?.trim()) {
          throw new Error("JOB_ENVIRONMENT_INVALID");
        }
        values[key!] = parameter.Value;
      }
    }
  } finally {
    client.destroy();
  }
  selectWorkerEnvironment(values);
  // Never inherit a removed parameter from an earlier initialization attempt.
  for (const key of WORKER_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}
