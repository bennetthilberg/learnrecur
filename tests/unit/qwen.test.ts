import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_QWEN_BASE_URL,
  DEFAULT_QWEN_MODEL,
  buildQwenImageDataUrl,
  runQwenJsonChatCompletion,
} from "@/lib/qwen";
import {
  resolveOptionalQwenFallbackConfig,
  resolveQwenFallbackConfig,
} from "@/lib/qwen-fallback";

const originalEnv = process.env;

describe("Qwen OpenAI-compatible client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = originalEnv;
  });

  it("requests JSON mode with non-thinking qwen3.7-plus defaults", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ drafts: [{ title: "Ser vs. estar" }] }),
              },
            },
          ],
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

    await expect(
      runQwenJsonChatCompletion({
        apiKey: "qwen-key",
        baseUrl: DEFAULT_QWEN_BASE_URL,
        model: DEFAULT_QWEN_MODEL,
        operation: "skill draft generation",
        messages: [
          {
            role: "user",
            content: "Return JSON.",
          },
        ],
      }),
    ).resolves.toEqual({ drafts: [{ title: "Ser vs. estar" }] });

    expect(fetchMock).toHaveBeenCalledWith(
      `${DEFAULT_QWEN_BASE_URL}/chat/completions`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer qwen-key",
        }),
        body: expect.any(String),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      model: "qwen3.7-plus",
      response_format: {
        type: "json_object",
      },
      enable_thinking: false,
    });
  });

  it("normalizes OpenAI-compatible errors for the shared AI error handler", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "Throttling",
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
      runQwenJsonChatCompletion({
        apiKey: "qwen-key",
        baseUrl: DEFAULT_QWEN_BASE_URL,
        model: DEFAULT_QWEN_MODEL,
        operation: "skill draft generation",
        messages: [],
      }),
    ).rejects.toThrow(/Requests are temporarily limited/);
  });

  it("builds image data URLs for multimodal source extraction fallback", () => {
    expect(buildQwenImageDataUrl(Buffer.from("image"), "image/png")).toBe(
      "data:image/png;base64,aW1hZ2U=",
    );
  });

  it("disables fallback when the optional Qwen API key is absent", () => {
    process.env = {
      ...originalEnv,
      QWEN_API_KEY: "",
      QWEN_BASE_URL: "",
      QWEN_MODEL: "",
    };

    expect(resolveQwenFallbackConfig()).toBeNull();
    expect(resolveOptionalQwenFallbackConfig()).toEqual({
      status: "ready",
      config: null,
    });
  });

  it("reports invalid optional Qwen fallback configuration without throwing", () => {
    process.env = {
      ...originalEnv,
      QWEN_API_KEY: "qwen-secret",
      QWEN_BASE_URL: "not-a-url",
      QWEN_MODEL: "qwen3.7-plus",
    };

    expect(resolveOptionalQwenFallbackConfig()).toMatchObject({
      status: "invalid",
    });
  });
});
