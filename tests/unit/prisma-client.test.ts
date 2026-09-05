import { afterEach, expect, it, vi } from "vitest";
const constructed = vi.hoisted(() => vi.fn());
vi.mock("@/generated/prisma/client", () => ({ PrismaClient: class { constructor() { constructed(); } } }));
vi.mock("@prisma/adapter-neon", () => ({ PrismaNeon: class {} }));
vi.mock("@/lib/env", () => ({ getDatabaseEnv: () => ({ DATABASE_URL: "postgresql://example.test/db" }) }));
import { getPrisma } from "@/lib/prisma";
const cache = globalThis as typeof globalThis & { prisma?: unknown };
afterEach(() => { delete cache.prisma; vi.unstubAllEnvs(); constructed.mockClear(); });
it("reuses one database client across warm production invocations", () => {
  delete cache.prisma;
  vi.stubEnv("NODE_ENV", "production");
  const first = getPrisma();
  expect(getPrisma()).toBe(first);
  expect(constructed).toHaveBeenCalledOnce();
});
