import "server-only";

import { formatEnvError, getMetaMuseEnv } from "@/lib/env";
import type { MetaMuseFallbackConfig } from "@/lib/meta-muse";

export type OptionalMetaMuseFallbackResult =
  | { status: "ready"; config: MetaMuseFallbackConfig | null }
  | { status: "invalid"; message: string };

export function resolveMetaMuseFallbackConfig(): MetaMuseFallbackConfig | null {
  const env = getMetaMuseEnv();
  if (!env.META_API_KEY) {
    return null;
  }
  return {
    apiKey: env.META_API_KEY,
    baseUrl: env.META_MUSE_BASE_URL,
    model: env.META_MUSE_MODEL,
  };
}

export function resolveOptionalMetaMuseFallbackConfig(): OptionalMetaMuseFallbackResult {
  try {
    return { status: "ready", config: resolveMetaMuseFallbackConfig() };
  } catch (error) {
    return { status: "invalid", message: formatEnvError(error) };
  }
}
