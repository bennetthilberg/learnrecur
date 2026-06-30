import "server-only";

import { SourceFileKind, SourceFileStatus, type Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  canRequeueSourceUploadMetadata,
  isDismissedSourceUploadMetadata,
  isSourceUploadDismissible,
  isSourceUploadProcessingStale,
  SOURCE_PROCESSING_STALE_AFTER_MS,
} from "@/lib/skills/uploads";

export type SkillCreationSourceRecoveryItem = {
  id: string;
  originalName: string;
  kind: Extract<SourceFileKind, "IMAGE" | "PDF" | "TEXT">;
  status: Extract<SourceFileStatus, "UPLOADED" | "PROCESSING" | "FAILED">;
  errorMessage: string | null;
  isStaleProcessing: boolean;
  canRequeue: boolean;
  canDismiss: boolean;
  hasSourceText: boolean;
};

export type SkillCreationSourceRecoveryTextResult =
  | {
      status: "ready";
      originalName: string;
      sourceText: string;
    }
  | {
      status: "not-found";
      message: string;
    };

export async function getSkillCreationSourceRecoveryItems(input: {
  userId: string;
  now: Date;
}): Promise<SkillCreationSourceRecoveryItem[]> {
  const prisma = getPrisma();
  const sourceFiles = await prisma.sourceFile.findMany({
    where: {
      userId: input.userId,
      OR: [
        {
          status: {
            in: [SourceFileStatus.UPLOADED, SourceFileStatus.PROCESSING, SourceFileStatus.FAILED],
          },
          kind: {
            in: [SourceFileKind.IMAGE, SourceFileKind.PDF],
          },
        },
        {
          status: {
            in: [SourceFileStatus.FAILED],
          },
          kind: SourceFileKind.TEXT,
          extractedText: {
            not: null,
          },
          skillRefs: {
            none: {},
          },
        },
      ],
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      originalName: true,
      kind: true,
      status: true,
      storageKey: true,
      metadata: true,
      _count: {
        select: {
          skillRefs: true,
        },
      },
    },
  });

  return sourceFiles
    .filter(isSourceRecoveryRecord)
    .filter((sourceFile) => !isDismissedSourceUploadMetadata(sourceFile.metadata))
    .map((sourceFile) => toSkillCreationSourceRecoveryItem(sourceFile, input.now))
    .filter(isVisibleSkillCreationRecoveryItem);
}

function isSourceRecoveryRecord<T extends { kind: SourceFileKind; status: SourceFileStatus }>(
  sourceFile: T,
): sourceFile is T & {
  kind: Extract<SourceFileKind, "IMAGE" | "PDF" | "TEXT">;
  status: Extract<SourceFileStatus, "UPLOADED" | "PROCESSING" | "FAILED">;
} {
  return (
    (sourceFile.kind === SourceFileKind.IMAGE ||
      sourceFile.kind === SourceFileKind.PDF ||
      sourceFile.kind === SourceFileKind.TEXT) &&
    (sourceFile.status === SourceFileStatus.UPLOADED ||
      sourceFile.status === SourceFileStatus.PROCESSING ||
      sourceFile.status === SourceFileStatus.FAILED)
  );
}

function toSkillCreationSourceRecoveryItem(
  sourceFile: {
    id: string;
    originalName: string;
    kind: Extract<SourceFileKind, "IMAGE" | "PDF" | "TEXT">;
    status: Extract<SourceFileStatus, "UPLOADED" | "PROCESSING" | "FAILED">;
    storageKey: string | null;
    metadata: Prisma.JsonValue | null;
    _count: {
      skillRefs: number;
    };
  },
  now: Date,
): SkillCreationSourceRecoveryItem {
  const isStaleProcessing =
    sourceFile.status === SourceFileStatus.PROCESSING &&
    isSourceUploadProcessingStale(sourceFile.metadata, now, SOURCE_PROCESSING_STALE_AFTER_MS);
  const canRequeueByRetryLimit = canRequeueSourceUploadMetadata(sourceFile.metadata);
  const isSavedRetryableUpload = isSavedSourceRetryable(sourceFile);

  return {
    id: sourceFile.id,
    originalName: sourceFile.originalName,
    kind: sourceFile.kind,
    status: sourceFile.status,
    errorMessage: getMetadataString(sourceFile.metadata, "errorMessage"),
    isStaleProcessing,
    canRequeue:
      canRequeueByRetryLimit &&
      (sourceFile.status === SourceFileStatus.UPLOADED ||
        isStaleProcessing ||
        (sourceFile.status === SourceFileStatus.FAILED && isSavedRetryableUpload)),
    canDismiss: isSourceUploadDismissible(sourceFile, now),
    hasSourceText: sourceFile.kind === SourceFileKind.TEXT && sourceFile._count.skillRefs === 0,
  };
}

function isVisibleSkillCreationRecoveryItem(sourceFile: SkillCreationSourceRecoveryItem) {
  return sourceFile.canRequeue || sourceFile.canDismiss || sourceFile.hasSourceText;
}

export async function getSkillCreationSourceRecoveryText(input: {
  userId: string;
  sourceFileId: string;
}): Promise<SkillCreationSourceRecoveryTextResult> {
  const prisma = getPrisma();
  const sourceFile = await prisma.sourceFile.findFirst({
    where: {
      id: input.sourceFileId,
      userId: input.userId,
      kind: SourceFileKind.TEXT,
      status: {
        in: [SourceFileStatus.FAILED],
      },
      skillRefs: {
        none: {},
      },
    },
    select: {
      originalName: true,
      extractedText: true,
    },
  });

  const sourceText = normalizeSourceText(sourceFile?.extractedText ?? null);

  if (!sourceFile || !sourceText) {
    return {
      status: "not-found",
      message: "That saved text could not be loaded. Paste it again to create the skill.",
    };
  }

  return {
    status: "ready",
    originalName: sourceFile.originalName,
    sourceText,
  };
}

function isSavedSourceRetryable(sourceFile: {
  kind: SourceFileKind;
  storageKey: string | null;
  _count: {
    skillRefs: number;
  };
}) {
  if (sourceFile._count.skillRefs > 0) {
    return false;
  }

  if (sourceFile.kind === SourceFileKind.TEXT) {
    return false;
  }

  return Boolean(sourceFile.storageKey);
}

function normalizeSourceText(sourceText: string | null) {
  const normalized = sourceText?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function getMetadataString(metadata: Prisma.JsonValue | null, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
