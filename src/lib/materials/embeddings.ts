import "server-only";

import { GoogleGenAI } from "@google/genai";

import { getGeminiEnv } from "@/lib/env";
import { resolveGeminiRuntimeConfig } from "@/lib/gemini";
import { MATERIAL_EMBEDDING_DIMENSIONS } from "@/lib/materials/retrieval";

export type MaterialEmbeddingGenerator = (input: {
  texts: string[];
  titles?: Array<string | null>;
}) => Promise<number[][]>;

export function createGeminiMaterialEmbeddingGenerator(): MaterialEmbeddingGenerator {
  const env = getGeminiEnv();
  const config = resolveGeminiRuntimeConfig(env);
  const ai = new GoogleGenAI(config.clientOptions);

  return async ({ texts, titles = [] }) => {
    if (texts.length === 0) {
      return [];
    }

    const startedAt = Date.now();
    console.info("[ai] material embedding request started", {
      provider: "google",
      apiMode: config.apiMode,
      endpoint: config.endpoint,
      model: env.GEMINI_EMBEDDING_MODEL,
      count: texts.length,
      inputCharacters: texts.reduce((total, text) => total + text.length, 0),
    });

    try {
      const response = await ai.models.embedContent({
        model: env.GEMINI_EMBEDDING_MODEL,
        contents: texts.map((text, index) => ({
          role: "user",
          parts: [{ text: titles[index] ? `${titles[index]}\n\n${text}` : text }],
        })),
        config: buildMaterialEmbeddingConfig(env.GEMINI_EMBEDDING_MODEL),
      });
      const embeddings = response.embeddings ?? [];
      if (embeddings.length !== texts.length) {
        throw new Error("Gemini returned the wrong number of material embeddings.");
      }

      const values = embeddings.map((embedding) => normalizeEmbedding(embedding.values ?? []));
      console.info("[ai] material embedding request succeeded", {
        provider: "google",
        apiMode: config.apiMode,
        endpoint: config.endpoint,
        model: env.GEMINI_EMBEDDING_MODEL,
        count: values.length,
        elapsedMs: Date.now() - startedAt,
      });
      return values;
    } catch (error) {
      console.error("[ai] material embedding request failed", {
        provider: "google",
        apiMode: config.apiMode,
        endpoint: config.endpoint,
        model: env.GEMINI_EMBEDDING_MODEL,
        count: texts.length,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Unknown embedding error",
      });
      throw error;
    }
  };
}

export function buildMaterialEmbeddingConfig(model: string) {
  return {
    ...(model === "gemini-embedding-001"
      ? { taskType: "RETRIEVAL_DOCUMENT" as const }
      : {}),
    outputDimensionality: MATERIAL_EMBEDDING_DIMENSIONS,
    autoTruncate: true,
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
