import { describe, expect, it, vi } from "vitest";

import {
  getPublicGeminiFailureMessage,
  isRetryableGeminiModelError,
  parseGeminiFallbackModels,
  runWithGeminiProviderFallback,
} from "@/lib/gemini";

describe("Gemini fallback helpers", () => {
  it("parses fallback models from comma-separated env values", () => {
    expect(parseGeminiFallbackModels(" gemini-3.1-flash-lite, gemma-4-31b-it ")).toEqual([
      "gemini-3.1-flash-lite",
      "gemma-4-31b-it",
    ]);
    expect(parseGeminiFallbackModels(" ")).toEqual([]);
  });

  it("retries retryable provider errors with Qwen fallback", async () => {
    const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: string[] = [];

    await expect(
      runWithGeminiProviderFallback({
        primaryModel: "gemini-3.5-flash",
        operation: "unit test generation",
        async runPrimary() {
          calls.push("gemini");
          throw new Error(
            JSON.stringify({
              error: {
                code: 503,
                message: "This model is currently experiencing high demand.",
                status: "UNAVAILABLE",
              },
            }),
          );
        },
        fallback: {
          provider: "qwen",
          model: "qwen3.7-plus",
          async run() {
            calls.push("qwen");
            return "ok:qwen";
          },
        },
      }),
    ).resolves.toBe("ok:qwen");

    expect(calls).toEqual(["gemini", "qwen"]);
    expect(warningSpy).toHaveBeenCalledWith(
      "[ai] retrying with fallback provider",
      expect.objectContaining({
        failedModel: "gemini-3.5-flash",
        fallbackProvider: "qwen",
        fallbackModel: "qwen3.7-plus",
      }),
    );
    warningSpy.mockRestore();
  });

  it("does not retry malformed request errors", async () => {
    const calls: string[] = [];

    await expect(
      runWithGeminiProviderFallback({
        primaryModel: "gemini-3.5-flash",
        operation: "unit test generation",
        async runPrimary() {
          calls.push("gemini");
          throw new Error(
            JSON.stringify({
              error: {
                code: 400,
                message: "The request body is malformed.",
                status: "INVALID_ARGUMENT",
              },
            }),
          );
        },
        fallback: {
          provider: "qwen",
          model: "qwen3.7-plus",
          async run() {
            calls.push("qwen");
            return "ok:qwen";
          },
        },
      }),
    ).rejects.toThrow(/INVALID_ARGUMENT/);

    expect(calls).toEqual(["gemini"]);
  });

  it("returns clean public messages for provider overload", () => {
    const error = new Error(
      JSON.stringify({
        error: {
          code: 503,
          message: "This model is currently experiencing high demand.",
          status: "UNAVAILABLE",
        },
      }),
    );

    expect(isRetryableGeminiModelError(error)).toBe(true);
    expect(getPublicGeminiFailureMessage(error)).toBe(
      "The AI service is busy right now, so LearnRecur could not finish creating this skill. Try again in a minute.",
    );
    expect(getPublicGeminiFailureMessage(error)).not.toContain("{");
  });

  it("treats Gemini rate limits as retryable capacity failures", () => {
    const error = new Error(
      JSON.stringify({
        error: {
          code: 429,
          message: "Quota exceeded for this request.",
          status: "RESOURCE_EXHAUSTED",
        },
      }),
    );

    expect(isRetryableGeminiModelError(error)).toBe(true);
    expect(getPublicGeminiFailureMessage(error)).toBe(
      "The AI service is busy right now, so LearnRecur could not finish creating this skill. Try again in a minute.",
    );
  });
});
