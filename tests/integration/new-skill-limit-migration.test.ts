import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/prisma";

const suite = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
suite("daily allowance migration", () => {
  const prisma = getPrisma();
  afterAll(() => prisma.$disconnect());
  it("backfills earliest owned review evidence while preserving schedules and unlimited defaults", async () => {
    const migration = await readFile(
      new URL(
        "../../prisma/migrations/20260907220000_daily_new_skill_limit/migration.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await prisma.$transaction(
      async (tx) => {
        // Temporary tables shadow these names only on this transaction's connection.
        // Exercise the shipped SQL without altering the shared integration schema.
        await tx.$executeRawUnsafe(
          "CREATE TEMP TABLE users (id TEXT PRIMARY KEY) ON COMMIT DROP",
        );
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE skills (id TEXT PRIMARY KEY, "userId" TEXT, "lastReviewedAt" TIMESTAMP(3), repetitions INTEGER, stability DOUBLE PRECISION) ON COMMIT DROP',
        );
        await tx.$executeRawUnsafe(
          'CREATE TEMP TABLE review_logs ("skillId" TEXT, "userId" TEXT, "reviewedAt" TIMESTAMP(3)) ON COMMIT DROP',
        );
        await tx.$executeRawUnsafe("INSERT INTO users VALUES ('learner')");
        await tx.$executeRawUnsafe(
          `INSERT INTO skills VALUES ('reviewed', 'learner', '2026-09-07', 3, 12.5), ('legacy', 'learner', '2026-08-01', 2, 5.0), ('fresh', 'learner', NULL, 0, 0)`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO review_logs VALUES ('reviewed', 'learner', '2026-09-07'), ('reviewed', 'learner', '2026-09-01'), ('reviewed', 'other', '2026-01-01')`,
        );
        const before = await tx.$queryRawUnsafe(
          'SELECT id, "lastReviewedAt", repetitions, stability FROM skills ORDER BY id',
        );
        for (const statement of migration
          .replace(/^--.*$/gm, "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean))
          await tx.$executeRawUnsafe(statement);
        expect(
          await tx.$queryRawUnsafe(
            'SELECT id, "lastReviewedAt", repetitions, stability FROM skills ORDER BY id',
          ),
        ).toEqual(before);
        expect(
          await tx.$queryRawUnsafe(
            'SELECT id, "firstIntroducedAt" FROM skills ORDER BY id',
          ),
        ).toEqual([
          { id: "fresh", firstIntroducedAt: null },
          { id: "legacy", firstIntroducedAt: new Date("2026-08-01T00:00:00Z") },
          {
            id: "reviewed",
            firstIntroducedAt: new Date("2026-09-01T00:00:00Z"),
          },
        ]);
        expect(await tx.$queryRawUnsafe("SELECT * FROM users")).toEqual([
          { id: "learner", dailyNewSkillLimit: null, practiceTimezone: "UTC" },
        ]);
        expect(
          await tx.$queryRawUnsafe(
            "SELECT COUNT(*)::int AS count FROM review_logs",
          ),
        ).toEqual([{ count: 3 }]);
      },
      { timeout: 15_000 },
    );
  });
});
