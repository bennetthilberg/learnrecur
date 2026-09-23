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
  message: string;
  stage: string;
  parentSignal?: AbortSignal;
}): Promise<T> {
  if (!Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) {
    throw new JobStageTimeoutError(input.message, input.stage);
  }
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeParentListener: (() => void) | undefined;

  const abortFromParent = () => {
    const reason = input.parentSignal?.reason;
    const error = reason instanceof Error
      ? reason
      : new JobStageTimeoutError(input.message, input.stage);
    controller.abort(error);
  };

  if (input.parentSignal?.aborted) {
    abortFromParent();
    throw controller.signal.reason;
  }

  let rejectOnTimeout!: (error: JobStageTimeoutError) => void;
  const timeout = new Promise<never>((_, reject) => {
    rejectOnTimeout = reject;
    timeoutId = setTimeout(() => {
      const error = new JobStageTimeoutError(input.message, input.stage);
      controller.abort(error);
      rejectOnTimeout(error);
    }, input.timeoutMs);
  });

  const parentAbort = input.parentSignal
    ? new Promise<never>((_, reject) => {
        const onAbort = () => {
          abortFromParent();
          reject(controller.signal.reason);
        };
        input.parentSignal!.addEventListener("abort", onAbort, { once: true });
        removeParentListener = () => input.parentSignal!.removeEventListener("abort", onAbort);
        if (input.parentSignal!.aborted) onAbort();
      })
    : null;

  try {
    const work = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw controller.signal.reason;
      return input.run(controller.signal);
    });
    return await Promise.race(parentAbort ? [work, timeout, parentAbort] : [work, timeout]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    removeParentListener?.();
  }
}
