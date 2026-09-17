import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { getPostgresPoolConfig } from "./postgres-config";

import { getDatabaseEnv } from "./env";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

/** Reuse one Prisma client and its bounded pool per server process. */
export function getPrisma(): PrismaClient {
  if (globalForPrisma.prisma) {
    return globalForPrisma.prisma;
  }

  const { DATABASE_URL } = getDatabaseEnv();

  const adapter = new PrismaPg(getPostgresPoolConfig(DATABASE_URL));
  const prisma = new PrismaClient({
    adapter,
    transactionOptions: {
      // Keep pool wait plus execution below the shortest configured route limit (120s).
      maxWait: 5_000,
      timeout: 15_000,
    },
  });

  // Lambda reuses execution environments; retain the pool across invocations.
  globalForPrisma.prisma = prisma;

  return prisma;
}
