import type { PoolConfig } from "pg";
import rdsCa from "./rds-us-east-1-ca.json";

/** Heroku Essential uses RDS certificates. Never disable certificate validation. */
export function getPostgresPoolConfig(connectionString: string, options: { worker?: boolean } = {}): PoolConfig {
  const url = new URL(connectionString);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (!local && ["disable", "no-verify"].includes(url.searchParams.get("sslmode") ?? "")) {
    throw new Error("Remote PostgreSQL connections require verified TLS.");
  }
  // pg connection-string SSL options otherwise replace the explicit CA config.
  for (const key of ["ssl", "sslmode", "sslrootcert", "sslcert", "sslkey"]) {
    url.searchParams.delete(key);
  }
  const max = Number(process.env.DATABASE_POOL_MAX ?? 2);
  if (!Number.isInteger(max) || max < 1 || max > 5) {
    throw new Error("DATABASE_POOL_MAX must be an integer from 1 to 5.");
  }
  return {
    connectionString: url.toString(),
    max,
    connectionTimeoutMillis: options.worker ? 20_000 : 5_000,
    idleTimeoutMillis: 10_000,
    ssl: local ? false : {
      rejectUnauthorized: true,
      ...(url.hostname.endsWith(".us-east-1.rds.amazonaws.com") ? { ca: rdsCa } : {}),
    },
  };
}
