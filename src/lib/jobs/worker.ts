import type { SQSEvent, SQSBatchResponse, SQSRecord } from "aws-lambda";

import {
  getJobDefinition,
  getJobMessageGroupId,
  parseJobEnvelope,
  retryDelaySeconds,
  type JobEnvelope,
  type JobEnvironment,
} from "./contracts";
import { getJobSoftDeadlineMs } from "./timing";

export type JobFailureCode =
  | "JOB_INVALID_MESSAGE"
  | "JOB_ID_CONFLICT"
  | "JOB_NON_RETRYABLE"
  | "JOB_CONTINUATION_LIMIT_EXCEEDED"
  | "JOB_RETRIES_EXHAUSTED"
  | "JOB_EXECUTION_FAILED";

export type JobClaim =
  | { status: "claimed"; attempt: number; token: string }
  | { status: "complete" }
  | { status: "busy"; retryAfterSeconds: number }
  | { status: "dead-letter"; reason: JobFailureCode };

export type JobExecutionContext = { attempt: number; maxAttempts: number; deadlineAt?: Date };

const MAINTENANCE_LOG_FIELDS = [
  "purgedPayloads",
  "purgedRateBuckets",
  "expiredUploadOperations",
  "revocationsAttempted",
  "revocationsFailed",
  "refillEventsAttempted",
  "refillEventsDelivered",
  "refillEventsFailed",
  "activationItemsScanned",
  "activationItemsRequeued",
  "activationItemsFinalized",
  "activationItemsWaiting",
  "activationLegacyItemsPromoted",
  "activationContinuations",
  "activationContinuationPublishFailures",
] as const;

type MaintenanceLogFields = { [Field in typeof MAINTENANCE_LOG_FIELDS[number]]: number };

function maintenanceLogFields(value: unknown): MaintenanceLogFields | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const result = {} as MaintenanceLogFields;
  const summary = value as Record<string, unknown>;
  for (const field of MAINTENANCE_LOG_FIELDS) {
    const count = summary[field];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) return undefined;
    result[field] = count;
  }
  return result;
}

type JobWorkerLogEvent = {
  outcome: string;
  name?: string;
  id?: string;
  attempt?: number;
  durationMs?: number;
  phase?: DeliveryPhase;
  errorCode?: string;
} & Partial<MaintenanceLogFields>;

type DeliveryPhase =
  | "received" | "source" | "parse" | "dead-letter-invalid" | "claim"
  | "retry-busy" | "dead-letter-claimed" | "execute" | "fail"
  | "dead-letter-terminal" | "retry-execution" | "complete";
type DeliveryDiagnostic = { job?: JobEnvelope; phase: DeliveryPhase };

function safeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = error.code;
  return typeof code === "string" &&
    (/^P\d{4}$/.test(code) || /^(?:08|22|23|40|42|53|55|57|58|XX)[0-9A-Z]{3}$/.test(code) ||
      ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code))
    ? code : undefined;
}

export type JobWorkerDependencies = {
  environment: JobEnvironment;
  queueArn: string;
  claim(job: JobEnvelope): Promise<JobClaim>;
  complete(job: JobEnvelope, token: string): Promise<unknown>;
  fail(job: JobEnvelope, token: string, reason: JobFailureCode, terminal: boolean): Promise<unknown>;
  execute(job: JobEnvelope, context: JobExecutionContext): Promise<unknown>;
  deadLetter(record: SQSRecord, reason: JobFailureCode): Promise<unknown>;
  retry(record: SQSRecord, delaySeconds: number): Promise<unknown>;
  log(event: JobWorkerLogEvent): void;
  now(): Date;
};

function isPermanent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "retryable" in error && error.retryable === false;
}

function failureReason(error: unknown, permanent: boolean, terminal: boolean): JobFailureCode {
  if (permanent && typeof error === "object" && error !== null && "failureCode" in error &&
    error.failureCode === "JOB_CONTINUATION_LIMIT_EXCEEDED") {
    return "JOB_CONTINUATION_LIMIT_EXCEEDED";
  }
  return permanent ? "JOB_NON_RETRYABLE" : terminal ? "JOB_RETRIES_EXHAUSTED" : "JOB_EXECUTION_FAILED";
}

