import {
  AgentOperationItemStatus,
  AgentOperationStatus,
} from "@/generated/prisma/client";

export function reduceAgentOperationStatus(
  statuses: readonly AgentOperationItemStatus[],
): AgentOperationStatus {
  if (statuses.length === 0) return AgentOperationStatus.QUEUED;
  if (statuses.every((status) => status === AgentOperationItemStatus.CANCELED)) {
    return AgentOperationStatus.CANCELED;
  }
  const successful = statuses.filter(
    (status) =>
      status === AgentOperationItemStatus.ACTIVE || status === AgentOperationItemStatus.REUSED,
  ).length;
  const failed = statuses.filter(
    (status) =>
      status === AgentOperationItemStatus.FAILED || status === AgentOperationItemStatus.CANCELED,
  ).length;
  if (successful + failed === statuses.length) {
    if (successful === statuses.length) return AgentOperationStatus.SUCCEEDED;
    if (failed === statuses.length) return AgentOperationStatus.FAILED;
    return AgentOperationStatus.PARTIAL;
  }
  if (statuses.some((status) => status === AgentOperationItemStatus.NEEDS_REVIEW)) {
    return AgentOperationStatus.NEEDS_REVIEW;
  }
  if (statuses.some((status) => status === AgentOperationItemStatus.NEEDS_INPUT)) {
    return AgentOperationStatus.NEEDS_INPUT;
  }
  if (statuses.some((status) => status === AgentOperationItemStatus.ACTIVATING)) {
    return AgentOperationStatus.ACTIVATING;
  }
  if (statuses.some((status) => status === AgentOperationItemStatus.VERIFYING)) {
    return AgentOperationStatus.VERIFYING;
  }
  if (statuses.some((status) => status === AgentOperationItemStatus.GENERATING)) {
    return AgentOperationStatus.GENERATING;
  }
  if (statuses.some((status) => status === AgentOperationItemStatus.PLANNING)) {
    return AgentOperationStatus.PLANNING;
  }
  return AgentOperationStatus.QUEUED;
}
