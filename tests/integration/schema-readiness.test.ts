import { afterAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/prisma";
import { checkDatabaseReadiness, REQUIRED_SCHEMA_MIGRATION } from "@/lib/observability/readiness";

const suite = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
suite("database schema readiness", () => {
  const prisma = getPrisma();
  afterAll(() => prisma.$disconnect());

  it("accepts the migrated database", async () => {
    await expect(checkDatabaseReadiness(prisma)).resolves.toBeUndefined();
  });

  it.each(["missing", "unfinished", "rolled-back"])("rejects a %s required migration while SELECT 1 still works", async (state) => {
    const rollback = new Error("rollback readiness fixture");
    await expect(prisma.$transaction(async (tx) => {
      if (state === "missing") await tx.$executeRaw`DELETE FROM "_prisma_migrations" WHERE migration_name = ${REQUIRED_SCHEMA_MIGRATION}`;
      if (state === "unfinished") await tx.$executeRaw`UPDATE "_prisma_migrations" SET finished_at = NULL WHERE migration_name = ${REQUIRED_SCHEMA_MIGRATION}`;
      if (state === "rolled-back") await tx.$executeRaw`UPDATE "_prisma_migrations" SET rolled_back_at = NOW() WHERE migration_name = ${REQUIRED_SCHEMA_MIGRATION}`;
      await expect(tx.$queryRaw`SELECT 1`).resolves.toHaveLength(1);
      await expect(checkDatabaseReadiness(tx)).rejects.toMatchObject({ category: "database" });
      throw rollback;
    })).rejects.toBe(rollback);
    await expect(checkDatabaseReadiness(prisma)).resolves.toBeUndefined();
  });
});
