import "server-only";

import { randomUUID, timingSafeEqual } from "node:crypto";

export const OPERATIONAL_EVENT_NAME = "learnrecur.operational";
export const READINESS_PROBE_SECRET_ENV = "READINESS_PROBE_SECRET";
export const READINESS_PROBE_SECRET_MIN_LENGTH = 32;
export const REDACTED_OPERATIONAL_VALUE = "[REDACTED]";

const REDACTED_EMAIL = "[REDACTED_EMAIL]";
const REDACTED_URL = "[REDACTED_URL]";
const REDACTED_CREDENTIAL = "[REDACTED_CREDENTIAL]";
const TRUNCATED_OPERATIONAL_VALUE = "[TRUNCATED]";
const MAX_OPERATIONAL_STRING_LENGTH = 512;
const MAX_OPERATIONAL_COLLECTION_ITEMS = 64;
const MAX_OPERATIONAL_OBJECT_DEPTH = 8;

const sensitiveKeyNames = new Set([
  "answer",
  "answer_key",
  "answer_spec",
  "answers",
  "api_key",
  "authorization",
  "cause",
  "content",
  "credential",
  "credentials",
  "email",
  "error",
  "error_detail",
  "error_message",
  "exception",
  "input",
  "output",
  "password",
  "payload",
  "presigned_url",
  "provider_payload",
  "provider_request",
  "provider_response",
  "request_body",
  "response_body",
  "secret",
  "source_content",
  "source_file",
  "source_material",
  "source_text",
  "study_material",
  "text",
  "token",
  "tokens",
]);

const sensitiveKeyPrefixes = [
  "answer_",
  "api_key_",
  "credential_",
  "provider_payload_",
  "request_body_",
  "response_body_",
  "source_content_",
  "source_material_",
  "source_text_",
  "study_material_",
  "token_",
];

const sensitiveKeyFragments = [
  "answer",
  "choice",
  "content",
  "email",
  "input",
  "material",
  "output",
  "payload",
  "prompt",
  "question",
  "raw_text",
  "response",
  "secret",
  "source",
  "text",
  "token",
];

const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu;
const urlPattern = /https?:\/\/[^\s"'<>]+/giu;
const bearerPattern = /\b(?:Bearer|Basic)\s+[A-Z0-9._~+\/-]+=*/giu;
const credentialAssignmentPattern =
  /\b(?:api[_ -]?key|authorization|credential|password|secret|token)\s*[:=]\s*[^\s,;]+/giu;
const commonSecretPattern = /\b(?:sk|pk|re|whsec)_[A-Z0-9_-]+\b/giu;

export type OperationalStatus = "started" | "succeeded" | "failed";

export type OperationalErrorCategory =
  | "authentication"
  | "background"
  | "configuration"
  | "database"
  | "dependency"
  | "provider"
  | "storage"
  | "timeout"
  | "unknown";

export const operationalErrorCategories: readonly OperationalErrorCategory[] = [
  "authentication",
  "background",
  "configuration",
  "database",
  "dependency",
  "provider",
  "storage",
  "timeout",
  "unknown",
];

export type OperationalLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
};

export type OperationalEventInput = {
  operation: string;
  status: OperationalStatus;
  requestId?: string | null;
  correlationId?: string | null;
  durationMs?: number | null;
  provider?: string | null;
  model?: string | null;
  retryCount?: number | null;
  errorCategory?: OperationalErrorCategory | null;
  details?: unknown;
};

export type RequestContext = {
  requestId: string;
  correlationId: string;
};

export function logOperationalEvent(
  input: OperationalEventInput,
  logger: OperationalLogger = console,
): void {
  const event: Record<string, unknown> = {
    event: OPERATIONAL_EVENT_NAME,
    timestamp: new Date().toISOString(),
    operation: input.operation,
    status: input.status,
  };

  addOptionalEventField(event, "requestId", input.requestId);
  addOptionalEventField(event, "correlationId", input.correlationId);
  addOptionalEventField(event, "durationMs", input.durationMs);
  addOptionalEventField(event, "provider", input.provider);
  addOptionalEventField(event, "model", input.model);
  addOptionalEventField(event, "retryCount", input.retryCount);
  addOptionalEventField(event, "errorCategory", input.errorCategory);

  if (input.details !== undefined) {
    event.details = input.details;
  }

  const serializedEvent = JSON.stringify(redactOperationalValue(event));

  if (input.status === "failed") {
    logger.error(serializedEvent);
    return;
  }

  logger.info(serializedEvent);
}

export function redactOperationalValue(value: unknown): unknown {
  return redactValue(value, undefined, new WeakSet<object>(), 0);
}

export function getRequestContext(
  request: Pick<Request, "headers">,
): RequestContext {
  const requestId = readSafeRequestId(request.headers.get("x-request-id")) ?? createRequestId();
  const correlationId =
    readSafeRequestId(request.headers.get("x-correlation-id")) ?? requestId;

  return { requestId, correlationId };
}

export function getReadinessProbeSecret(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const secret = env[READINESS_PROBE_SECRET_ENV]?.trim();
  return secret && secret.length >= READINESS_PROBE_SECRET_MIN_LENGTH
    ? secret
    : undefined;
}

