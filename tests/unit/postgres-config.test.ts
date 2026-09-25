import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPostgresPoolConfig } from "@/lib/postgres-config";

describe("PostgreSQL connection security", () => {
  beforeEach(() => vi.stubEnv("DATABASE_POOL_MAX", undefined));
  afterEach(() => vi.unstubAllEnvs());
  it("verifies Heroku certificates with the regional RDS trust bundle", () => {
    const config = getPostgresPoolConfig("postgres://db.cluster.us-east-1.rds.amazonaws.com/app?sslmode=require");
    expect(config.ssl).toMatchObject({ rejectUnauthorized: true, ca: expect.stringContaining("BEGIN CERTIFICATE") });
  });
  it.each(["0", "6", "1.5", "invalid"])("rejects invalid pool size %s", (max) => {
    vi.stubEnv("DATABASE_POOL_MAX", max);
    expect(() => getPostgresPoolConfig("postgres://localhost/app")).toThrow("DATABASE_POOL_MAX");
  });
  it("bounds pools and keeps certificate verification enabled for remote databases", () => {
    const config = getPostgresPoolConfig("postgres://user:password@db.example.com/db?sslmode=require");
    expect(config.max).toBe(2);
    expect(config.ssl).toEqual({ rejectUnauthorized: true });
    expect(new URL(config.connectionString!).searchParams.has("sslmode")).toBe(false);
  });
  it("gives workers a longer cold connection window without delaying web failures", () => {
    const connectionString = "postgres://user:password@db.example.com/db";
    expect(getPostgresPoolConfig(connectionString).connectionTimeoutMillis).toBe(5_000);
    expect(getPostgresPoolConfig(connectionString, { worker: true }).connectionTimeoutMillis).toBe(20_000);
    expect(getPostgresPoolConfig(connectionString, { worker: true }).max).toBe(2);
  });
  it("allows explicitly unencrypted loopback databases for disposable CI", () => {
    expect(getPostgresPoolConfig("postgres://localhost/test?sslmode=disable").ssl).toBe(false);
  });
  it("rejects disabling encryption on a remote database", () => {
    expect(() => getPostgresPoolConfig("postgres://db.example.com/test?sslmode=disable")).toThrow();
  });
});
