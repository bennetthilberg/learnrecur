import { describe, expect, it, vi } from "vitest";
import type { SQSRecord } from "aws-lambda";
import { buildJobEnvelope, getJobMessageGroupId } from "@/lib/jobs/contracts";
import { createJobWorker, type JobWorkerDependencies } from "@/lib/jobs/worker";

const queueArn = "arn:aws:sqs:us-east-1:123456789012:learnrecur-staging-jobs.fifo";
function record(overrides: Partial<SQSRecord> = {}): SQSRecord {
  const job = buildJobEnvelope("learnrecur/choice-refill.requested", {
    userId: "user-a", skillId: "skill-a", generationJobId: "job-a",
    targetReadyCount: 5, requestedAt: "2026-09-04T21:00:00.000Z",
  }, "staging");
  return {
    messageId: "message-a", receiptHandle: "receipt-a", body: JSON.stringify(job),
    attributes: { ApproximateReceiveCount: "1", SentTimestamp: "1", SenderId: "sender", ApproximateFirstReceiveTimestamp: "1", MessageGroupId: getJobMessageGroupId(job) },
    messageAttributes: {}, md5OfBody: "", eventSource: "aws:sqs", eventSourceARN: queueArn,
    awsRegion: "us-east-1", ...overrides,
  };
}

function setup() {
  const dependencies: JobWorkerDependencies = {
    environment: "staging", queueArn,
    claim: vi.fn().mockResolvedValue({ status: "claimed", attempt: 1, token: "lease" }),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    execute: vi.fn().mockResolvedValue(undefined),
    deadLetter: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    log: vi.fn(),
    now: () => new Date("2026-09-04T21:00:00.000Z"),
  };
  return { dependencies, run: createJobWorker(dependencies) };
}

