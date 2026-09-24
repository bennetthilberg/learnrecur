import { AsyncLocalStorage } from "node:async_hooks";
import { MAX_JOB_CONTINUATION_DEPTH } from "./contracts";

export const MAX_JOB_FOLLOW_UPS_PER_DELIVERY = 100;

type WorkerJobPublicationContext = {
  continuationDepth: number;
  publishedFollowUps: number;
};

const workerJobPublicationContext = new AsyncLocalStorage<WorkerJobPublicationContext>();

/** Track one delivery so follow-up publication cannot grow without a bound. */
export function withWorkerJobPublicationContext<T>(
  run: () => Promise<T>,
  continuationDepth = 0,
): Promise<T> {
  return workerJobPublicationContext.run({ continuationDepth, publishedFollowUps: 0 }, run);
}

export function reserveWorkerJobFollowUp(): number | undefined {
  const context = workerJobPublicationContext.getStore();
  if (!context) return undefined;
  if (context.continuationDepth >= MAX_JOB_CONTINUATION_DEPTH) {
    throw new JobContinuationLimitError("depth");
  }
  if (context.publishedFollowUps >= MAX_JOB_FOLLOW_UPS_PER_DELIVERY) {
    throw new JobContinuationLimitError("fanout");
  }
  context.publishedFollowUps += 1;
  return context.continuationDepth + 1;
}

export class JobContinuationLimitError extends Error {
  readonly retryable = false;
  readonly failureCode = "JOB_CONTINUATION_LIMIT_EXCEEDED";

  constructor(readonly limit: "depth" | "fanout") {
    super(`Background job ${limit === "depth" ? "continuation depth" : "follow-up count"} exceeded its safety limit.`);
    this.name = "JobContinuationLimitError";
  }
}
