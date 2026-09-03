import "server-only";

import { getInngestEnvStatus } from "@/lib/inngest/client";
import { getGeminiEnv } from "@/lib/env";
import { resolveGeminiRuntimeConfig } from "@/lib/gemini";
import { getPrisma } from "@/lib/prisma";
import { resolveS3SourceObjectStorage } from "@/lib/storage/s3";

import {
  classifyOperationalError,
  constantTimeSecretEqual,
  getReadinessProbeSecret,
  getRequestContext,
  logOperationalEvent,
  type OperationalErrorCategory,
  type OperationalLogger,
} from "./index";

export const READINESS_CHECK_TIMEOUT_MS = 3_000;
export const READINESS_STORAGE_PROBE_KEY = "__learnrecur_readiness_probe__/missing";

export type ReadinessCheck = {
  name: string;
  category?: OperationalErrorCategory;
  run: () => void | Promise<void>;
};

export type ReadinessCheckResult =
  | {
      name: string;
      status: "ok";
    }
  | {
      name: string;
      status: "failed";
      category: OperationalErrorCategory;
    };

export type ReadinessResult = {
  status: "ready" | "not_ready";
  checks: ReadinessCheckResult[];
};

export type HealthHandlerOptions = {
  logger?: OperationalLogger;
  probe?: () => void | Promise<void>;
};

export type ReadinessHandlerOptions = {
  checks?: readonly ReadinessCheck[];
  logger?: OperationalLogger;
  secret?: string;
  timeoutMs?: number;
};

export class ReadinessProbeError extends Error {
  readonly category: OperationalErrorCategory;

  constructor(category: OperationalErrorCategory, message: string) {
    super(message);
    this.name = "ReadinessProbeError";
    this.category = category;
  }
}

export async function handleHealthRequest(
  request: Request,
  options: HealthHandlerOptions = {},
): Promise<Response> {
  const startedAt = Date.now();
  const context = getRequestContext(request);
  const logger = options.logger;

  try {
    await options.probe?.();
    logOperationalEvent(
      {
        operation: "api.health",
        status: "succeeded",
        requestId: context.requestId,
        correlationId: context.correlationId,
        durationMs: elapsedMs(startedAt),
      },
      logger,
    );

    return jsonResponse(
      { status: "ok" },
      200,
      context,
    );
  } catch (error) {
    logOperationalEvent(
      {
        operation: "api.health",
        status: "failed",
        requestId: context.requestId,
        correlationId: context.correlationId,
        durationMs: elapsedMs(startedAt),
        errorCategory: classifyOperationalError(error),
      },
      logger,
    );

    return jsonResponse(
      { status: "unhealthy" },
      503,
      context,
    );
  }
}

export async function handleReadinessRequest(
  request: Request,
  options: ReadinessHandlerOptions = {},
): Promise<Response> {
  const startedAt = Date.now();
  const context = getRequestContext(request);
  const logger = options.logger;
  const secret = options.secret === undefined
    ? getReadinessProbeSecret()
    : options.secret.trim() || undefined;

  if (!secret) {
    logOperationalEvent(
      {
        operation: "api.readiness",
        status: "failed",
        requestId: context.requestId,
        correlationId: context.correlationId,
        durationMs: elapsedMs(startedAt),
        errorCategory: "configuration",
      },
      logger,
    );

    return jsonResponse(
      { status: "not_ready", categories: ["configuration"] },
      503,
      context,
    );
  }

  if (!constantTimeSecretEqual(readBearerToken(request), secret)) {
    logOperationalEvent(
      {
        operation: "api.readiness",
        status: "failed",
        requestId: context.requestId,
        correlationId: context.correlationId,
        durationMs: elapsedMs(startedAt),
        errorCategory: "authentication",
      },
      logger,
    );

    return jsonResponse(
      { status: "unauthorized" },
      401,
      context,
      { "WWW-Authenticate": "Bearer" },
    );
  }

  const result = await runReadinessChecks(
    options.checks ?? getDefaultReadinessChecks(),
    options.timeoutMs,
  );
  const failedChecks = result.checks.filter((check) => check.status === "failed");

  logOperationalEvent(
    {
      operation: "api.readiness",
      status: result.status === "ready" ? "succeeded" : "failed",
      requestId: context.requestId,
      correlationId: context.correlationId,
      durationMs: elapsedMs(startedAt),
      errorCategory: failedChecks[0]?.status === "failed"
        ? failedChecks[0].category
        : undefined,
      details: {
        checkCount: result.checks.length,
        failedCheckCount: failedChecks.length,
      },
    },
    logger,
  );

  return jsonResponse(
    result,
    result.status === "ready" ? 200 : 503,
    context,
  );
}

