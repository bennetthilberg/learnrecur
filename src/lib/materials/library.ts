import "server-only";

import {
  MaterialRevisionStatus,
  StudyMaterialKind,
  StudyMaterialStatus,
} from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";

export type MaterialLibraryItem = {
  id: string;
  title: string;
  kind: StudyMaterialKind;
  status: StudyMaterialStatus;
  collectionName: string | null;
  revisionNumber: number;
  revisionStatus: MaterialRevisionStatus;
  pageCount: number | null;
  byteSize: number | null;
  linkedSkillCount: number;
  lastUsedAt: Date | null;
  updatedAt: Date;
};

export async function getMaterialLibrary(input: { userId: string }): Promise<MaterialLibraryItem[]> {
  const prisma = getPrisma();
  const materials = await prisma.studyMaterial.findMany({
    where: {
      userId: input.userId,
      status: { not: StudyMaterialStatus.DELETING },
      activeRevision: { is: { status: MaterialRevisionStatus.READY } },
    },
    orderBy: [{ lastUsedAt: "desc" }, { updatedAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      title: true,
      kind: true,
      status: true,
      lastUsedAt: true,
      updatedAt: true,
      collection: { select: { name: true } },
      activeRevision: {
        select: {
          revisionNumber: true,
          status: true,
          pageCount: true,
          fetchedPageCount: true,
          byteSize: true,
          sourceFiles: {
            select: { skillRefs: { select: { skillId: true } } },
          },
        },
      },
      revisions: {
        select: {
          sourceFiles: {
            select: { skillRefs: { select: { skillId: true } } },
          },
        },
      },
    },
  });

  return materials.flatMap((material) => {
    const revision = material.activeRevision;
    if (!revision) {
      return [];
    }
    const skillIds = new Set(
      material.revisions.flatMap((item) =>
        item.sourceFiles.flatMap((sourceFile) => sourceFile.skillRefs.map((ref) => ref.skillId)),
      ),
    );
    return [{
      id: material.id,
      title: material.title,
      kind: material.kind,
      status: material.status,
      collectionName: material.collection?.name ?? null,
      revisionNumber: revision.revisionNumber,
      revisionStatus: revision.status,
      pageCount: revision.pageCount ?? revision.fetchedPageCount ?? null,
      byteSize: revision.byteSize ?? null,
      linkedSkillCount: skillIds.size,
      lastUsedAt: material.lastUsedAt,
      updatedAt: material.updatedAt,
    }];
  });
}

export async function getMaterialDetail(input: { userId: string; materialId: string }) {
  const prisma = getPrisma();
  const material = await prisma.studyMaterial.findFirst({
    where: { id: input.materialId, userId: input.userId },
    select: {
      id: true,
      title: true,
      kind: true,
      status: true,
      activeRevisionId: true,
      lastUsedAt: true,
      createdAt: true,
      updatedAt: true,
      collection: { select: { name: true } },
      revisions: {
        orderBy: { revisionNumber: "desc" },
        select: {
          id: true,
          revisionNumber: true,
          status: true,
          sourceUrl: true,
          byteSize: true,
          pageCount: true,
          fetchedPageCount: true,
          summary: true,
          errorCode: true,
          errorMessage: true,
          finalizedAt: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { chunks: true, pages: true } },
          sections: {
            orderBy: { ordinal: "asc" },
            select: {
              id: true,
              parentId: true,
              ordinal: true,
              level: true,
              title: true,
              pageStart: true,
              pageEnd: true,
              url: true,
              anchor: true,
            },
          },
          sourceFiles: {
            select: {
              skillRefs: {
                orderBy: { createdAt: "asc" },
                select: {
                  skill: {
                    select: { id: true, title: true, objective: true, status: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!material) {
    return null;
  }

  const revisions = material.revisions.map((revision) => ({
    ...revision,
    linkedSkills: uniqueById(
      revision.sourceFiles.flatMap((sourceFile) => sourceFile.skillRefs.map((ref) => ref.skill)),
    ),
    sourceFiles: undefined,
  }));
  const activeRevision =
    revisions.find((revision) => revision.id === material.activeRevisionId) ?? revisions[0] ?? null;
  const currentRevision = revisions[0] ?? activeRevision;

  return {
    ...material,
    revisions,
    activeRevision,
    currentRevision,
  };
}

function uniqueById<T extends { id: string }>(values: T[]) {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}
