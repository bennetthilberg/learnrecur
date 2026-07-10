import "server-only";

import {
  MaterialCleanupStatus,
  MaterialRevisionStatus,
  SkillDraftBatchStatus,
  StudyMaterialKind,
  StudyMaterialStatus,
  type Prisma,
} from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";

export type CreateMaterialInput = {
  userId: string;
  collectionId?: string | null;
  title: string;
  kind: StudyMaterialKind;
  sourceUrl?: string | null;
};

export type RequestMaterialDeletionResult =
  | {
      status: "queued";
      materialId: string;
      cleanupJobId: string;
      alreadyQueued: boolean;
      previousState: MaterialDeletionPreviousState | null;
      message: string;
    }
  | {
      status: "not-found";
      message: string;
    }
  | {
      status: "not-deleted";
      reason: "title-mismatch";
      message: string;
    };

export type MaterialDeletionPreviousState = {
  status: StudyMaterialStatus;
  activeRevisionId: string | null;
  deletionRequestedAt: Date | null;
  revisions: Array<{ id: string; status: MaterialRevisionStatus }>;
};

export async function createMaterialWithInitialRevision(input: CreateMaterialInput) {
  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    const material = await tx.studyMaterial.create({
      data: {
        userId: input.userId,
        collectionId: input.collectionId ?? null,
        title: input.title.trim(),
        kind: input.kind,
      },
    });
    const revision = await tx.materialRevision.create({
      data: {
        userId: input.userId,
        materialId: material.id,
        revisionNumber: 1,
        sourceUrl: input.sourceUrl ?? null,
      },
    });

    return { material, revision };
  });
}

export async function createNextMaterialRevision(input: {
  userId: string;
  materialId: string;
  sourceUrl?: string | null;
}) {
  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "study_materials"
      WHERE "id" = ${input.materialId} AND "userId" = ${input.userId}
      FOR UPDATE
    `;

    const material = await tx.studyMaterial.findFirst({
      where: {
        id: input.materialId,
        userId: input.userId,
        status: { not: StudyMaterialStatus.DELETING },
      },
      select: {
        id: true,
        _count: { select: { revisions: true } },
      },
    });

    if (!material) {
      return null;
    }

    return tx.materialRevision.create({
      data: {
        userId: input.userId,
        materialId: material.id,
        revisionNumber: material._count.revisions + 1,
        sourceUrl: input.sourceUrl ?? null,
      },
    });
  });
}

export async function finalizeMaterialRevision(input: {
  userId: string;
  materialId: string;
  materialRevisionId: string;
  contentHash: string;
  byteSize: number;
  pageCount?: number | null;
  fetchedPageCount?: number | null;
  summary?: string | null;
  storageBucket: string;
  storageKey: string;
  processingMetadata?: Prisma.InputJsonValue;
}) {
  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "study_materials"
      WHERE "id" = ${input.materialId} AND "userId" = ${input.userId}
      FOR UPDATE
    `;

    const material = await tx.studyMaterial.findFirst({
      where: {
        id: input.materialId,
        userId: input.userId,
        status: { not: StudyMaterialStatus.DELETING },
      },
      select: {
        id: true,
        activeRevision: { select: { revisionNumber: true } },
      },
    });

    if (!material) {
      return null;
    }

    const revision = await tx.materialRevision.findFirst({
      where: {
        id: input.materialRevisionId,
        materialId: input.materialId,
        userId: input.userId,
      },
      select: { id: true, revisionNumber: true },
    });

    if (!revision) {
      return null;
    }

    const finalizedAt = new Date();
    const updatedRevision = await tx.materialRevision.update({
      where: { id: revision.id },
      data: {
        status: MaterialRevisionStatus.READY,
        contentHash: input.contentHash,
        byteSize: input.byteSize,
        pageCount: input.pageCount ?? null,
        fetchedPageCount: input.fetchedPageCount ?? null,
        summary: input.summary ?? null,
        storageBucket: input.storageBucket,
        storageKey: input.storageKey,
        processingMetadata: input.processingMetadata,
        errorCode: null,
        errorMessage: null,
        finalizedAt,
      },
    });

    if (
      !material.activeRevision ||
      revision.revisionNumber > material.activeRevision.revisionNumber
    ) {
      await tx.studyMaterial.update({
        where: { id: input.materialId },
        data: {
          activeRevisionId: revision.id,
          lastUsedAt: finalizedAt,
        },
      });
    }

    return updatedRevision;
  });
}

