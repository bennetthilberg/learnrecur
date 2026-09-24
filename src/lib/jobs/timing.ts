/**
 * Keep transport timing in one place. Lambda has a ten-minute hard limit;
 * ordinary jobs stop at six minutes and agent skill operations stop at eight.
 * The delivery lease outlives Lambda, while SQS keeps its longer visibility
 * window so infrastructure retries follow AWS's Lambda/SQS guidance.
 */
export const JOB_TIMEOUT_SECONDS = 600;
export const JOB_LEASE_SECONDS = JOB_TIMEOUT_SECONDS + 60;
export const JOB_SOFT_DEADLINE_SECONDS = 360;
export const JOB_SOFT_DEADLINE_MS = JOB_SOFT_DEADLINE_SECONDS * 1_000;
export const AGENT_SKILL_OPERATION_SOFT_DEADLINE_SECONDS = 480;
export const AGENT_SKILL_OPERATION_SOFT_DEADLINE_MS = AGENT_SKILL_OPERATION_SOFT_DEADLINE_SECONDS * 1_000;
export const SQS_VISIBILITY_TIMEOUT_SECONDS = 3_600;

export function getJobSoftDeadlineMs(jobName: string): number {
  return jobName === "learnrecur/agent-skill-operation.requested"
    ? AGENT_SKILL_OPERATION_SOFT_DEADLINE_MS
    : JOB_SOFT_DEADLINE_MS;
}

export function hasValidJobTiming(): boolean {
  return (
    JOB_LEASE_SECONDS > JOB_TIMEOUT_SECONDS &&
    JOB_SOFT_DEADLINE_SECONDS < JOB_TIMEOUT_SECONDS &&
    AGENT_SKILL_OPERATION_SOFT_DEADLINE_SECONDS < JOB_TIMEOUT_SECONDS &&
    SQS_VISIBILITY_TIMEOUT_SECONDS > JOB_TIMEOUT_SECONDS
  );
}
