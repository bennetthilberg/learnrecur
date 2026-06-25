import { describe, expect, it, vi } from "vitest";

import {
  getGeminiModelFallbackChain,
  getPublicGeminiFailureMessage,
  isRetryableGeminiModelError,
  parseGeminiFallbackModels,
  runWithGeminiModelFallback,
} from "@/lib/gemini";

describe("Gemini fallback helpers", () => {
  it("deduplicates the primary model and configured fallbacks", () => {
    expect(
      getGeminiModelFallbackChain(" gemini-3.5-flash ", [
        "gemini-3.5-flash",
        " gemini-3.1-flash-lite ",
        "gemini-3.1-flash-lite",
      ]),
    ).toEqual(["gemini-3.5-flash", "gemini-3.1-flash-lite"]);
  });

  it("parses fallback models from comma-separated env values", () => {
    expect(parseGeminiFallbackModels(" gemini-3.1-flash-lite, gemma-4-31b-it ")).toEqual([
      "gemini-3.1-flash-lite",
      "gemma-4-31b-it",
    ]);
    expect(parseGeminiFallbackModels(" ")).toEqual(["gemini-3.1-flash-lite"]);
  });

  it("retries retryable provider errors with the next fallback model", async () => {
    const warningSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const calls: string[] = [];

    await expect(
      runWithGeminiModelFallback({
        primaryModel: "gemini-3.5-flash",
        fallbackModels: ["gemini-3.1-flash-lite"],
        operation: "unit test generation",
        async run(model) {
          calls.push(model);

          if (model === "gemini-3.5-flash") {
            throw new Error(
              JSON.stringify({
                error: {
                  code: 503,
                  message: "This model is currently experiencing high demand.",
                  status: "UNAVAILABLE",
                },
              }),
            );
          }

          return `ok:${model}`;
        },
      }),
    ).resolves.toBe("ok:gemini-3.1-flash-lite");

    expect(calls).toEqual(["gemini-3.5-flash", "gemini-3.1-flash-lite"]);
    expect(warningSpy).toHaveBeenCalledWith(
      "[gemini] retrying with fallback model",
      expect.objectContaining({
        failedModel: "gemini-3.5-flash",
        fallbackModel: "gemini-3.1-flash-lite",
      }),
    );
    warningSpy.mockRestore();
  });

  it("does not retry malformed request errors", async () => {
    const calls: string[] = [];

    await expect(
      runWithGeminiModelFallback({
        primaryModel: "gemini-3.5-flash",
        fallbackModels: ["gemini-3.1-flash-lite"],
        operation: "unit test generation",
        async run(model) {
          calls.push(model);
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
      }),
    ).rejects.toThrow(/INVALID_ARGUMENT/);

    expect(calls).toEqual(["gemini-3.5-flash"]);
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
