export const DEFAULT_GEMINI_FALLBACK_MODELS = [] as const;

type GeminiErrorDetails = {
  code: number | null;
  status: string | null;
  message: string | null;
};

type GeminiProviderFallbackInput<T> = {
  fallback?: {
    model: string;
    provider: string;
    run: () => Promise<T>;
  } | null;
  operation: string;
  primaryModel: string;
  runPrimary: () => Promise<T>;
};

export function parseGeminiFallbackModels(value: unknown): string[] {
  if (value === undefined || value === null) {
    return [...DEFAULT_GEMINI_FALLBACK_MODELS];
  }

  if (typeof value === "string") {
    const models = value
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);

    return models.length ? models : [...DEFAULT_GEMINI_FALLBACK_MODELS];
  }

  if (Array.isArray(value)) {
    const models = value
      .filter((model): model is string => typeof model === "string")
      .map((model) => model.trim())
      .filter(Boolean);

    return models.length ? models : [...DEFAULT_GEMINI_FALLBACK_MODELS];
  }

  return [...DEFAULT_GEMINI_FALLBACK_MODELS];
}

export async function runWithGeminiProviderFallback<T>({
  fallback,
  operation,
  primaryModel,
  runPrimary,
}: GeminiProviderFallbackInput<T>): Promise<T> {
  try {
    return await runPrimary();
  } catch (error) {
    if (!fallback || !isRetryableGeminiModelError(error)) {
      throw error;
    }

    console.warn("[ai] retrying with fallback provider", {
      operation,
      failedProvider: "gemini",
      failedModel: primaryModel,
      fallbackProvider: fallback.provider,
      fallbackModel: fallback.model,
      error: getGeminiErrorLogDetails(error),
    });

    return fallback.run();
  }
}

export function isRetryableGeminiModelError(error: unknown): boolean {
  const details = getGeminiErrorDetails(error);

  return isRetryableGeminiErrorDetails(details);
}

export function getPublicGeminiFailureMessage(error: unknown): string {
  const details = getGeminiErrorDetails(error);
  const message = details.message?.toLowerCase() ?? "";

  if (
    isRetryableGeminiErrorDetails(details) ||
    message.includes("high demand") ||
    message.includes("temporarily overloaded") ||
    message.includes("temporarily running out of capacity")
  ) {
    return "The AI service is busy right now, so LearnRecur could not finish creating this skill. Try again in a minute.";
  }

  if (
    details.code === 504 ||
    details.status === "DEADLINE_EXCEEDED" ||
    message.includes("timed out")
  ) {
    return "Creating the skill took too long. Try again with a smaller file or a shorter excerpt.";
  }

  return "LearnRecur could not create a skill from that source. Try again, or use a clearer excerpt.";
}

export function getGeminiErrorLogDetails(error: unknown) {
  return getGeminiErrorDetails(error);
}

function getGeminiErrorDetails(error: unknown): GeminiErrorDetails {
  const records = collectErrorRecords(error);

  for (const record of records) {
    const nested = toRecord(record.error);
    const source = nested ?? record;
    const code = readNumber(source.code) ?? readNumber(source.statusCode) ?? readNumber(record.status);
    const status = readString(source.status) ?? readString(source.code);
    const message = readString(source.message) ?? readString(record.message);

    if (code || status || message) {
      return {
        code,
        status,
        message,
      };
    }
  }

  if (error instanceof Error && error.message.trim()) {
    return {
      code: null,
      status: null,
      message: error.message,
    };
  }

  if (typeof error === "string" && error.trim()) {
    return {
      code: null,
      status: null,
      message: error,
    };
  }

  return {
    code: null,
    status: null,
    message: null,
  };
}

function isRetryableGeminiErrorDetails(details: GeminiErrorDetails): boolean {
  const status = details.status?.toUpperCase() ?? null;

  return (
    details.code === 429 ||
    details.code === 500 ||
    details.code === 503 ||
    status === "INTERNAL" ||
    status === "RESOURCE_EXHAUSTED" ||
    status === "UNAVAILABLE"
  );
}

function collectErrorRecords(error: unknown): Array<Record<string, unknown>> {
  const records: Array<Record<string, unknown>> = [];
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : null;
  const parsedMessage = parseJsonRecord(message);

  if (parsedMessage) {
    records.push(parsedMessage);
  }

  const direct = toRecord(error);

  if (direct) {
    records.push(direct);
  }

  return records;
}

function parseJsonRecord(value: string | null): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  try {
    return toRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }

  return null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
