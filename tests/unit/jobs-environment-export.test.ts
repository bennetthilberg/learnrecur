import { expect, it, vi } from "vitest";
import { exportWorkerConfiguration } from "@/lib/jobs/environment-export";

const context = { AWS_WORKER_CONFIG_EXPORT_REVISION: "verified-revision", VERCEL: "1", VERCEL_ENV: "production", JOBS_ENVIRONMENT: "production", LEARNRECUR_DEPLOYMENT_TIER: "production" };

it("does nothing in ordinary builds", async () => {
  const send = vi.fn();
  await expect(exportWorkerConfiguration({}, send)).resolves.toEqual({ exported: false });
  expect(send).not.toHaveBeenCalled();
});

it.each([{ VERCEL: "0" }, { VERCEL_ENV: "preview" }, { JOBS_ENVIRONMENT: "staging" }, { LEARNRECUR_DEPLOYMENT_TIER: "staging" }, { AWS_WORKER_CONFIG_EXPORT_REVISION: "../other" }])("rejects unsafe export contexts before sending secrets", async (override) => {
  const send = vi.fn();
  await expect(exportWorkerConfiguration({ ...context, ...override }, send)).rejects.toThrow("WORKER_CONFIGURATION_EXPORT_CONTEXT_INVALID");
  expect(send).not.toHaveBeenCalled();
});

it("writes only worker settings into a new immutable encrypted revision", async () => {
  const send = vi.fn().mockResolvedValue({});
  const values = Object.fromEntries(["DATABASE_URL", "S3_BUCKET_NAME", "CLERK_SECRET_KEY", "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY", "NEXT_PUBLIC_APP_URL", "RESEND_API_KEY", "RESEND_FROM_EMAIL", "GEMINI_API_KEY"].map((key) => [key, `fixture-${key}`]));
  await expect(exportWorkerConfiguration({ ...context, ...values, AWS_SECRET_ACCESS_KEY: "do-not-copy" }, send)).resolves.toEqual({ exported: true, revision: "verified-revision", count: 8 });
  expect(send).toHaveBeenCalledTimes(8);
  for (const [command] of send.mock.calls) expect(command.input).toMatchObject({ Name: expect.stringMatching(/^\/learnrecur\/production\/jobs\/verified-revision\//), Type: "SecureString", Tier: "Standard", Overwrite: false });
  expect(JSON.stringify(send.mock.calls)).not.toContain("do-not-copy");
});
