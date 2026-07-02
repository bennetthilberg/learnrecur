import "server-only";

import { formatEnvError, getOpenRouterEnv } from "@/lib/env";
import type { OpenRouterFallbackConfig } from "@/lib/openrouter";

export type OptionalOpenRouterFallbackResult =
  | {
      status: "ready";
      config: OpenRouterFallbackConfig | null;
    }
  | {
      status: "invalid";
      message: string;
    };

export function resolveOpenRouterFallbackConfig(): OpenRouterFallbackConfig | null {
  const env = getOpenRouterEnv();

  if (!env.OPENROUTER_API_KEY) {
    return null;
  }

  return {
    apiKey: env.OPENROUTER_API_KEY,
    baseUrl: env.OPENROUTER_BASE_URL,
    model: env.OPENROUTER_MODEL,
  };
}

export function resolveOptionalOpenRouterFallbackConfig(): OptionalOpenRouterFallbackResult {
  try {
    return {
      status: "ready",
      config: resolveOpenRouterFallbackConfig(),
    };
  } catch (error) {
    return {
      status: "invalid",
      message: formatEnvError(error),
    };
  }
}
