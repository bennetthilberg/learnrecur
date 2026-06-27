import "server-only";

import { formatEnvError, getQwenEnv } from "@/lib/env";
import type { QwenFallbackConfig } from "@/lib/qwen";

export type OptionalQwenFallbackResult =
  | {
      status: "ready";
      config: QwenFallbackConfig | null;
    }
  | {
      status: "invalid";
      message: string;
    };

export function resolveQwenFallbackConfig(): QwenFallbackConfig | null {
  const env = getQwenEnv();

  if (!env.QWEN_API_KEY) {
    return null;
  }

  return {
    apiKey: env.QWEN_API_KEY,
    baseUrl: env.QWEN_BASE_URL,
    model: env.QWEN_MODEL,
  };
}

export function resolveOptionalQwenFallbackConfig(): OptionalQwenFallbackResult {
  try {
    return {
      status: "ready",
      config: resolveQwenFallbackConfig(),
    };
  } catch (error) {
    return {
      status: "invalid",
      message: formatEnvError(error),
    };
  }
}