export function createJobWorker(dependencies: JobWorkerDependencies) {
  const { environment, queueArn, log } = dependencies;

  async function processRecord(record: SQSRecord, diagnostic: DeliveryDiagnostic): Promise<boolean> {
    diagnostic.phase = "source";
    // Never forward a message from an unexpected source, including to the DLQ.
    if (record.eventSource !== "aws:sqs" || record.eventSourceARN !== queueArn) {
      log({ outcome: "JOB_SOURCE_REJECTED" });
      return false;
    }

    let job: JobEnvelope;
    try {
      diagnostic.phase = "parse";
      job = parseJobEnvelope(record.body, environment);
      if (record.attributes.MessageGroupId !== getJobMessageGroupId(job)) {
        throw new Error("JOB_GROUP_MISMATCH");
      }
    } catch {
      diagnostic.phase = "dead-letter-invalid";
      await dependencies.deadLetter(record, "JOB_INVALID_MESSAGE");
      log({ outcome: "JOB_INVALID_MESSAGE" });
      return true;
    }

    diagnostic.job = job;
    diagnostic.phase = "claim";
    const claim = await dependencies.claim(job);
    if (claim.status === "complete") {
      log({ outcome: "duplicate", name: job.name, id: job.id });
      return true;
    }
    if (claim.status === "busy") {
      diagnostic.phase = "retry-busy";
      await dependencies.retry(record, claim.retryAfterSeconds);
      log({ outcome: "leased", name: job.name, id: job.id });
      return false;
    }
    if (claim.status === "dead-letter") {
      diagnostic.phase = "dead-letter-claimed";
      await dependencies.deadLetter(record, claim.reason);
      log({ outcome: claim.reason, name: job.name, id: job.id });
      return true;
    }

    const maxAttempts = getJobDefinition(job.name).maxAttempts;
    const startedAt = dependencies.now().getTime();
    let executionResult: unknown;
    try {
      diagnostic.phase = "execute";
      executionResult = await dependencies.execute(job, {
        attempt: claim.attempt - 1,
        maxAttempts,
        deadlineAt: new Date(startedAt + getJobSoftDeadlineMs(job.name)),
      });
    } catch (error) {
      const permanent = isPermanent(error);
      const terminal = permanent || claim.attempt >= maxAttempts;
      const reason = failureReason(error, permanent, terminal);
      // Persist terminal state first. If DLQ publication fails, the next delivery
      // retries publication without re-executing the failed business operation.
      diagnostic.phase = "fail";
      await dependencies.fail(job, claim.token, reason, terminal);
      if (terminal) {
        diagnostic.phase = "dead-letter-terminal";
        await dependencies.deadLetter(record, reason);
      } else {
        diagnostic.phase = "retry-execution";
        await dependencies.retry(record, retryDelaySeconds(claim.attempt));
      }
      log({ outcome: reason, name: job.name, id: job.id, attempt: claim.attempt });
      return terminal;
    }

    // Completion storage failures must keep the lease. Do not treat them as
    // execution failures and immediately rerun an already-applied side effect.
    diagnostic.phase = "complete";
    await dependencies.complete(job, claim.token);
    log({
      outcome: "completed",
      name: job.name,
      id: job.id,
      attempt: claim.attempt,
      durationMs: dependencies.now().getTime() - startedAt,
      ...(job.name === "learnrecur/agent-access.maintenance" ? maintenanceLogFields(executionResult) : {}),
    });
    return true;
  }

  return async (event: SQSEvent): Promise<SQSBatchResponse> => {
    for (let index = 0; index < event.Records.length; index += 1) {
      let acknowledged = false;
      const diagnostic: DeliveryDiagnostic = { phase: "received" };
      try {
        acknowledged = await processRecord(event.Records[index], diagnostic);
      } catch (error) {
        // Exception messages may contain SQL, provider responses, or source text.
        log({
          outcome: "JOB_DELIVERY_FAILED",
          name: diagnostic.job?.name,
          id: diagnostic.job?.id,
          phase: diagnostic.phase,
          errorCode: safeErrorCode(error),
        });
      }
      if (!acknowledged) {
        // FIFO ordering requires leaving all subsequent records unprocessed.
        return { batchItemFailures: event.Records.slice(index).map((record) => ({ itemIdentifier: record.messageId })) };
      }
    }
    return { batchItemFailures: [] };
  };
}
