import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  formatEnvError,
  getActiveEnv,
  getClerkEnv,
  getDatabaseEnv,
  getGeminiEnv,
  getProductionEnv,
  getQwenEnv,
  getResendEnv,
  getS3Env,
  hasActiveEnv,
  hasClerkEnv,
  hasDatabaseEnv,
  hasGeminiEnv,
  hasProductionEnv,
  hasQwenEnv,
  hasResendEnv,
  hasS3Env,
  shouldCheckProductionEnv,
} from "@/lib/env";

const managedEnvKeys = [
  "DATABASE_URL",
  "DIRECT_URL",
  "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "CLERK_SECRET_KEY",
  "CLERK_WEBHOOK_SECRET",
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "GEMINI_FALLBACK_MODELS",
  "QWEN_API_KEY",
  "QWEN_MODEL",
  "QWEN_BASE_URL",
  "RESEND_API_KEY",
  "RESEND_FROM_EMAIL",
  "NEXT_PUBLIC_APP_URL",
  "AWS_REGION",
  "S3_BUCKET_NAME",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "INNGEST_APP_ID",
  "INNGEST_DEV",
  "INNGEST_EVENT_KEY",
  "INNGEST_SIGNING_KEY",
  "ALPHA_ALLOWED_EMAILS",
  "ALPHA_ALLOWED_DOMAINS",
  "LEARNRECUR_STRICT_ENV",
  "VERCEL_ENV",
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

  it("validates Gemini only when activation asks for Gemini configuration", () => {
    resetManagedEnv({
      DATABASE_URL: "postgresql://runtime:secret@example-pooler.aws.neon.tech/neondb?sslmode=require",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
      CLERK_SECRET_KEY: "sk_test_example",
      GEMINI_API_KEY: " gemini-secret ",
      GEMINI_MODEL: "",
    });

    expect(hasActiveEnv()).toBe(true);
    expect(hasGeminiEnv()).toBe(true);
    expect(getGeminiEnv()).toEqual({
      GEMINI_API_KEY: "gemini-secret",
      GEMINI_MODEL: "gemini-3.5-flash",
      GEMINI_FALLBACK_MODELS: [],
    });
    expect(hasQwenEnv()).toBe(false);
    expect(getQwenEnv()).toEqual({
      QWEN_API_KEY: undefined,
      QWEN_BASE_URL: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
      QWEN_MODEL: "qwen3.7-plus",
    });

    resetManagedEnv({
      DATABASE_URL: "postgresql://runtime:secret@example-pooler.aws.neon.tech/neondb?sslmode=require",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
      CLERK_SECRET_KEY: "sk_test_example",
    });

    expect(hasActiveEnv()).toBe(true);
    expect(hasGeminiEnv()).toBe(false);
    expect(() => getGeminiEnv()).toThrow(/GEMINI_API_KEY is required/);
  });

  it("validates Resend only when reminder sending asks for email configuration", () => {
    resetManagedEnv({
      DATABASE_URL: "postgresql://runtime:secret@example-pooler.aws.neon.tech/neondb?sslmode=require",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
      CLERK_SECRET_KEY: "sk_test_example",
      RESEND_API_KEY: " re_example ",
      RESEND_FROM_EMAIL: " LearnRecur <reminders@example.com> ",
      NEXT_PUBLIC_APP_URL: " http://localhost:3000 ",
    });

    expect(hasActiveEnv()).toBe(true);
    expect(hasResendEnv()).toBe(true);
    expect(getResendEnv()).toEqual({
      RESEND_API_KEY: "re_example",
      RESEND_FROM_EMAIL: "LearnRecur <reminders@example.com>",
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    });

    resetManagedEnv({
      RESEND_API_KEY: "not-a-resend-key",
      RESEND_FROM_EMAIL: "LearnRecur reminders",
      NEXT_PUBLIC_APP_URL: "wat",
    });

    expect(hasResendEnv()).toBe(false);
    expect(() => getResendEnv()).toThrow(/RESEND_API_KEY must start with re_/);
    expect(() => getResendEnv()).toThrow(
      /RESEND_FROM_EMAIL must contain a valid email address/,
    );
    expect(() => getResendEnv()).toThrow(/NEXT_PUBLIC_APP_URL must be a valid URL/);
  });

  it("validates S3 only when source upload storage asks for S3 configuration", () => {
    resetManagedEnv({
      AWS_REGION: " us-east-1 ",
      S3_BUCKET_NAME: " learnrecur-prod-source-uploads ",
      AWS_ACCESS_KEY_ID: " prod-access-key ",
      AWS_SECRET_ACCESS_KEY: " prod-secret ",
    });

    expect(hasS3Env()).toBe(true);
    expect(getS3Env()).toEqual({
      AWS_REGION: "us-east-1",
      S3_BUCKET_NAME: "learnrecur-prod-source-uploads",
      AWS_ACCESS_KEY_ID: "prod-access-key",
      AWS_SECRET_ACCESS_KEY: "prod-secret",
    });
  });

  it("validates the full production deployment environment", () => {
    resetManagedEnv({
      NEXT_PUBLIC_APP_URL: " https://app.learnrecur.com ",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: " pk_live_example ",
      CLERK_SECRET_KEY: " sk_live_example ",
      DATABASE_URL: "postgresql://runtime:secret@example-pooler.aws.neon.tech/neondb?sslmode=require",
      DIRECT_URL: "postgresql://migrate:secret@example.aws.neon.tech/neondb?sslmode=require",
      GEMINI_API_KEY: "gemini-secret",
      GEMINI_MODEL: "gemini-3.5-flash",
      QWEN_API_KEY: "qwen-secret",
      QWEN_MODEL: "qwen3.7-plus",
      AWS_REGION: "us-east-1",
      S3_BUCKET_NAME: "learnrecur-prod-source-uploads",
      AWS_ACCESS_KEY_ID: "prod-access-key",
      AWS_SECRET_ACCESS_KEY: "prod-secret",
      INNGEST_APP_ID: "learnrecur",
      INNGEST_DEV: "0",
      INNGEST_EVENT_KEY: "inngest-event-key",
      INNGEST_SIGNING_KEY: "inngest-signing-key",
      RESEND_API_KEY: "re_example",
      RESEND_FROM_EMAIL: "LearnRecur <practice@app.learnrecur.com>",
      ALPHA_ALLOWED_EMAILS: "founder@app.learnrecur.com",
    });

    expect(hasProductionEnv()).toBe(true);
    expect(getProductionEnv()).toMatchObject({
      NEXT_PUBLIC_APP_URL: "https://app.learnrecur.com",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_example",
      CLERK_SECRET_KEY: "sk_live_example",
      DATABASE_URL: "postgresql://runtime:secret@example-pooler.aws.neon.tech/neondb?sslmode=require",
      DIRECT_URL: "postgresql://migrate:secret@example.aws.neon.tech/neondb?sslmode=require",
      QWEN_API_KEY: "qwen-secret",
      QWEN_MODEL: "qwen3.7-plus",
      QWEN_BASE_URL: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
      INNGEST_APP_ID: "learnrecur",
      INNGEST_DEV: "0",
    });
  });

  it("does not require Qwen for production Gemini-only deployments", () => {
    resetManagedEnv({
      NEXT_PUBLIC_APP_URL: " https://app.learnrecur.com ",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: " pk_live_example ",
      CLERK_SECRET_KEY: " sk_live_example ",
      DATABASE_URL: "postgresql://runtime:secret@example-pooler.aws.neon.tech/neondb?sslmode=require",
      DIRECT_URL: "postgresql://migrate:secret@example.aws.neon.tech/neondb?sslmode=require",
      GEMINI_API_KEY: "gemini-secret",
      GEMINI_MODEL: "gemini-3.5-flash",
      AWS_REGION: "us-east-1",
      S3_BUCKET_NAME: "learnrecur-prod-source-uploads",
      AWS_ACCESS_KEY_ID: "prod-access-key",
      AWS_SECRET_ACCESS_KEY: "prod-secret",
      INNGEST_APP_ID: "learnrecur",
      INNGEST_DEV: "0",
      INNGEST_EVENT_KEY: "inngest-event-key",
      INNGEST_SIGNING_KEY: "inngest-signing-key",
      RESEND_API_KEY: "re_example",
      RESEND_FROM_EMAIL: "LearnRecur <practice@app.learnrecur.com>",
      ALPHA_ALLOWED_DOMAINS: "app.learnrecur.com",
    });

    expect(hasProductionEnv()).toBe(true);
    const productionEnv = getProductionEnv();
    expect(productionEnv).not.toHaveProperty("QWEN_API_KEY");
    expect(productionEnv).toMatchObject({
      QWEN_MODEL: "qwen3.7-plus",
      QWEN_BASE_URL: "https://dashscope-us.aliyuncs.com/compatible-mode/v1",
    });
  });

  it("rejects unsafe production deployment configuration", () => {
    resetManagedEnv({
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
      CLERK_SECRET_KEY: "sk_test_example",
      DATABASE_URL: "postgresql://runtime:secret@example-pooler.aws.neon.tech/neondb?sslmode=require",
      DIRECT_URL: "",
      GEMINI_API_KEY: "gemini-secret",
      QWEN_API_KEY: "qwen-secret",
      AWS_REGION: "us-east-1",
      S3_BUCKET_NAME: "learnrecur-prod-source-uploads",
      AWS_ACCESS_KEY_ID: "prod-access-key",
      AWS_SECRET_ACCESS_KEY: "prod-secret",
      INNGEST_APP_ID: "learnrecur-dev",
      INNGEST_DEV: "1",
      INNGEST_EVENT_KEY: "inngest-event-key",
      INNGEST_SIGNING_KEY: "inngest-signing-key",
      RESEND_API_KEY: "re_example",
      RESEND_FROM_EMAIL: "LearnRecur <practice@app.learnrecur.com>",
    });

    expect(hasProductionEnv()).toBe(false);
    expect(() => getProductionEnv()).toThrow(/NEXT_PUBLIC_APP_URL must use https:\/\//);
    expect(() => getProductionEnv()).toThrow(/NEXT_PUBLIC_APP_URL must not point at localhost/);
    expect(() => getProductionEnv()).toThrow(/pk_live_/);
    expect(() => getProductionEnv()).toThrow(/sk_live_/);
    expect(() => getProductionEnv()).toThrow(/DIRECT_URL is required/);
    expect(() => getProductionEnv()).toThrow(/INNGEST_APP_ID must not be learnrecur-dev/);
    expect(() => getProductionEnv()).toThrow(/INNGEST_DEV must be absent or false/);
    expect(() => getProductionEnv()).toThrow(/ALPHA_ALLOWED_EMAILS or ALPHA_ALLOWED_DOMAINS/);
  });

  it("requires a production alpha access allowlist", () => {
    resetManagedEnv({
      NEXT_PUBLIC_APP_URL: " https://app.learnrecur.com ",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: " pk_live_example ",
      CLERK_SECRET_KEY: " sk_live_example ",
      DATABASE_URL: "postgresql://runtime:secret@example-pooler.aws.neon.tech/neondb?sslmode=require",
      DIRECT_URL: "postgresql://migrate:secret@example.aws.neon.tech/neondb?sslmode=require",
      GEMINI_API_KEY: "gemini-secret",
      AWS_REGION: "us-east-1",
      S3_BUCKET_NAME: "learnrecur-prod-source-uploads",
      AWS_ACCESS_KEY_ID: "prod-access-key",
      AWS_SECRET_ACCESS_KEY: "prod-secret",
      INNGEST_APP_ID: "learnrecur",
      INNGEST_DEV: "0",
      INNGEST_EVENT_KEY: "inngest-event-key",
      INNGEST_SIGNING_KEY: "inngest-signing-key",
      RESEND_API_KEY: "re_example",
      RESEND_FROM_EMAIL: "LearnRecur <practice@app.learnrecur.com>",
    });

    expect(hasProductionEnv()).toBe(false);
    expect(() => getProductionEnv()).toThrow(/ALPHA_ALLOWED_EMAILS or ALPHA_ALLOWED_DOMAINS/);
  });

  it("formats missing production environment variables by name", () => {
    resetManagedEnv({
      VERCEL_ENV: "production",
    });

    try {
      getProductionEnv();
      throw new Error("Expected production env validation to fail.");
    } catch (error) {
      const message = formatEnvError(error);

      expect(message).toContain("DATABASE_URL is required");
      expect(message).toContain("DIRECT_URL is required");
      expect(message).toContain("NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY is required");
      expect(message).toContain("CLERK_SECRET_KEY is required");
      expect(message).not.toContain("Invalid input: expected string, received undefined");
    }

    const zodError = new z.ZodError([
      {
        code: "invalid_type",
        expected: "string",
        input: undefined,
        path: ["DIRECT_URL"],
        message: "zod changed this default message",
      },
    ]);

    expect(formatEnvError(zodError)).toBe("DIRECT_URL is required");
  });

  it("rejects unexpected INNGEST_DEV values in production", () => {
    resetManagedEnv({
      NEXT_PUBLIC_APP_URL: "https://app.learnrecur.com",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_live_example",
      CLERK_SECRET_KEY: "sk_live_example",
      DATABASE_URL: "postgresql://runtime:secret@example-pooler.aws.neon.tech/neondb?sslmode=require",
      DIRECT_URL: "postgresql://migrate:secret@example.aws.neon.tech/neondb?sslmode=require",
      GEMINI_API_KEY: "gemini-secret",
      QWEN_API_KEY: "qwen-secret",
      AWS_REGION: "us-east-1",
      S3_BUCKET_NAME: "learnrecur-prod-source-uploads",
      AWS_ACCESS_KEY_ID: "prod-access-key",
      AWS_SECRET_ACCESS_KEY: "prod-secret",
      INNGEST_APP_ID: "learnrecur",
      INNGEST_DEV: "banana",
      INNGEST_EVENT_KEY: "inngest-event-key",
      INNGEST_SIGNING_KEY: "inngest-signing-key",
      RESEND_API_KEY: "re_example",
      RESEND_FROM_EMAIL: "LearnRecur <practice@app.learnrecur.com>",
      ALPHA_ALLOWED_DOMAINS: "app.learnrecur.com",
    });

    expect(hasProductionEnv()).toBe(false);
    expect(() => getProductionEnv()).toThrow(/INNGEST_DEV must be absent or false/);
  });

  it("requires an app URL outside local development", () => {
    resetManagedEnv({
      RESEND_API_KEY: "re_example",
      RESEND_FROM_EMAIL: "LearnRecur <reminders@example.com>",
    });

    expect(hasResendEnv()).toBe(false);
    expect(() => getResendEnv()).toThrow(/NEXT_PUBLIC_APP_URL is required/);

    process.env.NODE_ENV = "development";

    expect(getResendEnv()).toMatchObject({
      NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    });
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

  it("runs strict production checks only for explicit strict or Vercel production contexts", () => {
    expect(shouldCheckProductionEnv({})).toBe(false);
    expect(shouldCheckProductionEnv({ VERCEL_ENV: "preview" })).toBe(false);
    expect(shouldCheckProductionEnv({ VERCEL_ENV: "production" })).toBe(true);
    expect(shouldCheckProductionEnv({ LEARNRECUR_STRICT_ENV: "1" })).toBe(true);
  });
});
