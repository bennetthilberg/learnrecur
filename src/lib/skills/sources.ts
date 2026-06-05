import "server-only";

import {
  type SourceFileKind,
  type SourceFileStatus,
} from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";

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

  return prisma.$transaction(async (tx) => {
    const sourceRef = await tx.skillSourceRef.findFirst({
      where: {
        id: input.sourceRefId,
        userId: input.userId,
        skillId: input.skillId,
      },
      select: {
        id: true,
        sourceFileId: true,
      },
    });

    if (!sourceRef) {
      return sourceNotFound("Source material was not found for this skill.");
    }

    await tx.skillSourceRef.delete({
      where: {
        id: sourceRef.id,
      },
    });

    const remainingRefCount = await tx.skillSourceRef.count({
      where: {
        userId: input.userId,
        sourceFileId: sourceRef.sourceFileId,
      },
    });

    let sourceFileDeleted = false;

    if (remainingRefCount === 0) {
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

function sourceNotFound(message: string): Extract<RemoveSkillSourceResult, { status: "not-found" }> {
  return {
    status: "not-found",
    reason: "source-not-found",
    message,
  };
}
