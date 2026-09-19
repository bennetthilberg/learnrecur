import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { config as loadEnv } from "dotenv";

import rdsCa from "../src/lib/rds-us-east-1-ca.json";
import { buildMigrationConnectionUrl } from "./lib/release-commands";

async function main() {
  loadEnv({ path: ".env.local", quiet: true });
  loadEnv({ path: ".env", quiet: true });

  const connectionUrl = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!connectionUrl) {
    throw new Error("DIRECT_URL or DATABASE_URL is required to deploy migrations.");
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "learnrecur-prisma-"));
  const rootCertificatePath = join(temporaryDirectory, "rds-us-east-1-ca.pem");

  try {
    await writeFile(rootCertificatePath, rdsCa, { mode: 0o600 });
    const migrationUrl = buildMigrationConnectionUrl(connectionUrl, rootCertificatePath);
    const targetHost = new URL(migrationUrl).hostname;

    console.log(`[database-migration] applying tracked migrations to ${targetHost}`);
    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["exec", "--", "prisma", "migrate", "deploy"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DIRECT_URL: migrationUrl,
        },
        stdio: "inherit",
      },
    );

    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`Prisma migrate deploy exited with status ${result.status ?? "unknown"}.`);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[database-migration] failed: ${message}`);
  process.exitCode = 1;
});
