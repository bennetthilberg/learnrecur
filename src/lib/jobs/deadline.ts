export class JobStageTimeoutError extends Error {
  readonly retryable = true;

  constructor(
    message: string,
    readonly stage: string,
  ) {
    super(message);
    this.name = "JobStageTimeoutError";
  }
}

export const MAX_JOB_STAGE_SETTLE_GRACE_MS = 10_000;

export function isJobStageTimeoutError(error: unknown): error is JobStageTimeoutError {
  return error instanceof JobStageTimeoutError;
}

export function getJobStageTimeoutMs(input: {
  deadlineAt?: Date;
  cleanupMarginMs: number;
  maxTimeoutMs: number;
  now?: Date;
  stage: string;
}): number {
  const remainingMs = input.deadlineAt
    ? input.deadlineAt.getTime() - (input.now ?? new Date()).getTime() - input.cleanupMarginMs
    : input.maxTimeoutMs;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    throw new JobStageTimeoutError(`${input.stage} did not have enough delivery time remaining.`, input.stage);
  }
  return Math.min(input.maxTimeoutMs, remainingMs);
}

export async function withAbortableTimeout<T>(input: {
  run(signal: AbortSignal): Promise<T>;
  timeoutMs: number;
  settleGraceMs?: number;
  message: string;
  stage: string;
  parentSignal?: AbortSignal;
}): Promise<T> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new JobStageTimeoutError(input.message, input.stage);
  }
  const settleGraceMs = input.settleGraceMs ?? 0;
  if (
    !Number.isFinite(settleGraceMs) ||
    settleGraceMs < 0 ||
    settleGraceMs > MAX_JOB_STAGE_SETTLE_GRACE_MS
  ) {
    throw new RangeError(
      `The abort settle grace must be between 0 and ${MAX_JOB_STAGE_SETTLE_GRACE_MS} milliseconds.`,
    );
  }
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeParentListener: (() => void) | undefined;

  const abortFromParent = () => {
    const reason = input.parentSignal?.reason;
    const error = reason instanceof Error
      ? reason
      : new JobStageTimeoutError(input.message, input.stage);
    if (!controller.signal.aborted) controller.abort(error);
    return error;
  };

  if (input.parentSignal?.aborted) {
    throw abortFromParent();
  }

  const timeout = new Promise<{ kind: "timeout" }>((resolve) => {
    timeoutId = setTimeout(() => resolve({ kind: "timeout" }), input.timeoutMs);
  });

  const parentAbort = input.parentSignal
    ? new Promise<{ kind: "aborted"; error: Error }>((resolve) => {
        const onAbort = () => {
          resolve({ kind: "aborted", error: abortFromParent() });
        };
        input.parentSignal!.addEventListener("abort", onAbort, { once: true });
        removeParentListener = () => input.parentSignal!.removeEventListener("abort", onAbort);
        if (input.parentSignal!.aborted) onAbort();
      })
    : null;

  try {
    const work = Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return input.run(controller.signal);
      })
      .then(
        (value) => ({ kind: "fulfilled" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );
    const outcome = await Promise.race(
      parentAbort ? [work, timeout, parentAbort] : [work, timeout],
    );

    if (outcome.kind === "fulfilled") return outcome.value as T;
    if (outcome.kind === "rejected") throw outcome.error;

    const error = outcome.kind === "timeout"
      ? new JobStageTimeoutError(input.message, input.stage)
      : outcome.error;
    if (!controller.signal.aborted) controller.abort(error);
    await waitForPromiseSettlement(work, settleGraceMs);
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    removeParentListener?.();
  }
}

async function waitForPromiseSettlement<T>(promise: Promise<T>, graceMs: number): Promise<void> {
  if (graceMs <= 0) return;
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise.then(() => undefined),
      new Promise<void>((resolve) => {
        graceTimer = setTimeout(resolve, graceMs);
      }),
    ]);
  } finally {
    if (graceTimer) clearTimeout(graceTimer);
  }
}
