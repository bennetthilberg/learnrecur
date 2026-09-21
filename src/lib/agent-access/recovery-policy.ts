import { JOB_SOFT_DEADLINE_MS, JOB_TIMEOUT_SECONDS } from "@/lib/jobs/timing";
import { ACTIVATION_GENERATION_TIMEOUT_MS } from "@/lib/skills/activation-timing";

/**
 * Activation work must finish well before the Lambda hard timeout. The job
 * deadline is intentionally soft, so reserve the part of the activation
 * budget that can occur after that deadline plus the cleanup margin.
 */
export const AGENT_OPERATION_CLEANUP_MARGIN_MS = 60_000;
export const AGENT_OPERATION_SOFT_DEADLINE_MS = JOB_SOFT_DEADLINE_MS;
export const AGENT_OPERATION_STALE_AFTER_MS = 8 * 60_000;
export const AGENT_OPERATION_ITEM_RETRY_LIMIT = 4;
export const AGENT_OPERATION_ACTIVATION_RESERVE_MS = Math.max(
  AGENT_OPERATION_CLEANUP_MARGIN_MS,
  ACTIVATION_GENERATION_TIMEOUT_MS -
    (JOB_TIMEOUT_SECONDS * 1_000 - AGENT_OPERATION_SOFT_DEADLINE_MS) +
    AGENT_OPERATION_CLEANUP_MARGIN_MS,
);

export function isAgentOperationClaimStale(claimedAt: Date, now: Date): boolean {
  return now.getTime() - claimedAt.getTime() >= AGENT_OPERATION_STALE_AFTER_MS;
}

export function shouldDeferAgentOperation(deadlineAt: Date, now: Date): boolean {
  return deadlineAt.getTime() - now.getTime() <= AGENT_OPERATION_ACTIVATION_RESERVE_MS;
}
