import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ client: vi.fn(), adapter: vi.fn() }));
vi.mock("@/generated/prisma/client", () => ({ PrismaClient: class { constructor(options: unknown) { mocks.client(options); } } }));
vi.mock("@prisma/adapter-pg", () => ({ PrismaPg: class { constructor(options: unknown) { mocks.adapter(options); } } }));
vi.mock("@/lib/env", () => ({ getDatabaseEnv: () => ({ DATABASE_URL: "postgresql://example.test/db" }) }));
import { getPrisma } from "@/lib/prisma";
const cache = globalThis as typeof globalThis & { prisma?: unknown };
afterEach(() => { delete cache.prisma; vi.unstubAllEnvs(); vi.clearAllMocks(); });
it("reuses one bounded PostgreSQL pool across warm production invocations", () => {
  delete cache.prisma;
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("DATABASE_POOL_MAX", undefined);
  const first = getPrisma();
  expect(getPrisma()).toBe(first);
  expect(mocks.client).toHaveBeenCalledOnce();
  expect(mocks.adapter).toHaveBeenCalledWith(expect.objectContaining({
    connectionString: "postgresql://example.test/db", max: 2,
    connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000,
  }));
  expect(mocks.client).toHaveBeenCalledWith(expect.objectContaining({
    transactionOptions: { maxWait: 5_000, timeout: 15_000 },
  }));
});
it("uses the longer connection window in the AWS jobs worker", () => {
  delete cache.prisma;
  vi.stubEnv("JOBS_ENVIRONMENT", "production");
  getPrisma();
  expect(mocks.adapter).toHaveBeenCalledWith(expect.objectContaining({
    connectionTimeoutMillis: 20_000,
    max: 2,
  }));
});
