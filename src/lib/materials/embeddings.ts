import "server-only";

import { GoogleGenAI } from "@google/genai";

import { getGeminiEnv, type GeminiEnv } from "@/lib/env";
import {
  getGeminiErrorLogDetails,
  resolveGeminiRuntimeConfig,
  type GeminiApiMode,
} from "@/lib/gemini";
import { MATERIAL_EMBEDDING_DIMENSIONS } from "@/lib/materials/retrieval";

export type MaterialEmbeddingGenerator = (input: {
  texts: string[];
  titles?: Array<string | null>;
}) => Promise<number[][]>;

export function createGeminiMaterialEmbeddingGenerator(): MaterialEmbeddingGenerator {
  const env = getGeminiEnv();
  const runtimeConfigs = resolveMaterialEmbeddingRuntimeConfigs(env);

  return async ({ texts, titles = [] }) => {
    if (texts.length === 0) {
      return [];
    }

    for (const [index, config] of runtimeConfigs.entries()) {
      const startedAt = Date.now();
      const ai = new GoogleGenAI(config.clientOptions);
      console.info("[ai] material embedding request started", {
        provider: "google",
        apiMode: config.apiMode,
        endpoint: config.endpoint,
        model: config.model,
        count: texts.length,
        inputCharacters: texts.reduce((total, text) => total + text.length, 0),
      });

      try {
        const response = await ai.models.embedContent({
          model: config.model,
          contents: texts.map((text, textIndex) => ({
            role: "user",
            parts: [
              {
                text: titles[textIndex]
                  ? `${titles[textIndex]}\n\n${text}`
                  : text,
              },
            ],
          })),
          config: buildMaterialEmbeddingConfig(config.model, config.apiMode),
        });
        const embeddings = response.embeddings ?? [];
        if (embeddings.length !== texts.length) {
          throw new Error("Gemini returned the wrong number of material embeddings.");
        }

        const values = embeddings.map((embedding) =>
          normalizeEmbedding(embedding.values ?? []),
        );
        console.info("[ai] material embedding request succeeded", {
          provider: "google",
          apiMode: config.apiMode,
          endpoint: config.endpoint,
          model: config.model,
          count: values.length,
          elapsedMs: Date.now() - startedAt,
        });
        return values;
      } catch (error) {
        const willFallback =
          index < runtimeConfigs.length - 1 && isUnavailableEmbeddingModel(error);
        const log = willFallback ? console.warn : console.error;
        log("[ai] material embedding request failed", {
          provider: "google",
          apiMode: config.apiMode,
          endpoint: config.endpoint,
          model: config.model,
          count: texts.length,
          elapsedMs: Date.now() - startedAt,
          fallbackApiMode: willFallback ? runtimeConfigs[index + 1]?.apiMode : undefined,
          error: error instanceof Error ? error.message : "Unknown embedding error",
        });
        if (!willFallback) {
          throw error;
        }
      }
    }

    throw new Error("No Gemini embedding runtime is available.");
  };
}

export function resolveMaterialEmbeddingRuntimeConfigs(env: GeminiEnv) {
  const developerConfig = () =>
    resolveGeminiRuntimeConfig({
      GEMINI_API_KEY: env.GEMINI_API_KEY,
      GEMINI_ENTERPRISE_AGENT_KEY_PLATFORM_KEY: undefined,
      GEMINI_MODEL: env.GEMINI_EMBEDDING_MODEL,
    });
  const enterpriseConfig = () =>
    resolveGeminiRuntimeConfig({
      GEMINI_API_KEY: undefined,
      GEMINI_ENTERPRISE_AGENT_KEY_PLATFORM_KEY:
        env.GEMINI_ENTERPRISE_AGENT_KEY_PLATFORM_KEY,
      GEMINI_MODEL: env.GEMINI_EMBEDDING_MODEL,
    });

  if (env.GEMINI_EMBEDDING_API_MODE === "developer-api") {
    return [developerConfig()];
  }
  if (env.GEMINI_EMBEDDING_API_MODE === "enterprise-agent-platform") {
    return [enterpriseConfig()];
  }

  const primary = resolveGeminiRuntimeConfig({
    GEMINI_API_KEY: env.GEMINI_API_KEY,
    GEMINI_ENTERPRISE_AGENT_KEY_PLATFORM_KEY:
      env.GEMINI_ENTERPRISE_AGENT_KEY_PLATFORM_KEY,
    GEMINI_MODEL: env.GEMINI_EMBEDDING_MODEL,
  });
  if (primary.apiMode !== "enterprise-agent-platform" || !env.GEMINI_API_KEY) {
    return [primary];
  }
  return [primary, developerConfig()];
}

function isUnavailableEmbeddingModel(error: unknown) {
  const details = getGeminiErrorLogDetails(error);
  return details.code === 404 || details.status === "NOT_FOUND";
}

export function buildMaterialEmbeddingConfig(model: string, apiMode: GeminiApiMode) {
  return {
    ...(model === "gemini-embedding-001"
      ? { taskType: "RETRIEVAL_DOCUMENT" as const }
      : {}),
    outputDimensionality: MATERIAL_EMBEDDING_DIMENSIONS,
    ...(apiMode === "enterprise-agent-platform" ? { autoTruncate: true } : {}),
  };
}

export function normalizeEmbedding(values: readonly number[]) {
  if (values.length !== MATERIAL_EMBEDDING_DIMENSIONS) {
    throw new Error(`Gemini material embeddings must contain ${MATERIAL_EMBEDDING_DIMENSIONS} values.`);
  }

  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new Error("Gemini returned an invalid material embedding.");
  }

  return values.map((value) => value / magnitude);
}
