import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getJobStageTimeoutMs,
  isJobStageTimeoutError,
  JobStageTimeoutError,
  withAbortableTimeout,
} from "@/lib/jobs/deadline";

describe("job stage deadlines", () => {
  afterEach(() => vi.useRealTimers());

  it("aborts a never-resolving operation at its timeout", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = withAbortableTimeout({
      run: (receivedSignal) => {
        signal = receivedSignal;
        return new Promise<never>(() => {});
      },
      timeoutMs: 25,
      message: "verification timed out",
      stage: "verification",
    });

    const assertion = expect(result).rejects.toMatchObject({
      name: "JobStageTimeoutError",
      stage: "verification",
      retryable: true,
      message: "verification timed out",
    });
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    expect(signal?.aborted).toBe(true);
    expect(isJobStageTimeoutError(new JobStageTimeoutError("late", "publish"))).toBe(true);
  });

  it("uses the delivery deadline while reserving time for cleanup", () => {
    const now = new Date("2026-09-23T20:00:00.000Z");
    expect(getJobStageTimeoutMs({
      deadlineAt: new Date(now.getTime() + 25_000),
      cleanupMarginMs: 5_000,
      maxTimeoutMs: 30_000,
      now,
      stage: "verification",
    })).toBe(20_000);
    expect(() => getJobStageTimeoutMs({
      deadlineAt: new Date(now.getTime() + 5_000),
      cleanupMarginMs: 5_000,
      maxTimeoutMs: 30_000,
      now,
      stage: "verification",
    })).toThrow(JobStageTimeoutError);
  });

  it("stops listening to an external abort signal after successful completion", async () => {
    const parent = new AbortController();
    await expect(withAbortableTimeout({
      run: async () => "done",
      timeoutMs: 100,
      message: "generation timed out",
      stage: "generation",
      parentSignal: parent.signal,
    })).resolves.toBe("done");
    expect(parent.signal.aborted).toBe(false);
  });

  it("does not start work after the caller has already aborted", async () => {
    const parent = new AbortController();
    const reason = new Error("delivery ended");
    parent.abort(reason);
    const run = vi.fn(async () => "should not run");

    await expect(withAbortableTimeout({
      run,
      timeoutMs: 100,
      message: "generation timed out",
      stage: "generation",
      parentSignal: parent.signal,
    })).rejects.toBe(reason);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects invalid timeouts instead of silently running without a deadline", async () => {
    await expect(withAbortableTimeout({
      run: async () => "should not run",
      timeoutMs: 0,
      message: "generation timed out",
      stage: "generation",
    })).rejects.toMatchObject({
      name: "JobStageTimeoutError",
      stage: "generation",
    });
  });
});
