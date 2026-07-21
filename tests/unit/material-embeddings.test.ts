import { describe, expect, it } from "vitest";

import {
  buildMaterialEmbeddingConfig,
  resolveMaterialEmbeddingRuntimeConfigs,
} from "@/lib/materials/embeddings";

describe("material embedding requests", () => {
  it("preserves enterprise precedence while allowing an explicit 404 fallback", () => {
    const configs = resolveMaterialEmbeddingRuntimeConfigs({
      GEMINI_API_KEY: "developer-key",
      GEMINI_ENTERPRISE_AGENT_KEY_PLATFORM_KEY: "enterprise-key",
      GEMINI_MODEL: "gemini-3.5-flash",
      GEMINI_EMBEDDING_MODEL: "gemini-embedding-2",
      GEMINI_EMBEDDING_API_MODE: "auto",
      GEMINI_FALLBACK_MODELS: [],
    });

    expect(configs).toHaveLength(2);
    expect(configs[0]).toMatchObject({
      apiMode: "enterprise-agent-platform",
      endpoint: "https://aiplatform.googleapis.com/",
      model: "gemini-embedding-2",
      clientOptions: { apiKey: "enterprise-key" },
    });
    expect(configs[1]).toMatchObject({
      apiMode: "developer-api",
      endpoint: "https://generativelanguage.googleapis.com/",
      model: "gemini-embedding-2",
      clientOptions: { apiKey: "developer-key" },
    });
  });

  it("can require Developer API routing for embeddings", () => {
    const configs = resolveMaterialEmbeddingRuntimeConfigs({
      GEMINI_API_KEY: "developer-key",
      GEMINI_ENTERPRISE_AGENT_KEY_PLATFORM_KEY: "enterprise-key",
      GEMINI_MODEL: "gemini-3.5-flash",
      GEMINI_EMBEDDING_MODEL: "gemini-embedding-2",
      GEMINI_EMBEDDING_API_MODE: "developer-api",
      GEMINI_FALLBACK_MODELS: [],
    });

    expect(configs).toHaveLength(1);
    expect(configs[0]).toMatchObject({ apiMode: "developer-api" });
  });

  it("omits Vertex-only truncation controls for the Developer API", () => {
    expect(buildMaterialEmbeddingConfig("gemini-embedding-2", "developer-api")).toEqual({
      outputDimensionality: 768,
    });
  });

  it("keeps enterprise truncation and legacy retrieval task controls", () => {
    expect(
      buildMaterialEmbeddingConfig("gemini-embedding-001", "enterprise-agent-platform"),
    ).toEqual({
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: 768,
      autoTruncate: true,
    });
  });
});
