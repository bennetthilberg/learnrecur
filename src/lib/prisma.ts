import { neonConfig } from "@neondatabase/serverless";
import { PrismaNeon } from "@prisma/adapter-neon";
import { PrismaClient } from "@/generated/prisma/client";
import ws from "ws";

import { getDatabaseEnv } from "./env";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export function getPrisma(): PrismaClient {
  if (globalForPrisma.prisma) {
    return globalForPrisma.prisma;
  }

  const { DATABASE_URL } = getDatabaseEnv();

  neonConfig.webSocketConstructor = ws;

  const adapter = new PrismaNeon({ connectionString: DATABASE_URL });
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
