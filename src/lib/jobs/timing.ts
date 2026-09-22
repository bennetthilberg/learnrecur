/**
 * Keep transport timing in one place. The Lambda function has a ten-minute
 * hard limit; the domain worker stops activation work at six minutes, its
 * delivery lease outlives that limit, and SQS keeps a much longer visibility
 * window so ordinary retries follow AWS's Lambda/SQS guidance.
 */
export const JOB_TIMEOUT_SECONDS = 600;
export const JOB_LEASE_SECONDS = JOB_TIMEOUT_SECONDS + 60;
export const JOB_SOFT_DEADLINE_SECONDS = 360;
export const JOB_SOFT_DEADLINE_MS = JOB_SOFT_DEADLINE_SECONDS * 1_000;
export const SQS_VISIBILITY_TIMEOUT_SECONDS = 3_600;

export function hasValidJobTiming(): boolean {
  return (
    JOB_LEASE_SECONDS > JOB_TIMEOUT_SECONDS &&
    JOB_SOFT_DEADLINE_SECONDS < JOB_TIMEOUT_SECONDS &&
    SQS_VISIBILITY_TIMEOUT_SECONDS > JOB_TIMEOUT_SECONDS
  );
}
