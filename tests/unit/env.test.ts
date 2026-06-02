import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  formatEnvError,
  getActiveEnv,
  getClerkEnv,
  getDatabaseEnv,
  hasActiveEnv,
  hasClerkEnv,
  hasDatabaseEnv,
} from "@/lib/env";

const managedEnvKeys = [
  "DATABASE_URL",
  "DIRECT_URL",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "CLERK_WEBHOOK_SECRET",
] as const;

const originalEnv = process.env;

function resetManagedEnv(values: Partial<Record<(typeof managedEnvKeys)[number], string>> = {}) {
  process.env = { ...originalEnv };

  for (const key of managedEnvKeys) {
    delete process.env[key];
  }

  Object.assign(process.env, values);
}

describe("environment validation", () => {
  beforeEach(() => {
    resetManagedEnv();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("accepts the active Clerk and Postgres environment variables we use in this slice", () => {
    resetManagedEnv({
      DATABASE_URL: " postgresql://runtime:secret@example-pooler.aws.neon.tech/neondb?sslmode=require ",
      DIRECT_URL: " postgres://migrate:secret@example.aws.neon.tech/neondb?sslmode=require ",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: " pk_test_example ",
      CLERK_SECRET_KEY: " sk_test_example ",
      CLERK_WEBHOOK_SECRET: " whsec_optional ",
    });

    expect(getActiveEnv()).toEqual({
      DATABASE_URL: "postgresql://runtime:secret@example-pooler.aws.neon.tech/neondb?sslmode=require",
      DIRECT_URL: "postgres://migrate:secret@example.aws.neon.tech/neondb?sslmode=require",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
      CLERK_SECRET_KEY: "sk_test_example",
      CLERK_WEBHOOK_SECRET: "whsec_optional",
    });
    expect(hasActiveEnv()).toBe(true);
  });

  it("treats blank optional variables as absent", () => {
    resetManagedEnv({
      DATABASE_URL: "postgresql://runtime:secret@example-pooler.aws.neon.tech/neondb?sslmode=require",
      DIRECT_URL: " ",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
      CLERK_SECRET_KEY: "sk_test_example",
      CLERK_WEBHOOK_SECRET: "",
    });

    expect(getDatabaseEnv()).toEqual({
      DATABASE_URL: "postgresql://runtime:secret@example-pooler.aws.neon.tech/neondb?sslmode=require",
      DIRECT_URL: undefined,
    });
    expect(getClerkEnv()).toEqual({
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
      CLERK_SECRET_KEY: "sk_test_example",
      CLERK_WEBHOOK_SECRET: undefined,
    });
  });

  it("rejects missing active environment variables without requiring future service keys", () => {
    resetManagedEnv({
      DATABASE_URL: "postgresql://runtime:secret@example-pooler.aws.neon.tech/neondb?sslmode=require",
    });

    expect(hasDatabaseEnv()).toBe(true);
    expect(hasClerkEnv()).toBe(false);
    expect(hasActiveEnv()).toBe(false);
    expect(() => getActiveEnv()).toThrow(/NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY/);
    expect(() => getActiveEnv()).toThrow(/CLERK_SECRET_KEY/);
  });

  it("rejects non-Postgres database URLs", () => {
    resetManagedEnv({
      DATABASE_URL: "https://example.com/database",
      DIRECT_URL: "mysql://example.com/database",
    });

    expect(hasDatabaseEnv()).toBe(false);
    expect(() => getDatabaseEnv()).toThrow(/DATABASE_URL must be a postgres:\/\/ or postgresql:\/\/ URL/);
    expect(() => getDatabaseEnv()).toThrow(/DIRECT_URL must be a postgres:\/\/ or postgresql:\/\/ URL/);
  });

  it("rejects Clerk keys that are accidentally swapped or malformed", () => {
    resetManagedEnv({
      DATABASE_URL: "postgresql://runtime:secret@example-pooler.aws.neon.tech/neondb?sslmode=require",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "sk_test_wrong_side",
      CLERK_SECRET_KEY: "pk_test_wrong_side",
    });

    expect(hasClerkEnv()).toBe(false);
    expect(() => getClerkEnv()).toThrow(/NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY must start with pk_/);
    expect(() => getClerkEnv()).toThrow(/CLERK_SECRET_KEY must start with sk_/);
  });

  it("formats Zod, Error, and unknown errors for dashboard-safe display", () => {
    const zodError = new z.ZodError([
      {
        code: "custom",
        path: ["DATABASE_URL"],
        message: "database went sideways",
        input: undefined,
      },
    ]);

    expect(formatEnvError(zodError)).toBe("database went sideways");
    expect(formatEnvError(new Error("plain error"))).toBe("plain error");
    expect(formatEnvError("wat")).toBe("Missing or invalid environment configuration.");
  });
});