export function constantTimeSecretEqual(
  provided: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  const providedBytes = Buffer.from(provided ?? "", "utf8");
  const expectedBytes = Buffer.from(expected ?? "", "utf8");
  const comparisonLength = Math.max(providedBytes.length, expectedBytes.length);

  if (comparisonLength === 0) {
    return false;
  }

  const paddedProvided = Buffer.alloc(comparisonLength);
  const paddedExpected = Buffer.alloc(comparisonLength);
  providedBytes.copy(paddedProvided);
  expectedBytes.copy(paddedExpected);

  const bytesEqual = timingSafeEqual(paddedProvided, paddedExpected);
  return providedBytes.length === expectedBytes.length && bytesEqual;
}

export function classifyOperationalError(
  error: unknown,
  fallback: OperationalErrorCategory = "unknown",
): OperationalErrorCategory {
  const explicitCategory =
    isRecord(error) && isOperationalErrorCategory(error.category)
      ? error.category
      : null;

  if (explicitCategory) {
    return explicitCategory;
  }

  const description = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  const normalizedDescription = description.toLowerCase();

  if (/timeout|timed out|deadline/.test(normalizedDescription)) {
    return "timeout";
  }
  if (/database|prisma|postgres|neon|sql/.test(normalizedDescription)) {
    return "database";
  }
  if (/s3|bucket|object storage|storage/.test(normalizedDescription)) {
    return "storage";
  }
  if (/gemini|google|meta muse|provider|model/.test(normalizedDescription)) {
    return "provider";
  }
  if (/sqs|dlq|queue|background job|\bjob_/.test(normalizedDescription)) {
    return "background";
  }
  if (/unauthorized|forbidden|authentication|credential|secret/.test(normalizedDescription)) {
    return "authentication";
  }
  if (/missing|environment|configuration|config/.test(normalizedDescription)) {
    return "configuration";
  }

  return fallback;
}

export function isOperationalErrorCategory(value: unknown): value is OperationalErrorCategory {
  return (
    typeof value === "string" &&
    operationalErrorCategories.includes(value as OperationalErrorCategory)
  );
}

function addOptionalEventField(
  event: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (value !== undefined && value !== null) {
    event[key] = value;
  }
}

function redactValue(
  value: unknown,
  key: string | undefined,
  seen: WeakSet<object>,
  depth: number,
): unknown {
  if (key && isSensitiveOperationalKey(key)) {
    return REDACTED_OPERATIONAL_VALUE;
  }

  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return redactOperationalString(value);
  }

  if (typeof value === "bigint") {
    return REDACTED_OPERATIONAL_VALUE;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value !== "object" || value === null) {
    return REDACTED_OPERATIONAL_VALUE;
  }

  if (depth >= MAX_OPERATIONAL_OBJECT_DEPTH || seen.has(value)) {
    return REDACTED_OPERATIONAL_VALUE;
  }

  seen.add(value);

  if (Array.isArray(value)) {
    const items = value
      .slice(0, MAX_OPERATIONAL_COLLECTION_ITEMS)
      .map((item) => redactValue(item, key, seen, depth + 1));

    if (value.length > MAX_OPERATIONAL_COLLECTION_ITEMS) {
      items.push(TRUNCATED_OPERATIONAL_VALUE);
    }

    return items;
  }

  const redactedObject: Record<string, unknown> = {};
  const entries = Object.entries(value).slice(0, MAX_OPERATIONAL_COLLECTION_ITEMS);

  for (const [entryKey, entryValue] of entries) {
    redactedObject[entryKey] = redactValue(entryValue, entryKey, seen, depth + 1);
  }

  if (Object.keys(value).length > MAX_OPERATIONAL_COLLECTION_ITEMS) {
    redactedObject._truncated = TRUNCATED_OPERATIONAL_VALUE;
  }

  return redactedObject;
}

function isSensitiveOperationalKey(key: string): boolean {
  const normalizedKey = key.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();

  return (
    sensitiveKeyNames.has(normalizedKey) ||
    sensitiveKeyPrefixes.some((prefix) => normalizedKey.startsWith(prefix)) ||
    sensitiveKeyFragments.some((fragment) => normalizedKey.includes(fragment))
  );
}

function redactOperationalString(value: string): string {
  const redacted = value
    .replace(emailPattern, REDACTED_EMAIL)
    .replace(urlPattern, REDACTED_URL)
    .replace(bearerPattern, REDACTED_CREDENTIAL)
    .replace(credentialAssignmentPattern, REDACTED_CREDENTIAL)
    .replace(commonSecretPattern, REDACTED_CREDENTIAL);

  if (redacted.length <= MAX_OPERATIONAL_STRING_LENGTH) {
    return redacted;
  }

  return `${redacted.slice(0, MAX_OPERATIONAL_STRING_LENGTH)}${TRUNCATED_OPERATIONAL_VALUE}`;
}

function readSafeRequestId(value: string | null): string | null {
  if (!value || value.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
    return null;
  }

  return value;
}

function createRequestId(): string {
  return `req_${randomUUID().replaceAll("-", "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
