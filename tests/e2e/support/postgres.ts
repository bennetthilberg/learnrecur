import { Pool } from "pg";
import { getPostgresPoolConfig } from "../../../src/lib/postgres-config";

const pools = new Map<string, Pool>();

/** Share bounded pools; return rows like the fixtures expect. */
export function getTestPostgres(connectionString: string) {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new Pool({ ...getPostgresPoolConfig(connectionString), max: 1, allowExitOnIdle: true });
    pools.set(connectionString, pool);
  }
  const client = pool;
  return {
    async query(text: string, values: unknown[] = []) {
      return (await client.query(text, values)).rows;
    },
  };
}
