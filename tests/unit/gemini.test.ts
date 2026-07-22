import { describe, expect, it, vi } from "vitest";

import {
  getGeminiRuntimeLogContext,
  getPublicGeminiFailureMessage,
  getPublicGeminiScopePlanningFailureMessage,
  isRetryableGeminiModelError,
  parseGeminiFallbackModels,
  resolveGeminiRuntimeConfig,
  runWithGeminiProviderFallback,
} from "@/lib/gemini";

describe("Gemini fallback helpers", () => {
  it("defaults the primary model to Gemini 3.6 Flash", () => {
    const config = resolveGeminiRuntimeConfig({
      GEMINI_API_KEY: "developer-key",
    });

    expect(config.model).toBe("gemini-3.6-flash");
  });

  it("parses fallback models from comma-separated env values", () => {
    expect(parseGeminiFallbackModels(" gemini-3.1-flash-lite, gemma-4-31b-it ")).toEqual([
      "gemini-3.1-flash-lite",
      "gemma-4-31b-it",
    ]);
    expect(parseGeminiFallbackModels(" ")).toEqual([]);
  });

  it("prefers Gemini Enterprise Agent Platform when its key is configured", () => {
    const config = resolveGeminiRuntimeConfig({
      GEMINI_API_KEY: "developer-key",
      GEMINI_ENTERPRISE_AGENT_KEY_PLATFORM_KEY: "enterprise-key",
      GEMINI_MODEL: "gemini-3.5-flash",
    });

    expect(getGeminiRuntimeLogContext(config)).toEqual({
      provider: "google",
      apiMode: "enterprise-agent-platform",
      endpoint: "https://aiplatform.googleapis.com/",
      model: "gemini-3.5-flash",
    });
    expect(config.clientOptions).toMatchObject({
      vertexai: true,
      apiKey: "enterprise-key",
      httpOptions: {
        apiVersion: "v1",
      },
    });
  });

  it("uses the Gemini Developer API when no Enterprise Agent Platform key is configured", () => {
    const config = resolveGeminiRuntimeConfig({
      GEMINI_API_KEY: "developer-key",
      GEMINI_MODEL: "gemini-3.5-flash",
    });

    expect(getGeminiRuntimeLogContext(config)).toEqual({
      provider: "google",
      apiMode: "developer-api",
      endpoint: "https://generativelanguage.googleapis.com/",
      model: "gemini-3.5-flash",
    });
    expect(config.clientOptions).toEqual({
      apiKey: "developer-key",
    });
  });

  it("retries retryable provider errors with MetaMuse fallback", async () => {
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
          provider: "meta",
          model: "muse-spark-1.1",
          async run() {
            calls.push("meta");
            return "ok:meta";
          },
        },
      }),
    ).resolves.toBe("ok:meta");

    expect(calls).toEqual(["gemini", "meta"]);
    expect(warningSpy).toHaveBeenCalledWith(
      "[ai] retrying with fallback provider",
      expect.objectContaining({
        failedModel: "gemini-3.5-flash",
        fallbackProvider: "meta",
        fallbackModel: "muse-spark-1.1",
      }),
    );
    warningSpy.mockRestore();
  });

  it.each([
    { code: 502, status: "BAD_GATEWAY" },
    { code: 504, status: "GATEWAY_TIMEOUT" },
    { code: 504, status: "DEADLINE_EXCEEDED" },
  ])(
    "retries transient Gemini gateway failures ($code $status) with MetaMuse fallback",
    async ({ code, status }) => {
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
                  code,
                  message: "The upstream Gemini request could not complete.",
                  status,
                },
              }),
            );
          },
          fallback: {
            provider: "meta",
            model: "muse-spark-1.1",
            async run() {
              calls.push("meta");
              return "ok:meta";
            },
          },
        }),
      ).resolves.toBe("ok:meta");

      expect(calls).toEqual(["gemini", "meta"]);
      warningSpy.mockRestore();
    },
  );

  it("treats Gemini deadline status as retryable even without an HTTP code", () => {
    const error = new Error(
      JSON.stringify({
        error: {
          message: "The request exceeded its deadline.",
          status: "DEADLINE_EXCEEDED",
        },
      }),
    );

    expect(isRetryableGeminiModelError(error)).toBe(true);
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
          provider: "meta",
          model: "muse-spark-1.1",
          async run() {
            calls.push("meta");
            return "ok:meta";
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

  it("returns a scope-specific public message without exposing provider JSON", () => {
    const error = new Error(
      JSON.stringify({
        error: {
          code: 400,
          message: "Request contains an invalid argument.",
          status: "INVALID_ARGUMENT",
        },
      }),
    );

    expect(getPublicGeminiScopePlanningFailureMessage(error)).toBe(
      "LearnRecur could not review that scope. Check the request and try again.",
    );
    expect(getPublicGeminiScopePlanningFailureMessage(error)).not.toContain("{");
    expect(getPublicGeminiScopePlanningFailureMessage(error)).not.toContain(
      "INVALID_ARGUMENT",
    );
  });

  it("uses scope-specific recovery guidance for model timeouts", () => {
    const error = new Error(
      JSON.stringify({
        error: {
          code: 504,
          message: "The request timed out.",
          status: "DEADLINE_EXCEEDED",
        },
      }),
    );

    expect(getPublicGeminiScopePlanningFailureMessage(error)).toBe(
      "Reviewing the scope took too long. Try a narrower request.",
    );
  });
});