export async function runReadinessChecks(
  checks: readonly ReadinessCheck[] = getDefaultReadinessChecks(),
  timeoutMs = READINESS_CHECK_TIMEOUT_MS,
): Promise<ReadinessResult> {
  const boundedTimeoutMs = normalizeTimeoutMs(timeoutMs);
  const results = await Promise.all(
    checks.map(async (check): Promise<ReadinessCheckResult> => {
      try {
        await runWithTimeout(check.run, boundedTimeoutMs);
        return { name: check.name, status: "ok" };
      } catch (error) {
        return {
          name: check.name,
          status: "failed",
          category: classifyOperationalError(error, check.category ?? "dependency"),
        };
      }
    }),
  );

  return {
    status: results.every((result) => result.status === "ok") ? "ready" : "not_ready",
    checks: results,
  };
}

export function getDefaultReadinessChecks(): ReadinessCheck[] {
  return [
    {
      name: "database",
      category: "database",
      run: checkDatabaseReadiness,
    },
    {
      name: "storage",
      category: "storage",
      run: checkStorageReadiness,
    },
    {
      name: "provider",
      category: "provider",
      run: checkProviderReadiness,
    },
    {
      name: "inngest",
      category: "background",
      run: checkInngestReadiness,
    },
  ];
}

export async function checkDatabaseReadiness(): Promise<void> {
  await getPrisma().$queryRaw`SELECT 1`;
}

export async function checkStorageReadiness(): Promise<void> {
  const setup = resolveS3SourceObjectStorage();

  if (setup.status !== "ready") {
    throw new ReadinessProbeError("configuration", "Source storage is not configured.");
  }

  try {
    await setup.storage.headObject({ key: READINESS_STORAGE_PROBE_KEY });
  } catch (error) {
    if (!isMissingStorageObjectError(error)) {
      throw error;
    }
  }
}

export function checkProviderReadiness(): void {
  const env = getGeminiEnv();
  resolveGeminiRuntimeConfig(env);
}

export function checkInngestReadiness(): void {
  const status = getInngestEnvStatus();

  if (status.status !== "ready") {
    throw new ReadinessProbeError("configuration", "Inngest is not configured.");
  }
}

export function isMissingStorageObjectError(error: unknown): boolean {
  if (error instanceof Error && ["NotFound", "NoSuchKey", "NotFoundError"].includes(error.name)) {
    return true;
  }

  if (!isRecord(error)) {
    return false;
  }

  const metadata = isRecord(error.$metadata) ? error.$metadata : null;
  return metadata?.httpStatusCode === 404 || error.statusCode === 404;
}

function readBearerToken(request: Pick<Request, "headers">): string | null {
  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer[ \t]+(.+)$/i);
  const token = match?.[1].trim();

  return token || null;
}

function jsonResponse(
  body: unknown,
  status: number,
  context: { requestId: string; correlationId: string },
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Type": "application/json; charset=utf-8",
      "X-Correlation-ID": context.correlationId,
      "X-Request-ID": context.requestId,
      ...extraHeaders,
    },
  });
}

async function runWithTimeout(
  run: () => void | Promise<void>,
  timeoutMs: number,
): Promise<void> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const operation = Promise.resolve().then(run);
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new ReadinessProbeError("timeout", "Readiness check timed out."));
    }, timeoutMs);
  });

  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function normalizeTimeoutMs(value: number): number {
  return Number.isFinite(value) && value > 0
    ? Math.max(1, Math.floor(value))
    : READINESS_CHECK_TIMEOUT_MS;
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