describe("SQS worker delivery safety", () => {
  it("acknowledges only after execution and durable completion", async () => {
    const { dependencies, run } = setup();
    expect(await run({ Records: [record()] })).toEqual({ batchItemFailures: [] });
    expect(dependencies.execute).toHaveBeenCalledWith(expect.objectContaining({ name: "learnrecur/choice-refill.requested" }), { attempt: 0, maxAttempts: 3 });
    expect(dependencies.complete).toHaveBeenCalledOnce();
    expect(dependencies.deadLetter).not.toHaveBeenCalled();
  });

  it("skips a durably completed duplicate", async () => {
    const { dependencies, run } = setup();
    vi.mocked(dependencies.claim).mockResolvedValue({ status: "complete" });
    expect(await run({ Records: [record()] })).toEqual({ batchItemFailures: [] });
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it("retries an active lease instead of losing a duplicate after its original fails", async () => {
    const { dependencies, run } = setup();
    vi.mocked(dependencies.claim).mockResolvedValue({ status: "busy" });
    expect(await run({ Records: [record()] })).toEqual({ batchItemFailures: [{ itemIdentifier: "message-a" }] });
    expect(dependencies.execute).not.toHaveBeenCalled();
    expect(dependencies.retry).toHaveBeenCalled();
  });

  it("retries transient errors with bounded delay and without logging private error text", async () => {
    const { dependencies, run } = setup();
    vi.mocked(dependencies.execute).mockRejectedValue(new Error("private study material and token"));
    expect(await run({ Records: [record()] })).toEqual({ batchItemFailures: [{ itemIdentifier: "message-a" }] });
    expect(dependencies.fail).toHaveBeenCalledWith(expect.anything(), "lease", "JOB_EXECUTION_FAILED", false);
    expect(dependencies.retry).toHaveBeenCalledWith(expect.anything(), 30);
    expect(JSON.stringify(vi.mocked(dependencies.log).mock.calls)).not.toMatch(/private study material|token/);
  });

  it("sends permanent failures to the DLQ before acknowledging", async () => {
    const { dependencies, run } = setup();
    vi.mocked(dependencies.execute).mockRejectedValue(Object.assign(new Error("permanent"), { retryable: false }));
    expect(await run({ Records: [record()] })).toEqual({ batchItemFailures: [] });
    expect(dependencies.deadLetter).toHaveBeenCalledWith(expect.anything(), "JOB_NON_RETRYABLE");
    expect(dependencies.fail).toHaveBeenCalledWith(expect.anything(), "lease", "JOB_NON_RETRYABLE", true);
  });

  it("quarantines a retryable failure on its last allowed execution", async () => {
    const { dependencies, run } = setup();
    vi.mocked(dependencies.claim).mockResolvedValue({ status: "claimed", attempt: 3, token: "lease" });
    vi.mocked(dependencies.execute).mockRejectedValue(new Error("outage"));
    expect(await run({ Records: [record()] })).toEqual({ batchItemFailures: [] });
    expect(dependencies.deadLetter).toHaveBeenCalledWith(expect.anything(), "JOB_RETRIES_EXHAUSTED");
  });

  it("does not acknowledge when DLQ persistence fails", async () => {
    const { dependencies, run } = setup();
    vi.mocked(dependencies.execute).mockRejectedValue(Object.assign(new Error("permanent"), { retryable: false }));
    vi.mocked(dependencies.deadLetter).mockRejectedValue(new Error("SQS unavailable"));
    expect(await run({ Records: [record()] })).toEqual({ batchItemFailures: [{ itemIdentifier: "message-a" }] });
  });

  it("does not acknowledge when the database claim fails", async () => {
    const { dependencies, run } = setup();
    vi.mocked(dependencies.claim).mockRejectedValue(new Error("database unavailable"));
    expect(await run({ Records: [record()] })).toEqual({ batchItemFailures: [{ itemIdentifier: "message-a" }] });
    expect(dependencies.execute).not.toHaveBeenCalled();
  });

  it("does not rerun business logic after completion persistence fails", async () => {
    const { dependencies, run } = setup();
    vi.mocked(dependencies.complete).mockRejectedValue(new Error("database unavailable"));
    expect(await run({ Records: [record()] })).toEqual({ batchItemFailures: [{ itemIdentifier: "message-a" }] });
    // Keep the running lease; the domain's own idempotency handles eventual recovery.
    expect(dependencies.fail).not.toHaveBeenCalled();
  });

  it.each([
    { body: "{invalid" },
    { body: " ".repeat(65_537) },
    { attributes: { ...record().attributes, MessageGroupId: "wrong-partition" } },
  ])("quarantines malformed or wrongly partitioned messages", async (overrides) => {
    const { dependencies, run } = setup();
    expect(await run({ Records: [record(overrides)] })).toEqual({ batchItemFailures: [] });
    expect(dependencies.claim).not.toHaveBeenCalled();
    expect(dependencies.deadLetter).toHaveBeenCalledWith(expect.anything(), "JOB_INVALID_MESSAGE");
  });

  it("rejects an unexpected source queue without acting on the message", async () => {
    const { dependencies, run } = setup();
    expect(await run({ Records: [record({ eventSourceARN: queueArn.replace("staging", "production") })] }))
      .toEqual({ batchItemFailures: [{ itemIdentifier: "message-a" }] });
    expect(dependencies.claim).not.toHaveBeenCalled();
    expect(dependencies.deadLetter).not.toHaveBeenCalled();
  });

  it("stops after failure and returns all remaining FIFO records unprocessed", async () => {
    const { dependencies, run } = setup();
    vi.mocked(dependencies.execute).mockRejectedValue(new Error("outage"));
    expect(await run({ Records: [record(), record({ messageId: "message-b" })] }))
      .toEqual({ batchItemFailures: [{ itemIdentifier: "message-a" }, { itemIdentifier: "message-b" }] });
    expect(dependencies.execute).toHaveBeenCalledOnce();
  });
});
