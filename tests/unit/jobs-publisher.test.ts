import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.hoisted(() => vi.fn());
vi.mock("@aws-sdk/client-sqs", () => ({
  SQSClient: class { send = send; },
  SendMessageCommand: class { constructor(public input: unknown) {} },
}));

import { getJobsConfig, getJobsEnvStatus } from "@/lib/jobs/config";
import { createJobPublisher } from "@/lib/jobs/publisher";
import { getJobMessageGroupId, parseJobEnvelope } from "@/lib/jobs/contracts";

const env = {
  JOBS_ENVIRONMENT: "staging", AWS_REGION: "us-east-1",
  JOBS_QUEUE_URL: "https://sqs.us-east-1.amazonaws.com/123456789012/learnrecur-staging-jobs.fifo",
};
const data = { userId: "user-a", operationId: "operation-a", requestedAt: "2026-09-05T01:00:00.000Z" };

describe("AWS job publishing", () => {
  beforeEach(() => { send.mockReset().mockResolvedValue({ MessageId: "message-a" }); });

  it("publishes a validated envelope with stable FIFO and deduplication keys", async () => {
    await createJobPublisher(getJobsConfig(env))("learnrecur/agent-skill-operation.requested", data);
    const command = send.mock.calls[0][0].input;
    const job = parseJobEnvelope(command.MessageBody, "staging");
    expect(command).toMatchObject({ QueueUrl: env.JOBS_QUEUE_URL, MessageGroupId: getJobMessageGroupId(job), MessageDeduplicationId: job.id });
    expect(job.data).toEqual(data);
  });

  it("does not contact AWS for invalid payloads", async () => {
    await expect(createJobPublisher(getJobsConfig(env))("learnrecur/agent-skill-operation.requested", { ...data, sourceText: "private" })).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  it("surfaces failed enqueue without exposing the provider response", async () => {
    send.mockRejectedValue(new Error("sensitive provider response"));
    await expect(createJobPublisher(getJobsConfig(env))("learnrecur/agent-skill-operation.requested", data)).rejects.toThrow("JOB_PUBLISH_FAILED");
  });

  it("rejects an enqueue response that lacks a message receipt", async () => {
    send.mockResolvedValue({});
    await expect(createJobPublisher(getJobsConfig(env))("learnrecur/agent-skill-operation.requested", data)).rejects.toThrow("JOB_PUBLISH_FAILED");
  });
});

describe("AWS environment isolation", () => {
  it("derives the exact source ARN from the queue URL", () => {
    expect(getJobsConfig(env)).toEqual({ environment: "staging", region: "us-east-1", queueUrl: env.JOBS_QUEUE_URL, queueArn: "arn:aws:sqs:us-east-1:123456789012:learnrecur-staging-jobs.fifo" });
    expect(getJobsEnvStatus(env).status).toBe("configured");
  });

  it.each([
    { JOBS_ENVIRONMENT: undefined },
    { JOBS_ENVIRONMENT: "production" },
    { AWS_REGION: "us-west-2" },
    { JOBS_QUEUE_URL: "http://localhost:9324/123456789012/learnrecur-staging-jobs.fifo" },
    { JOBS_QUEUE_URL: env.JOBS_QUEUE_URL + "?redirect=somewhere" },
    { LEARNRECUR_DEPLOYMENT_TIER: "production" },
    { VERCEL_ENV: "production" },
  ])("fails closed for invalid or mismatched environment configuration", (overrides) => {
    expect(() => getJobsConfig({ ...env, ...overrides })).toThrow();
    expect(getJobsEnvStatus({ ...env, ...overrides }).status).toBe("missing-env");
  });

  it("accepts explicitly isolated staging deployed to a Vercel production slot", () => {
    expect(getJobsEnvStatus({ ...env, LEARNRECUR_DEPLOYMENT_TIER: "staging", VERCEL_ENV: "production" }).status).toBe("configured");
  });
});
