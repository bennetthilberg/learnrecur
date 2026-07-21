import "server-only";

import {
  GenerationJobStatus,
  SkillStatus,
  Prisma,
  type SourceFile,
} from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import { resolveS3SourceObjectStorage } from "@/lib/storage/s3";

const DELETABLE_SKILL_STATUSES = [SkillStatus.DRAFT, SkillStatus.ARCHIVED] as const;
const ACTIVE_GENERATION_JOB_STATUSES = [
  GenerationJobStatus.PENDING,
  GenerationJobStatus.RUNNING,
] as const;

export type DeleteStoredSourceObject = (input: {
  bucketName: string;
  key: string;
}) => Promise<void>;

export type DeleteSkillPermanentlyInput = {
  userId: string;
  skillId: string;
  confirmationTitle: string;
  deleteStoredObject?: DeleteStoredSourceObject;
};

export type DeleteSkillPermanentlyResult =
  | {
      status: "deleted";
      message: string;
      skillId: string;
      deletedSourceFileIds: string[];
    }
  | {
      status: "not-found";
      message: string;
    }
  | {
      status: "not-deleted";
      reason:
        | "invalid-transition"
        | "job-in-progress"
        | "storage-delete-failed"
        | "title-mismatch";
      message: string;
      currentStatus?: SkillStatus;
    };

type DeleteSourceRefCount = {
  sourceFileId: string;
  referenceCount: number;
  materialRevisionId: string | null;
};

type DeletableSourceFile = Pick<
  SourceFile,
  "id" | "materialRevisionId" | "storageBucket" | "storageKey"
> & {
  _count: {
    skillRefs: number;
  };
};

export function isSkillDeleteTitleConfirmed(input: {
  skillTitle: string;
  confirmationTitle: string;
}): boolean {
  return input.confirmationTitle.trim() === input.skillTitle;
}

export function getOrphanSourceFileIdsForSkillDelete(
  sourceRefs: readonly DeleteSourceRefCount[],
): string[] {
  const sourceFileIds = new Set<string>();

  for (const sourceRef of sourceRefs) {
    if (sourceRef.referenceCount === 1 && sourceRef.materialRevisionId === null) {
      sourceFileIds.add(sourceRef.sourceFileId);
    }
  }

  return [...sourceFileIds];
}

