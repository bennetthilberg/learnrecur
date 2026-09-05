import type { SQSEvent, SQSBatchResponse, SQSRecord } from "aws-lambda";

import {
  getJobDefinition,
  getJobMessageGroupId,
  parseJobEnvelope,
  retryDelaySeconds,
  type JobEnvelope,
  type JobEnvironment,
} from "./contracts";

export type JobFailureCode =
  | "JOB_INVALID_MESSAGE"
  | "JOB_ID_CONFLICT"
  | "JOB_NON_RETRYABLE"
  | "JOB_RETRIES_EXHAUSTED"
  | "JOB_EXECUTION_FAILED";

export type JobClaim =
  | { status: "claimed"; attempt: number; token: string }
  | { status: "complete" }
  | { status: "busy"; retryAfterSeconds: number }
  | { status: "dead-letter"; reason: JobFailureCode };

export type JobExecutionContext = { attempt: number; maxAttempts: number };

export type JobWorkerDependencies = {
  environment: JobEnvironment;
  queueArn: string;
  claim(job: JobEnvelope): Promise<JobClaim>;
  complete(job: JobEnvelope, token: string): Promise<unknown>;
  fail(job: JobEnvelope, token: string, reason: JobFailureCode, terminal: boolean): Promise<unknown>;
  execute(job: JobEnvelope, context: JobExecutionContext): Promise<unknown>;
  deadLetter(record: SQSRecord, reason: JobFailureCode): Promise<unknown>;
  retry(record: SQSRecord, delaySeconds: number): Promise<unknown>;
  log(event: { outcome: string; name?: string; id?: string; attempt?: number; durationMs?: number }): void;
  now(): Date;
};

function isPermanent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "retryable" in error && error.retryable === false;
}

export function createJobWorker(dependencies: JobWorkerDependencies) {
  const { environment, queueArn, log } = dependencies;

  async function processRecord(record: SQSRecord): Promise<boolean> {
    // Never forward a message from an unexpected source, including to the DLQ.
    if (record.eventSource !== "aws:sqs" || record.eventSourceARN !== queueArn) {
      log({ outcome: "JOB_SOURCE_REJECTED" });
      return false;
    }

    let job: JobEnvelope;
    try {
      job = parseJobEnvelope(record.body, environment);
      if (record.attributes.MessageGroupId !== getJobMessageGroupId(job)) {
        throw new Error("JOB_GROUP_MISMATCH");
      }
    } catch {
      await dependencies.deadLetter(record, "JOB_INVALID_MESSAGE");
      log({ outcome: "JOB_INVALID_MESSAGE" });
      return true;
    }

    const claim = await dependencies.claim(job);
    if (claim.status === "complete") {
      log({ outcome: "duplicate", name: job.name, id: job.id });
      return true;
    }
    if (claim.status === "busy") {
      await dependencies.retry(record, claim.retryAfterSeconds);
      log({ outcome: "leased", name: job.name, id: job.id });
      return false;
    }
    if (claim.status === "dead-letter") {
      await dependencies.deadLetter(record, claim.reason);
      log({ outcome: claim.reason, name: job.name, id: job.id });
      return true;
    }

    const maxAttempts = getJobDefinition(job.name).maxAttempts;
    const startedAt = dependencies.now().getTime();
    try {
      await dependencies.execute(job, { attempt: claim.attempt - 1, maxAttempts });
    } catch (error) {
      const permanent = isPermanent(error);
      const terminal = permanent || claim.attempt >= maxAttempts;
      const reason = permanent ? "JOB_NON_RETRYABLE" : terminal ? "JOB_RETRIES_EXHAUSTED" : "JOB_EXECUTION_FAILED";
      // Persist terminal state first. If DLQ publication fails, the next delivery
      // retries publication without re-executing the failed business operation.
      await dependencies.fail(job, claim.token, reason, terminal);
      if (terminal) await dependencies.deadLetter(record, reason);
      else await dependencies.retry(record, retryDelaySeconds(claim.attempt));
      log({ outcome: reason, name: job.name, id: job.id, attempt: claim.attempt });
      return terminal;
    }

    // Completion storage failures must keep the lease. Do not treat them as
    // execution failures and immediately rerun an already-applied side effect.
    await dependencies.complete(job, claim.token);
    log({ outcome: "completed", name: job.name, id: job.id, attempt: claim.attempt, durationMs: dependencies.now().getTime() - startedAt });
    return true;
  }

  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    for (let index = 0; index < event.Records.length; index += 1) {
      let acknowledged = false;
      try {
        acknowledged = await processRecord(event.Records[index]);
      } catch {
        // Exception messages may contain SQL, provider responses, or source text.
        log({ outcome: "JOB_DELIVERY_FAILED" });
      }
      if (!acknowledged) {
        // FIFO ordering requires leaving all subsequent records unprocessed.
        return { batchItemFailures: event.Records.slice(index).map((record) => ({ itemIdentifier: record.messageId })) };
      }
    }
    return { batchItemFailures: [] };
  };
}
