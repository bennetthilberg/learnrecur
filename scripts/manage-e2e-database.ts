import { neon } from "@neondatabase/serverless";
import { config as loadEnv } from "dotenv";
import { appendFile } from "node:fs/promises";

import {
  assertManagedE2EDatabaseName,
  isManagedE2EDatabaseName,
  withDatabase,
} from "../tests/e2e/support/database-schema";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

const command = process.argv[2];
const database = process.env.E2E_DATABASE_NAME ?? "";
const adminUrl = process.env.E2E_DIRECT_URL;

void main();

async function main() {
  if (command !== "prepare" && command !== "cleanup") {
    throw new Error("Usage: tsx scripts/manage-e2e-database.ts <prepare|cleanup>");
  }

  assertManagedE2EDatabaseName(database);
  if (!adminUrl) {
    throw new Error("E2E_DIRECT_URL is required to manage the isolated test schema.");
  }

  if (command === "prepare") {
    await prepareDatabase();
  } else {
    await dropDatabase(database);
  }
}

async function prepareDatabase() {
  const baseDatabaseUrl = process.env.E2E_DATABASE_URL;
  const baseDirectUrl = process.env.E2E_DIRECT_URL;
  const githubEnvPath = process.env.GITHUB_ENV;
  if (!baseDatabaseUrl || !baseDirectUrl || !githubEnvPath) {
    throw new Error(
      "Preparing the E2E database requires E2E_DATABASE_URL, E2E_DIRECT_URL, and GITHUB_ENV.",
    );
  }

  const sql = getAdminSql();
  const existing = await sql.query(
    "SELECT datname FROM pg_database WHERE left(datname, 4) = 'e2e_'",
    [],
  );
  for (const row of existing as Array<{ datname: string }>) {
    if (isManagedE2EDatabaseName(row.datname)) {
      await dropDatabase(row.datname);
    }
  }

  await sql.query(`CREATE DATABASE "${database}"`, []);

  const databaseUrl = withDatabase(baseDatabaseUrl, database);
  const directUrl = withDatabase(baseDirectUrl, database);
  maskSecret(databaseUrl);
  maskSecret(directUrl);
  await appendFile(
    githubEnvPath,
    `DATABASE_URL=${databaseUrl}\nDIRECT_URL=${directUrl}\n`,
    { mode: 0o600 },
  );
}

async function dropDatabase(target: string) {
  assertManagedE2EDatabaseName(target);
  const sql = getAdminSql();
  await sql.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`, []);
}

function getAdminSql() {
  if (!adminUrl) {
    throw new Error("E2E_DIRECT_URL is required to manage the isolated test schema.");
  }
  return neon(adminUrl);
}

function maskSecret(value: string) {
  if (process.env.GITHUB_ACTIONS === "true") {
    process.stdout.write(`::add-mask::${value}\n`);
  }
}
