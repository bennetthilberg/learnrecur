import { MaterialRevisionStatus } from "@/generated/prisma/client";

export const MATERIAL_QUEUE_STALE_AFTER_MS = 5 * 60 * 1_000;

export type MaterialIngestionDisplayState = "idle" | "processing" | "stalled";

export function getMaterialIngestionDisplayState(input: {
  status: MaterialRevisionStatus | null;
  updatedAt: Date | null;
  now?: Date;
}): MaterialIngestionDisplayState {
  if (
    input.status === MaterialRevisionStatus.QUEUED &&
    input.updatedAt &&
    (input.now ?? new Date()).getTime() - input.updatedAt.getTime() >= MATERIAL_QUEUE_STALE_AFTER_MS
  ) {
    return "stalled";
  }

  if (
    input.status === MaterialRevisionStatus.PENDING_UPLOAD ||
    input.status === MaterialRevisionStatus.QUEUED ||
    input.status === MaterialRevisionStatus.PROCESSING
  ) {
    return "processing";
  }

  return "idle";
}
