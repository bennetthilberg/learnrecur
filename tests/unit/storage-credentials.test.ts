import { expect, it, vi } from "vitest";
const clientOptions = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-s3", async (original) => ({
  ...await original<typeof import("@aws-sdk/client-s3")>(),
  S3Client: class { constructor(options: unknown) { clientOptions(options); } },
}));
import { createS3SourceObjectStorage } from "@/lib/storage/s3";
import { getS3Env } from "@/lib/env";

it("passes the Lambda role session token through S3 configuration", () => {
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv("AWS_ACCESS_KEY_ID", "temporary-key");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "temporary-secret");
  vi.stubEnv("AWS_SESSION_TOKEN", "temporary-session-token");
  vi.stubEnv("S3_BUCKET_NAME", "test-bucket");
  try {
    createS3SourceObjectStorage(getS3Env());
    expect(clientOptions).toHaveBeenCalledWith({ region: "us-east-1", credentials: { accessKeyId: "temporary-key", secretAccessKey: "temporary-secret", sessionToken: "temporary-session-token" } });
  } finally {
    vi.unstubAllEnvs();
  }
});
