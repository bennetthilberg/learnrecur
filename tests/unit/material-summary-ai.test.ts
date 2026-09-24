import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getGeminiEnv: vi.fn(),
  resolveGeminiRuntimeConfig: vi.fn(),
  runLoggedGeminiOperation: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getGeminiEnv: mocks.getGeminiEnv,
}));

vi.mock("@/lib/gemini", () => ({
  GEMINI_LOW_THINKING_CONFIG: {},
  getGeminiRuntimeLogContext: vi.fn(() => ({})),
  resolveGeminiRuntimeConfig: mocks.resolveGeminiRuntimeConfig,
  runLoggedGeminiOperation: mocks.runLoggedGeminiOperation,
  runWithGeminiProviderFallback: vi.fn(({ runPrimary }: { runPrimary: () => Promise<unknown> }) => runPrimary()),
}));

vi.mock("@/lib/meta-muse-fallback", () => ({
  resolveOptionalMetaMuseFallbackConfig: vi.fn(() => ({ status: "ready", config: null })),
}));

import { createGeminiMaterialSummaryGenerator } from "@/lib/materials/summary-ai";
import { ACTIVATION_PROVIDER_CHAIN_TIMEOUT_MS } from "@/lib/skills/activation-timing";

describe("Gemini material summary timeout", () => {
  it("uses the bounded provider-chain timeout instead of the generic short default", async () => {
    const config = { model: "gemini-3.8-flash" };
    mocks.getGeminiEnv.mockReturnValue({});
    mocks.resolveGeminiRuntimeConfig.mockReturnValue(config);
    mocks.runLoggedGeminiOperation.mockResolvedValue({
      overview: "A practical Spanish grammar reference",
      coverage: "It moves from sentence structure through verb forms and pronouns",
    });

    const generate = createGeminiMaterialSummaryGenerator();
    await generate({
      materialTitle: "Practical Spanish Grammar",
      materialKind: "PDF",
      outlineTitles: ["Pronouns"],
      excerpt: "Spanish direct object pronouns replace a noun.",
    });

    expect(mocks.runLoggedGeminiOperation).toHaveBeenCalledWith(expect.objectContaining({
      config,
      operation: "material summary",
      timeoutMs: ACTIVATION_PROVIDER_CHAIN_TIMEOUT_MS,
    }));
  });
});
