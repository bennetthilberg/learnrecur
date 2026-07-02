import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_OPENROUTER_BASE_URL,
  DEFAULT_OPENROUTER_MODEL,
  buildOpenRouterDataUrl,
  runOpenRouterJsonChatCompletion,
} from "@/lib/openrouter";
import {
  resolveOpenRouterFallbackConfig,
  resolveOptionalOpenRouterFallbackConfig,
} from "@/lib/openrouter-fallback";

const originalEnv = process.env;

describe("OpenRouter OpenAI-compatible client", () => {
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = originalEnv;
  });

  it("requests strict JSON schema output from Gemma 4 31B defaults", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({ drafts: [{ title: "Ser vs. estar" }] }),
              },
            },
          ],
          model: DEFAULT_OPENROUTER_MODEL,
          usage: {
            completion_tokens: 10,
            prompt_tokens: 20,
            total_tokens: 30,
          },
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["drafts"],
      properties: {
        drafts: {
          type: "array",
          items: {
            type: "object",
          },
        },
      },
    };

    await expect(
      runOpenRouterJsonChatCompletion({
        apiKey: "sk-or-test",
        baseUrl: DEFAULT_OPENROUTER_BASE_URL,
        model: DEFAULT_OPENROUTER_MODEL,
        operation: "skill draft generation",
        responseJsonSchema: schema,
        responseJsonSchemaName: "skillDraft",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Return JSON.",
              },
              {
                type: "image_url",
                image_url: {
                  url: buildOpenRouterDataUrl(Buffer.from("image"), "image/png"),
                },
              },
            ],
          },
        ],
      }),
    ).resolves.toEqual({ drafts: [{ title: "Ser vs. estar" }] });

    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_OPENROUTER_BASE_URL}/chat/completions`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-or-test",
          "X-Title": "LearnRecur",
        }),
        body: expect.any(String),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      model: DEFAULT_OPENROUTER_MODEL,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "skillDraft",
          strict: true,
          schema,
        },
      },
    });
    expect(fetchMock.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("normalizes OpenRouter errors for the shared AI error handler", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "rate_limited",
              message: "Requests are temporarily limited.",
            },
          }),
          {
            status: 429,
            statusText: "Too Many Requests",
          },
        ),
      ),
    );

    await expect(
      runOpenRouterJsonChatCompletion({
        apiKey: "sk-or-test",
        baseUrl: DEFAULT_OPENROUTER_BASE_URL,
        model: DEFAULT_OPENROUTER_MODEL,
        operation: "skill draft generation",
        messages: [],
      }),
    ).rejects.toThrow(/Requests are temporarily limited/);
  });

  it("aborts stalled OpenRouter requests after the configured timeout", async () => {
    vi.useFakeTimers();

    const fetchMock = vi.fn(
      (_endpoint: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;

          if (!(signal instanceof AbortSignal)) {
            reject(new Error("Expected OpenRouter fetch to receive an AbortSignal."));
            return;
          }

          signal.addEventListener("abort", () => {
            reject(signal.reason);
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = runOpenRouterJsonChatCompletion({
      apiKey: "sk-or-test",
      baseUrl: DEFAULT_OPENROUTER_BASE_URL,
      model: DEFAULT_OPENROUTER_MODEL,
      operation: "skill draft generation",
      messages: [],
      timeoutMs: 25,
    });
    const expectation = expect(result).rejects.toThrow(
      "skill draft generation timed out after 25ms with OpenRouter.",
    );

    await vi.advanceTimersByTimeAsync(25);

    await expectation;
    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_OPENROUTER_BASE_URL}/chat/completions`,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("builds data URLs for multimodal image and PDF fallbacks", () => {
    expect(buildOpenRouterDataUrl(Buffer.from("image"), "image/png")).toBe(
      "data:image/png;base64,aW1hZ2U=",
    );
    expect(buildOpenRouterDataUrl(Buffer.from("%PDF"), "application/pdf")).toBe(
      "data:application/pdf;base64,JVBERg==",
    );
  });

  it("disables fallback when the optional OpenRouter API key is absent", () => {
    process.env = {
      ...originalEnv,
      OPENROUTER_API_KEY: "",
      OPENROUTER_BASE_URL: "",
      OPENROUTER_MODEL: "",
    };

    expect(resolveOpenRouterFallbackConfig()).toBeNull();
    expect(resolveOptionalOpenRouterFallbackConfig()).toEqual({
      status: "ready",
      config: null,
    });
  });

  it("reports invalid optional OpenRouter fallback configuration without throwing", () => {
    process.env = {
      ...originalEnv,
      OPENROUTER_API_KEY: "sk-or-test",
      OPENROUTER_BASE_URL: "not-a-url",
      OPENROUTER_MODEL: DEFAULT_OPENROUTER_MODEL,
    };

    expect(resolveOptionalOpenRouterFallbackConfig()).toMatchObject({
      status: "invalid",
    });
  });
});