export async function createIdempotentDraftBatch(input: {
  userId: string;
  materialRevisionId: string;
  instruction: string;
  idempotencyKey: string;
}) {
  const prisma = getPrisma();
  const normalizedInstruction = input.instruction.trim();

  return prisma.$transaction(async (tx) => {
    const lockedMaterials = await tx.$queryRaw<Array<{ materialId: string }>>`
      SELECT material."id" AS "materialId"
      FROM "material_revisions" revision
      INNER JOIN "study_materials" material
        ON material."id" = revision."materialId"
       AND material."userId" = revision."userId"
      WHERE revision."id" = ${input.materialRevisionId}
        AND revision."userId" = ${input.userId}
      FOR UPDATE OF material
    `;

    if (lockedMaterials.length !== 1) {
      throw new Error("The requested material revision is unavailable.");
    }

    const revision = await tx.materialRevision.findFirst({
      where: {
        id: input.materialRevisionId,
        userId: input.userId,
        status: MaterialRevisionStatus.READY,
        material: { status: StudyMaterialStatus.ACTIVE },
      },
      select: { id: true },
    });

    if (!revision) {
      throw new Error("Skill batches require a ready material revision.");
    }

    const batch = await tx.skillDraftBatch.upsert({
      where: {
        userId_idempotencyKey: {
          userId: input.userId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      update: {},
      create: {
        userId: input.userId,
        materialRevisionId: input.materialRevisionId,
        instruction: normalizedInstruction,
        idempotencyKey: input.idempotencyKey,
        status: SkillDraftBatchStatus.PLANNING,
      },
    });

    if (
      batch.materialRevisionId !== input.materialRevisionId ||
      batch.instruction !== normalizedInstruction
    ) {
      throw new Error("This idempotency key was already used for a different material request.");
    }

    return batch;
  });
}

export async function requestMaterialDeletion(input: {
  userId: string;
  materialId: string;
  confirmationTitle: string;
}): Promise<RequestMaterialDeletionResult> {
  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "study_materials"
      WHERE "id" = ${input.materialId} AND "userId" = ${input.userId}
      FOR UPDATE
    `;

    const material = await tx.studyMaterial.findFirst({
      where: { id: input.materialId, userId: input.userId },
      select: {
        id: true,
        title: true,
        status: true,
        activeRevisionId: true,
        deletionRequestedAt: true,
        revisions: { select: { id: true, status: true } },
        cleanupJob: { select: { id: true } },
      },
    });

    if (!material) {
      return {
        status: "not-found",
        message: "Material was not found.",
      };
    }

    if (input.confirmationTitle.trim() !== material.title) {
      return {
        status: "not-deleted",
        reason: "title-mismatch",
        message: "Type the current material title exactly to confirm deletion.",
      };
    }

    const alreadyQueued = material.status === StudyMaterialStatus.DELETING;
    const previousState: MaterialDeletionPreviousState | null = alreadyQueued
      ? null
      : {
          status: material.status,
          activeRevisionId: material.activeRevisionId,
          deletionRequestedAt: material.deletionRequestedAt,
          revisions: material.revisions,
        };
    const requestedAt = new Date();

    if (!alreadyQueued) {
      await tx.studyMaterial.update({
        where: { id: material.id },
        data: {
          status: StudyMaterialStatus.DELETING,
          activeRevisionId: null,
          deletionRequestedAt: requestedAt,
        },
      });
      await tx.materialRevision.updateMany({
        where: { materialId: material.id, userId: input.userId },
        data: { status: MaterialRevisionStatus.DELETING },
      });
    }

    const cleanupJob = material.cleanupJob
      ? material.cleanupJob
      : await tx.materialCleanupJob.create({
          data: {
            userId: input.userId,
            materialId: material.id,
          },
          select: { id: true },
        });

    return {
      status: "queued",
      materialId: material.id,
      cleanupJobId: cleanupJob.id,
      alreadyQueued,
      previousState,
      message: alreadyQueued ? "Material deletion is already queued." : "Material deletion queued.",
    };
  });
}

export async function rollbackMaterialDeletionRequest(input: {
  userId: string;
  materialId: string;
  cleanupJobId: string;
  previousState: MaterialDeletionPreviousState;
}) {
  const prisma = getPrisma();

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id"
      FROM "study_materials"
      WHERE "id" = ${input.materialId} AND "userId" = ${input.userId}
      FOR UPDATE
    `;

    const material = await tx.studyMaterial.findFirst({
      where: {
        id: input.materialId,
        userId: input.userId,
        status: StudyMaterialStatus.DELETING,
        cleanupJob: {
          id: input.cleanupJobId,
          status: MaterialCleanupStatus.PENDING,
          attemptCount: 0,
        },
      },
      select: { id: true },
    });
    if (!material) {
      return false;
    }

    const deletedCleanupJob = await tx.materialCleanupJob.deleteMany({
      where: {
        id: input.cleanupJobId,
        materialId: input.materialId,
        userId: input.userId,
        status: MaterialCleanupStatus.PENDING,
        attemptCount: 0,
      },
    });
    if (deletedCleanupJob.count !== 1) {
      return false;
    }

    for (const revision of input.previousState.revisions) {
      await tx.materialRevision.updateMany({
        where: {
          id: revision.id,
          materialId: input.materialId,
          userId: input.userId,
          status: MaterialRevisionStatus.DELETING,
        },
        data: { status: revision.status },
      });
    }

    await tx.studyMaterial.update({
      where: { id: input.materialId },
      data: {
        status: input.previousState.status,
        activeRevisionId: input.previousState.activeRevisionId,
        deletionRequestedAt: input.previousState.deletionRequestedAt,
      },
    });

    return true;
  });
}
