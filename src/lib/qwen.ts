export const DEFAULT_QWEN_BASE_URL = "https://dashscope-us.aliyuncs.com/compatible-mode/v1";
export const DEFAULT_QWEN_MODEL = "qwen3.7-plus";

export type QwenFallbackConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

type QwenTextPart = {
  type: "text";
  text: string;
};

type QwenImagePart = {
  type: "image_url";
  image_url: {
    url: string;
  };
};

export type QwenChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | Array<QwenTextPart | QwenImagePart>;
};

type QwenJsonChatCompletionInput = {
  apiKey: string;
  baseUrl: string;
  messages: QwenChatMessage[];
  model: string;
  operation: string;
};

export async function runQwenJsonChatCompletion({
  apiKey,
  baseUrl,
  messages,
  model,
  operation,
}: QwenJsonChatCompletionInput): Promise<unknown> {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      response_format: {
        type: "json_object",
      },
      enable_thinking: false,
    }),
  });

  const rawBody = await response.text();
  const body = parseMaybeJson(rawBody);

  if (!response.ok) {
    throw new Error(
      JSON.stringify({
        error: {
          code: response.status,
          status: readQwenErrorCode(body) ?? response.statusText,
          message: readQwenErrorMessage(body) ?? `${operation} failed with Qwen.`,
        },
      }),
    );
  }

  const content = readQwenMessageContent(body);

  if (!content) {
    throw new Error("Qwen returned no text.");
  }

  try {
    return JSON.parse(content) as unknown;
  } catch {
    throw new Error("Qwen returned invalid JSON.");
  }
}

export function buildQwenImageDataUrl(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function parseMaybeJson(value: string): unknown {
  if (!value.trim()) {
    return null;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function readQwenMessageContent(value: unknown): string | null {
  const record = toRecord(value);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const firstChoice = toRecord(choices[0]);
  const message = toRecord(firstChoice?.message);
  const content = message?.content;

  return typeof content === "string" && content.trim() ? content.trim() : null;
}

function readQwenErrorCode(value: unknown): string | null {
  const error = toRecord(toRecord(value)?.error);
  const code = error?.code;

  return typeof code === "string" && code.trim() ? code.trim() : null;
}

function readQwenErrorMessage(value: unknown): string | null {
  const error = toRecord(toRecord(value)?.error);
  const message = error?.message;

  return typeof message === "string" && message.trim() ? message.trim() : null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
