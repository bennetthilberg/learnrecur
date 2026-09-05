import { afterEach, describe, expect, it, vi } from "vitest";
const pages = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-ssm", () => ({ SSMClient: class { destroy() {} }, paginateGetParametersByPath: pages }));
import { loadWorkerEnvironment, selectWorkerEnvironment, WORKER_ENV_KEYS } from "@/lib/jobs/environment";
import { getJobsConfig } from "@/lib/jobs/config";
const config = getJobsConfig({ AWS_REGION: "us-east-1", JOBS_ENVIRONMENT: "staging", JOBS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/learnrecur-staging-jobs.fifo" });
const required = ["DATABASE_URL", "S3_BUCKET_NAME", "CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "NEXT_PUBLIC_APP_URL", "RESEND_API_KEY", "RESEND_FROM_EMAIL", "GEMINI_API_KEY"];
const params = () => required.map((key) => ({ Name: `/learnrecur/staging/jobs/${key}`, Type: "SecureString", Value: `fixture-${key}` }));
afterEach(() => vi.unstubAllEnvs());

describe("Lambda environment loading", () => {
  it("does not accept Vercel's unreadable-secret placeholders as deployable configuration", () => {
    const values = Object.fromEntries(params().map((parameter) => [parameter.Name.split("/").at(-1)!, parameter.Value]));
    expect(() => selectWorkerEnvironment({ ...values, DATABASE_URL: "[SENSITIVE]" })).toThrow("JOB_ENVIRONMENT_INCOMPLETE");
    expect(selectWorkerEnvironment({ ...values, AWS_SECRET_ACCESS_KEY: "never-copy" })).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  });
  it("loads paginated secrets from only its own environment", async () => {
    for (const key of WORKER_ENV_KEYS) vi.stubEnv(key, undefined);
    pages.mockImplementation(async function* () { yield { Parameters: params().slice(0, 3) }; yield { Parameters: params().slice(3) }; });
    await loadWorkerEnvironment(config);
    expect(pages).toHaveBeenCalledWith(expect.anything(), { Path: "/learnrecur/staging/jobs/", Recursive: false, WithDecryption: true });
    expect(process.env.DATABASE_URL).toBe("fixture-DATABASE_URL");
  });

  it("pins each cold start to the complete configuration revision deployed with its code", async () => {
    vi.stubEnv("JOBS_CONFIG_REVISION", "release-123");
    for (const key of WORKER_ENV_KEYS) vi.stubEnv(key, undefined);
    pages.mockImplementation(async function* () { yield { Parameters: params().map((parameter) => ({ ...parameter, Name: parameter.Name.replace("/jobs/", "/jobs/release-123/") })) }; });
    await loadWorkerEnvironment(config);
    expect(pages).toHaveBeenCalledWith(expect.anything(), { Path: "/learnrecur/staging/jobs/release-123/", Recursive: false, WithDecryption: true });
  });

  it("rejects path traversal in a configuration revision", async () => {
    vi.stubEnv("JOBS_CONFIG_REVISION", "../../production");
    await expect(loadWorkerEnvironment(config)).rejects.toThrow("JOB_ENVIRONMENT_INVALID");
  });

  it.each([
    { Name: "/learnrecur/production/jobs/DATABASE_URL", Type: "SecureString", Value: "wrong-environment" },
    { Name: "/learnrecur/staging/jobs/AWS_SECRET_ACCESS_KEY", Type: "SecureString", Value: "wrong-identity" },
    { Name: "/learnrecur/staging/jobs/DATABASE_URL", Type: "String", Value: "unencrypted" },
  ])("rejects foreign or unsafe parameters before changing the process environment", async (invalid) => {
    vi.stubEnv("DATABASE_URL", "unchanged");
    pages.mockImplementation(async function* () { yield { Parameters: [...params(), invalid] }; });
    await expect(loadWorkerEnvironment(config)).rejects.toThrow("JOB_ENVIRONMENT_INVALID");
    expect(process.env.DATABASE_URL).toBe("unchanged");
  });

  it("fails closed for incomplete configuration", async () => {
    pages.mockImplementation(async function* () { yield { Parameters: [] }; });
    await expect(loadWorkerEnvironment(config)).rejects.toThrow("JOB_ENVIRONMENT_INCOMPLETE");
  });
});
