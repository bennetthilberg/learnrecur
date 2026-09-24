import "server-only";

import { GoogleGenAI } from "@google/genai";

import { getGeminiEnv } from "@/lib/env";
import {
  GEMINI_LOW_THINKING_CONFIG,
  resolveGeminiRuntimeConfig,
  runLoggedGeminiOperation,
} from "@/lib/gemini";
import { ACTIVATION_PROVIDER_CHAIN_TIMEOUT_MS } from "@/lib/skills/activation-timing";
import {
  buildMaterialSummaryPrompt,
  materialSummaryResponseSchema,
  type MaterialSummaryGenerator,
} from "@/lib/materials/summary";

const materialSummaryJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["overview", "coverage"],
  properties: {
    overview: { type: "string", minLength: 10, maxLength: 240 },
    coverage: { type: "string", minLength: 10, maxLength: 240 },
  },
};

export function createGeminiMaterialSummaryGenerator(): MaterialSummaryGenerator {
  const env = getGeminiEnv();
  const config = resolveGeminiRuntimeConfig(env);

  return async (input) => {
    const prompt = buildMaterialSummaryPrompt(input);
    try {
      return await runLoggedGeminiOperation({
        config,
        operation: "material summary",
        timeoutMs: ACTIVATION_PROVIDER_CHAIN_TIMEOUT_MS,
        metadata: {
          promptChars: prompt.length,
          schemaName: "material-summary-v1",
        },
        run: async (ai: GoogleGenAI, signal) => {
          const response = await ai.models.generateContent({
            model: config.model,
            contents: [{ role: "user", parts: [{ text: prompt }] }],
            config: {
              abortSignal: signal,
              responseMimeType: "application/json",
              responseJsonSchema: materialSummaryJsonSchema,
              thinkingConfig: GEMINI_LOW_THINKING_CONFIG,
            },
          });
          if (!response.text) {
            throw new Error("Gemini returned no material summary.");
          }
          const value = materialSummaryResponseSchema.parse(JSON.parse(response.text));
          return { response, value };
        },
      });
    } catch (error) {
      const [{ resolveOptionalMetaMuseFallbackConfig }, { runMetaMuseJsonResponse }] =
        await Promise.all([
          import("@/lib/meta-muse-fallback"),
          import("@/lib/meta-muse"),
        ]);
      const museResult = resolveOptionalMetaMuseFallbackConfig();
      const muse = museResult.status === "ready" ? museResult.config : null;
      if (!muse) {
        if (museResult.status === "invalid") {
          console.warn("[ai] meta muse fallback disabled for material summary", {
            message: museResult.message,
          });
        }
        throw error;
      }
      console.warn("[ai] retrying with fallback provider", {
        operation: "material summary",
        failedProvider: "gemini",
        failedModel: config.model,
        fallbackProvider: "meta",
        fallbackModel: muse.model,
      });
      return materialSummaryResponseSchema.parse(
        await runMetaMuseJsonResponse({
          ...muse,
          operation: "material summary",
          timeoutMs: ACTIVATION_PROVIDER_CHAIN_TIMEOUT_MS,
          metadata: { promptChars: prompt.length, schemaName: "material-summary-v1" },
          responseJsonSchema: materialSummaryJsonSchema,
          responseJsonSchemaName: "materialSummary",
          instructions: "Summarize study material faithfully. Return only the requested JSON object.",
          userContent: prompt,
        }),
      );
    }
  };
}
