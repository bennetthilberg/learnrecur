import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";

export async function deleteDatabaseTestUsers(userIds: string[]) {
  if (userIds.length === 0) {
    return;
  }

  const sql = getTestSql();
  await sql.query('DELETE FROM "users" WHERE "id" = ANY($1::text[])', [userIds]);
}

export async function createPrivateSkillFixture(input: {
  email: string;
  runId: string;
  userId: string;
}) {
  const sql = getTestSql();
  const now = new Date();
  const skillId = `e2e_${randomUUID().replaceAll("-", "")}`;

  await sql.query(
    `INSERT INTO "users" ("id", "email", "name", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT ("id") DO UPDATE SET "email" = EXCLUDED."email", "name" = EXCLUDED."name", "updatedAt" = EXCLUDED."updatedAt"`,
    [input.userId, input.email, "Other E2E learner", now],
  );
  await sql.query(
    `INSERT INTO "skills" ("id", "userId", "title", "objective", "tags", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5::text[], $6, $6)`,
    [
      skillId,
      input.userId,
      `Private E2E skill ${input.runId}`,
      "A private skill owned by another test learner.",
      [],
      now,
    ],
  );

  return skillId;
}

function getTestSql() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Authenticated E2E database helpers require DATABASE_URL.");
  }
  return neon(connectionString);
}
