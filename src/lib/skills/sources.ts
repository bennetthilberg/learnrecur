import "server-only";

import {
  type SourceFileKind,
  type SourceFileStatus,
} from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import { resolveS3SourceObjectStorage } from "@/lib/storage/s3";

export const SOURCE_PREVIEW_CHAR_LIMIT = 520;

export type SkillSourceSummary = {
  id: string;
  sourceFileId: string;
  label: string;
  kind: SourceFileKind;
  status: SourceFileStatus;
  byteSize: number | null;
  createdAt: Date;
  note: string | null;
  preview: string | null;
};

export type SkillSourceSummariesResult =
  | {
      status: "ready";
      sources: SkillSourceSummary[];
    }
  | {
      status: "not-found";
      reason: "skill-not-found";
      message: string;
    };

export type RemoveSkillSourceResult =
  | {
      status: "removed";
      sourceRefId: string;
      sourceFileId: string;
      sourceFileDeleted: boolean;
      message: string;
    }
  | {
      status: "not-removed";
      reason: "storage-delete-failed";
      message: string;
    }
  | {
      status: "not-found";
      reason: "source-not-found";
      message: string;
    };

export type GetSkillSourceSummariesInput = {
  userId: string;
  skillId: string;
};

export type RemoveSkillSourceInput = GetSkillSourceSummariesInput & {
  sourceRefId: string;
  deleteStoredObject?: (input: { bucketName: string; key: string }) => Promise<void>;
};

export function buildSourcePreview(sourceText: string | null | undefined): string | null {
  const normalized = (sourceText ?? "").trim().replace(/\s+/g, " ");

  if (!normalized) {
    return null;
  }

  if (normalized.length <= SOURCE_PREVIEW_CHAR_LIMIT) {
    return normalized;
  }

  const marker = " [truncated]";
  return `${normalized.slice(0, SOURCE_PREVIEW_CHAR_LIMIT - marker.length).trimEnd()}${marker}`;
}

export async function getSkillSourceSummaries(
  input: GetSkillSourceSummariesInput,
): Promise<SkillSourceSummariesResult> {
  const prisma = getPrisma();
  const skill = await prisma.skill.findFirst({
    where: {
      id: input.skillId,
      userId: input.userId,
    },
    select: {
      id: true,
      sourceRefs: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          sourceFileId: true,
          note: true,
          sourceFile: {
            select: {
              originalName: true,
              kind: true,
              status: true,
              byteSize: true,
              createdAt: true,
              extractedText: true,
            },
          },
        },
      },
    },
  });

  if (!skill) {
    return {
      status: "not-found",
      reason: "skill-not-found",
      message: "Skill not found.",
    };
  }

  return {
    status: "ready",
    sources: skill.sourceRefs.map((sourceRef) => ({
      id: sourceRef.id,
      sourceFileId: sourceRef.sourceFileId,
      label: sourceRef.sourceFile.originalName,
      kind: sourceRef.sourceFile.kind,
      status: sourceRef.sourceFile.status,
      byteSize: sourceRef.sourceFile.byteSize,
      createdAt: sourceRef.sourceFile.createdAt,
      note: sourceRef.note,
      preview: buildSourcePreview(sourceRef.sourceFile.extractedText),
    })),
  };
}

export async function removeSkillSource(
  input: RemoveSkillSourceInput,
): Promise<RemoveSkillSourceResult> {
  const prisma = getPrisma();

  const sourceRef = await prisma.skillSourceRef.findFirst({
    where: {
      id: input.sourceRefId,
      userId: input.userId,
      skillId: input.skillId,
    },
    select: {
      id: true,
      sourceFileId: true,
      sourceFile: {
        select: {
          storageBucket: true,
          storageKey: true,
        },
      },
    },
  });

  if (!sourceRef) {
    return sourceNotFound("Source material was not found for this skill.");
  }

  const initialRefCount = await prisma.skillSourceRef.count({
    where: {
      userId: input.userId,
      sourceFileId: sourceRef.sourceFileId,
    },
  });

  // V0 keeps S3 network I/O outside the Prisma transaction. If another source
  // ref is created after this count but before the transaction below, the object
  // can be deleted while a new ref remains. TODO: add a background storage audit
  // that scans SourceFile storage keys, detects missing S3 objects, and logs or
  // repairs orphaned source refs.
  const shouldDeleteStoredObject = initialRefCount === 1;

  if (shouldDeleteStoredObject) {
    const storedObjectDeleted = await deleteStoredSourceObject({
      sourceFile: sourceRef.sourceFile,
      deleteStoredObject: input.deleteStoredObject,
    });

    if (storedObjectDeleted.status === "failed") {
      return {
        status: "not-removed",
        reason: "storage-delete-failed",
        message: storedObjectDeleted.message,
      };
    }
  }

  return prisma.$transaction(async (tx) => {
    const deletedRef = await tx.skillSourceRef.deleteMany({
      where: {
        id: sourceRef.id,
        userId: input.userId,
        skillId: input.skillId,
      },
    });

    if (deletedRef.count !== 1) {
      return sourceNotFound("Source material was not found for this skill.");
    }

    const remainingRefCount = await tx.skillSourceRef.count({
      where: {
        userId: input.userId,
        sourceFileId: sourceRef.sourceFileId,
      },
    });
    let sourceFileDeleted = false;

    if (shouldDeleteStoredObject && remainingRefCount === 0) {
      const deleted = await tx.sourceFile.deleteMany({
        where: {
          id: sourceRef.sourceFileId,
          userId: input.userId,
        },
      });
      sourceFileDeleted = deleted.count > 0;
    }

    return {
      status: "removed",
      sourceRefId: sourceRef.id,
      sourceFileId: sourceRef.sourceFileId,
      sourceFileDeleted,
      message: "Source material removed.",
    };
  });
}

async function deleteStoredSourceObject({
  sourceFile,
  deleteStoredObject,
}: {
  sourceFile: {
    storageBucket: string | null;
    storageKey: string | null;
  };
  deleteStoredObject?: (input: { bucketName: string; key: string }) => Promise<void>;
}): Promise<
  | {
      status: "ready";
    }
  | {
      status: "failed";
      message: string;
    }
> {
  if (!sourceFile.storageBucket || !sourceFile.storageKey) {
    return {
      status: "ready",
    };
  }

  try {
    if (deleteStoredObject) {
      await deleteStoredObject({
        bucketName: sourceFile.storageBucket,
        key: sourceFile.storageKey,
      });
    } else {
      const storageSetup = resolveS3SourceObjectStorage();

      if (storageSetup.status === "missing-env") {
        return {
          status: "failed",
          message: storageSetup.message,
        };
      }

      if (storageSetup.storage.bucketName !== sourceFile.storageBucket) {
        return {
          status: "failed",
          message: "Stored source bucket does not match the configured S3 bucket.",
        };
      }

      await storageSetup.storage.deleteObject({
        key: sourceFile.storageKey,
        bucket: sourceFile.storageBucket,
      });
    }

    return {
      status: "ready",
    };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "Could not delete stored source object.",
    };
  }
}

function sourceNotFound(message: string): Extract<RemoveSkillSourceResult, { status: "not-found" }> {
  return {
    status: "not-found",
    reason: "source-not-found",
    message,
  };
}
