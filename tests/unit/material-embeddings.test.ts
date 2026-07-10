import { describe, expect, it } from "vitest";

import { buildMaterialEmbeddingConfig } from "@/lib/materials/embeddings";

describe("material embedding requests", () => {
  it("omits taskType for Gemini Embedding 2", () => {
    expect(buildMaterialEmbeddingConfig("gemini-embedding-2")).toEqual({
      outputDimensionality: 768,
      autoTruncate: true,
    });
  });

  it("keeps retrieval-document taskType for the legacy embedding model", () => {
    expect(buildMaterialEmbeddingConfig("gemini-embedding-001")).toEqual({
      taskType: "RETRIEVAL_DOCUMENT",
      outputDimensionality: 768,
      autoTruncate: true,
    });
  });
});
