import { MaterialRevisionStatus } from "@/generated/prisma/client";

export type MaterialAvailabilityMessage = {
  title: string;
  description: string;
  tone: "ready" | "working" | "attention";
};

const PROVIDER_ERROR_MARKERS = [
  "DEADLINE_EXCEEDED",
  "INVALID_ARGUMENT",
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
];

export function getPublicMaterialActionErrorMessage(
  message: string | undefined,
  fallback: string,
) {
  const normalized = message?.trim();
  if (!normalized) {
    return undefined;
  }

  if (
    normalized.startsWith("{") ||
    normalized.startsWith("[") ||
    PROVIDER_ERROR_MARKERS.some((marker) => normalized.includes(marker))
  ) {
    return fallback;
  }

  return normalized.slice(0, 500);
}

export function getMaterialDraftItemErrorMessage(
  errorCode: string | null,
  errorMessage: string | null,
) {
  if (errorCode === "EVENT_SEND_FAILED") {
    return "Background processing was unavailable. Retry this item.";
  }

  return errorMessage;
}

export function getMaterialDraftAdjustmentCopy(input: {
  status: string;
  errorCode: string | null;
  generationMetadata: unknown;
}) {
  const repair = readTargetRepairMetadata(input.generationMetadata);
  const adjusting =
    (input.status === "GENERATING" &&
      (repair.status === "adjusting" || repair.status === "regenerating")) ||
    (input.status === "FAILED" &&
      input.errorCode === "VERIFICATION_REJECTED" &&
      repair.status !== "exhausted");

  return adjusting
    ? {
        title: "Just a minute longer",
        description: "LearnRecur is adjusting this skill to match the source.",
      }
    : null;
}

export function getMaterialActivationRetryCopy(input: {
  status: string;
  errorCode: string | null;
}) {
  return input.status === "ACTIVATING" &&
    input.errorCode === "ACTIVATION_RETRYING_TRANSIENT_FAILURE"
    ? {
        title: "Just a little longer",
        description: "LearnRecur is finishing this skill automatically.",
      }
    : null;
}

export function getMaterialBatchActivationCopy(readyCount: number) {
  return readyCount === 1
    ? {
        countLabel: "1 skill ready to add",
        actionLabel: "Add one skill",
      }
    : {
        countLabel: `${readyCount} skills ready to add`,
        actionLabel: `Add all ${readyCount}`,
      };
}

export function getMaterialAvailabilityMessage(input: {
  status: MaterialRevisionStatus;
  stalled: boolean;
  hasReadyRevision: boolean;
}): MaterialAvailabilityMessage {
  if (input.status === MaterialRevisionStatus.READY) {
    return {
      title: "Ready to create skills",
      description: "Choose any section from this material to start creating skills.",
      tone: "ready",
    };
  }

  if (input.stalled) {
    return input.hasReadyRevision
      ? {
          title: "Latest update needs attention",
          description:
            "You can still create skills from the current version or retry the update.",
          tone: "attention",
        }
      : {
          title: "Processing needs attention",
          description: "Retry processing before you can create skills from this material.",
          tone: "attention",
        };
  }

  if (
    input.status === MaterialRevisionStatus.PENDING_UPLOAD ||
    input.status === MaterialRevisionStatus.QUEUED ||
    input.status === MaterialRevisionStatus.PROCESSING
  ) {
    return input.hasReadyRevision
      ? {
          title: "Update in progress",
          description:
            "You can keep creating skills from the current version while the update finishes.",
          tone: "working",
        }
      : {
          title: "Preparing your material",
          description: "You can create skills as soon as the outline is ready.",
          tone: "working",
        };
  }

  if (input.status === MaterialRevisionStatus.DELETING) {
    return {
      title: "Deletion in progress",
      description: "This material can no longer be used to create skills.",
      tone: "attention",
    };
  }

  return input.hasReadyRevision
    ? {
        title: "Latest update needs attention",
        description: "You can still create skills from the current version or retry the update.",
        tone: "attention",
      }
    : {
        title: "Not ready to use",
        description: "Retry processing before you can create skills from this material.",
        tone: "attention",
      };
}

function readTargetRepairMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const repair = (value as Record<string, unknown>).targetRepair;
  return repair && typeof repair === "object" && !Array.isArray(repair)
    ? (repair as Record<string, unknown>)
    : {};
}
