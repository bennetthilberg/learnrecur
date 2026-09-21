/**
 * Activation work must finish well before the Lambda hard timeout. The
 * provider chain is currently bounded at just over five minutes; these
 * windows leave room for database cleanup and a fresh continuation.
 */
export const AGENT_OPERATION_CLEANUP_MARGIN_MS = 60_000;
export const AGENT_OPERATION_SOFT_DEADLINE_MS = 6 * 60_000;
export const AGENT_OPERATION_STALE_AFTER_MS = 8 * 60_000;

export function isAgentOperationClaimStale(claimedAt: Date, now: Date): boolean {
  return now.getTime() - claimedAt.getTime() >= AGENT_OPERATION_STALE_AFTER_MS;
}

export function shouldDeferAgentOperation(deadlineAt: Date, now: Date): boolean {
  return deadlineAt.getTime() - now.getTime() <= AGENT_OPERATION_CLEANUP_MARGIN_MS;
}
