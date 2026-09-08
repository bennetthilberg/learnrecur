import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";

const MAX_SERIALIZABLE_RETRIES = 8;

type SerializableOptions = {
  retryUniqueConstraint?: boolean;
  timeout?: number;
};

/**
 * Prisma's PostgreSQL adapter can surface a serialization failure as P2034 or
 * as a raw-query P2010. Only the SQLSTATEs and adapter conflict kinds below
 * are safe to retry. Other P2010 errors may describe a real query or provider
 * failure and must reach the caller unchanged.
 */
export function isAgentSerializationConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  if (error.code !== "P2010" || !error.meta || typeof error.meta !== "object") {
    return false;
  }

  const sqlState = "code" in error.meta ? error.meta.code : undefined;
  if (sqlState === "40001" || sqlState === "40P01") return true;

  const adapter = "driverAdapterError" in error.meta
    ? error.meta.driverAdapterError
    : undefined;
  if (!adapter || typeof adapter !== "object") return false;
  const cause = "cause" in adapter ? adapter.cause : undefined;
  if (!cause || typeof cause !== "object") return false;

  const originalCode = "originalCode" in cause
    ? cause.originalCode
    : "code" in cause
      ? cause.code
      : undefined;
  const kind = "kind" in cause ? cause.kind : undefined;
  return (
    kind === "TransactionWriteConflict" ||
    originalCode === "40001" ||
    originalCode === "40P01"
  );
}

function isAgentRetryableDatabaseError(
  error: unknown,
  options: SerializableOptions,
): boolean {
  if (isAgentSerializationConflict(error)) return true;
  return (
    options.retryUniqueConstraint === true &&
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/**
 * Run a database-only transaction with a bounded retry budget. The callback
 * is rerun from the beginning, so callers must perform fresh authorization
 * checks inside it before any write or rate-limit charge.
 */
export async function runAgentSerializable<T>(
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  options: SerializableOptions = {},
): Promise<T> {
  const prisma = getPrisma();
  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_SERIALIZABLE_RETRIES; attempt += 1) {
    try {
      return await prisma.$transaction(work, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
      });
    } catch (error) {
      lastError = error;
      if (
        !isAgentRetryableDatabaseError(error, options) ||
        attempt === MAX_SERIALIZABLE_RETRIES - 1
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 10));
    }
  }
  throw lastError;
}
