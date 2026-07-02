export const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it";

export type OpenRouterFallbackConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

type OpenRouterTextPart = {
  type: "text";
  text: string;
};

type OpenRouterImagePart = {
  type: "image_url";
  image_url: {
    url: string;
  };
};

type OpenRouterFilePart = {
  type: "file";
  file: {
    filename: string;
    file_data: string;
  };
};

export type OpenRouterContentPart =
  | OpenRouterTextPart
  | OpenRouterImagePart
  | OpenRouterFilePart;

export type OpenRouterChatMessage = {
  role: "system" | "user" | "assistant";
  content: string | OpenRouterContentPart[];
};

type OpenRouterJsonChatCompletionInput = {
  apiKey: string;
  baseUrl: string;
  messages: OpenRouterChatMessage[];
  metadata?: Record<string, unknown>;
  model: string;
  operation: string;
  responseJsonSchema?: Record<string, unknown>;
  responseJsonSchemaName?: string;
};

export async function runOpenRouterJsonChatCompletion({
  apiKey,
  baseUrl,
  messages,
  metadata,
  model,
  operation,
  responseJsonSchema,
  responseJsonSchemaName,
}: OpenRouterJsonChatCompletionInput): Promise<unknown> {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const requestId = buildOpenRouterRequestId();
  const startedAt = Date.now();
  const context = {
    requestId,
    operation,
    provider: "openrouter",
    apiMode: "chat-completions",
    endpoint,
    model,
    ...metadata,
  };

  console.info("[ai] openrouter request started", context);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Title": "LearnRecur",
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0,
        response_format: responseJsonSchema
          ? {
              type: "json_schema",
              json_schema: {
                name: responseJsonSchemaName ?? "learnrecur_json_response",
                strict: true,
                schema: responseJsonSchema,
              },
            }
          : {
              type: "json_object",
            },
      }),
    });

    const rawBody = await response.text();
    const body = parseMaybeJson(rawBody);

    if (!response.ok) {
      throw buildOpenRouterError(response, body, operation);
    }

    const content = readOpenRouterMessageContent(body);

    if (!content) {
      throw new Error("OpenRouter returned no text.");
    }

    let value: unknown;

    try {
      value = JSON.parse(content) as unknown;
    } catch {
      throw new Error("OpenRouter returned invalid JSON.");
    }

    console.info("[ai] openrouter request succeeded", {
      ...context,
      elapsedMs: Date.now() - startedAt,
      finishReason: readOpenRouterFinishReason(body),
      outputTextLength: content?.length ?? 0,
      responseModel: readOpenRouterResponseModel(body),
      usageMetadata: summarizeOpenRouterUsage(body),
    });

    return value;
  } catch (error) {
    console.error("[ai] openrouter request failed", {
      ...context,
      elapsedMs: Date.now() - startedAt,
      error: getOpenRouterErrorLogDetails(error),
    });
    throw error;
  }
}

export function buildOpenRouterDataUrl(bytes: Buffer, mimeType: string): string {
  return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

function buildOpenRouterRequestId(): string {
  return `openrouter_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function buildOpenRouterError(response: Response, body: unknown, operation: string): Error {
  const errorRecord = toRecord(toRecord(body)?.error);
  const code = readNumber(errorRecord?.code) ?? response.status;
  const status =
    readString(errorRecord?.code) ?? readString(errorRecord?.status) ?? response.statusText;
  const message =
    readString(errorRecord?.message) ?? `${operation} failed with OpenRouter.`;

  return new Error(
    JSON.stringify({
      error: {
        code,
        status,
        message,
      },
    }),
  );
}

function getOpenRouterErrorLogDetails(error: unknown) {
  const record = parseJsonRecord(error instanceof Error ? error.message : null);
  const nested = toRecord(record?.error) ?? record;

  if (nested) {
    return {
      code: readNumber(nested.code),
      status: readString(nested.status) ?? readString(nested.code),
      message: readString(nested.message),
    };
  }

  if (error instanceof Error && error.message.trim()) {
    return {
      code: null,
      status: null,
      message: error.message,
    };
  }

  return {
    code: null,
    status: null,
    message: null,
  };
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

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    return toRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function readOpenRouterMessageContent(value: unknown): string | null {
  const record = toRecord(value);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const firstChoice = toRecord(choices[0]);
  const message = toRecord(firstChoice?.message);
  const content = message?.content;

  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => readString(toRecord(part)?.text))
      .filter((part): part is string => Boolean(part))
      .join("\n")
      .trim();

    return text || null;
  }

  return null;
}

function readOpenRouterFinishReason(value: unknown): string | null {
  const record = toRecord(value);
  const choices = Array.isArray(record?.choices) ? record.choices : [];
  const firstChoice = toRecord(choices[0]);

  return readString(firstChoice?.finish_reason);
}

function readOpenRouterResponseModel(value: unknown): string | null {
  return readString(toRecord(value)?.model);
}

function summarizeOpenRouterUsage(value: unknown) {
  const usage = toRecord(toRecord(value)?.usage);

  if (!usage) {
    return null;
  }

  return {
    promptTokenCount: readNumber(usage.prompt_tokens),
    candidatesTokenCount: readNumber(usage.completion_tokens),
    totalTokenCount: readNumber(usage.total_tokens),
    cost: readNumber(usage.cost),
  };
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