export async function deleteSkillPermanently(
  input: DeleteSkillPermanentlyInput,
): Promise<DeleteSkillPermanentlyResult> {
  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "skills"
      WHERE "id" = ${input.skillId} AND "userId" = ${input.userId}
      FOR UPDATE
    `;

    const skill = await tx.skill.findFirst({
      where: {
        id: input.skillId,
        userId: input.userId,
      },
      select: {
        id: true,
        title: true,
        status: true,
        generationJobs: {
          where: {
            status: {
              in: [...ACTIVE_GENERATION_JOB_STATUSES],
            },
          },
          select: {
            id: true,
            status: true,
          },
          take: 1,
        },
        sourceRefs: {
          select: {
            sourceFileId: true,
          },
        },
      },
    });

    if (!skill) {
      return {
        status: "not-found",
        message: "Skill was not found.",
      };
    }

    if (!isDeletableSkillStatus(skill.status)) {
      return {
        status: "not-deleted",
        reason: "invalid-transition",
        currentStatus: skill.status,
        message: "Archive this skill before deleting it permanently.",
      };
    }

    if (!isSkillDeleteTitleConfirmed({ skillTitle: skill.title, confirmationTitle: input.confirmationTitle })) {
      return {
        status: "not-deleted",
        reason: "title-mismatch",
        message: "Type the current skill title exactly to confirm deletion.",
      };
    }

    if (skill.generationJobs.length > 0) {
      return {
        status: "not-deleted",
        reason: "job-in-progress",
        message: "Wait for the current exercise preparation to finish before deleting this skill.",
      };
    }

    const sourceFileIds = [...new Set(skill.sourceRefs.map((sourceRef) => sourceRef.sourceFileId))];
    const sourceFiles = await getLockedSourceFiles({
      prisma: tx,
      userId: input.userId,
      sourceFileIds,
    });
    const orphanSourceFileIds = getOrphanSourceFileIdsForSkillDelete(
      sourceFiles.map((sourceFile) => ({
        sourceFileId: sourceFile.id,
        referenceCount: sourceFile._count.skillRefs,
        materialRevisionId: sourceFile.materialRevisionId,
      })),
    );
    const orphanSourceFiles = sourceFiles.filter((sourceFile) =>
      orphanSourceFileIds.includes(sourceFile.id),
    );

    // V0 performs storage deletion while source rows are locked so a failed S3
    // delete can abort before user-visible DB rows are removed. If this becomes
    // high-volume, move it to a tombstone/outbox cleanup flow.
    const storedObjectDelete = await deleteStoredSourceObjects({
      sourceFiles: orphanSourceFiles,
      deleteStoredObject: input.deleteStoredObject,
    });

    if (storedObjectDelete.status === "failed") {
      return {
        status: "not-deleted",
        reason: "storage-delete-failed",
        message: storedObjectDelete.message,
      };
    }

    const deletedSkill = await tx.skill.deleteMany({
      where: {
        id: input.skillId,
        userId: input.userId,
        status: skill.status,
      },
    });

    if (deletedSkill.count !== 1) {
      return {
        status: "not-found",
        message: "Skill was not found.",
      };
    }

    if (orphanSourceFileIds.length > 0) {
      await tx.sourceFile.deleteMany({
        where: {
          id: {
            in: orphanSourceFileIds,
          },
          userId: input.userId,
          skillRefs: {
            none: {},
          },
        },
      });
    }

    return {
      status: "deleted",
      message: "Skill permanently deleted.",
      skillId: skill.id,
      deletedSourceFileIds: orphanSourceFileIds,
    };
  });
}

function isDeletableSkillStatus(status: SkillStatus): status is (typeof DELETABLE_SKILL_STATUSES)[number] {
  return DELETABLE_SKILL_STATUSES.some((deletableStatus) => deletableStatus === status);
}

async function getLockedSourceFiles({
  prisma,
  userId,
  sourceFileIds,
}: {
  prisma: Prisma.TransactionClient;
  userId: string;
  sourceFileIds: string[];
}): Promise<DeletableSourceFile[]> {
  if (sourceFileIds.length === 0) {
    return [];
  }

  await prisma.$queryRaw`
    SELECT "id"
    FROM "source_files"
    WHERE "userId" = ${userId} AND "id" IN (${Prisma.join(sourceFileIds)})
    FOR UPDATE
  `;

  return prisma.sourceFile.findMany({
    where: {
      id: {
        in: sourceFileIds,
      },
      userId,
    },
    select: {
      id: true,
      materialRevisionId: true,
      storageBucket: true,
      storageKey: true,
      _count: {
        select: {
          skillRefs: true,
        },
      },
    },
  });
}

async function deleteStoredSourceObjects({
  sourceFiles,
  deleteStoredObject,
}: {
  sourceFiles: DeletableSourceFile[];
  deleteStoredObject?: DeleteStoredSourceObject;
}): Promise<
  | {
      status: "deleted";
    }
  | {
      status: "failed";
      message: string;
    }
> {
  for (const sourceFile of sourceFiles) {
    if (!sourceFile.storageBucket || !sourceFile.storageKey) {
      continue;
    }

    const deleted = await deleteStoredSourceObject({
      sourceFile,
      deleteStoredObject,
    });

    if (deleted.status === "failed") {
      return deleted;
    }
  }

  return {
    status: "deleted",
  };
}

async function deleteStoredSourceObject({
  sourceFile,
  deleteStoredObject,
}: {
  sourceFile: Pick<SourceFile, "storageBucket" | "storageKey">;
  deleteStoredObject?: DeleteStoredSourceObject;
}): Promise<
  | {
      status: "deleted";
    }
  | {
      status: "failed";
      message: string;
    }
> {
  if (!sourceFile.storageBucket || !sourceFile.storageKey) {
    return {
      status: "deleted",
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
      status: "deleted",
    };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "Could not delete stored source object.",
    };
  }
}
