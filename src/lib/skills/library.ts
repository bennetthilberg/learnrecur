import "server-only";

import {
  AnswerKind,
  ExerciseVerificationStatus,
  GenerationJobStatus,
  SkillStatus,
  SourceFileKind,
  SourceFileStatus,
  type Prisma,
  type SkillFsrsState,
} from "@/generated/prisma/client";
import { isPracticeReadModelExerciseReady } from "@/lib/practice/read-model-eligibility";
import { getPrisma } from "@/lib/prisma";

export type SkillsLibraryGenerationJobSummary = {
  id: string;
  status: GenerationJobStatus;
  errorMessage: string | null;
  acceptedCount: number;
  rejectedCount: number;
  completedAt: Date | null;
  createdAt: Date;
};

export type SkillsLibraryDraftSkill = {
  id: string;
  title: string;
  objective: string | null;
  collectionName: string | null;
  tags: string[];
  sourceRefCount: number;
  updatedAt: Date;
  latestGenerationJob: SkillsLibraryGenerationJobSummary | null;
};

export type SkillsLibraryActiveSkill = {
  id: string;
  title: string;
  objective: string | null;
  collectionName: string | null;
  tags: string[];
  sourceRefCount: number;
  dueAt: Date | null;
  fsrsState: SkillFsrsState;
  repetitions: number;
  lapses: number;
  verifiedExerciseCount: number;
  retiredExerciseCount: number;
  readyExerciseCount: number;
  isReadyNow: boolean;
  dueLabel: string;
};

export type SkillsLibraryRecoverySkill = {
  id: string;
  title: string;
  objective: string | null;
  collectionName: string | null;
  tags: string[];
  status: Extract<SkillStatus, "PAUSED" | "ARCHIVED">;
  sourceRefCount: number;
  updatedAt: Date;
  dueAt: Date | null;
  fsrsState: SkillFsrsState;
  repetitions: number;
  verifiedExerciseCount: number;
  retiredExerciseCount: number;
  readyExerciseCount: number;
  dueLabel: string;
};

export type SkillsLibrarySourceProcessingSummary = {
  id: string;
  originalName: string;
  kind: SourceFileKind;
  status: Extract<SourceFileStatus, "UPLOADED" | "PROCESSING" | "FAILED">;
  byteSize: number | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SkillsLibrary = {
  draftSkills: SkillsLibraryDraftSkill[];
  activeSkills: SkillsLibraryActiveSkill[];
  recoverySkills: SkillsLibraryRecoverySkill[];
  sourceProcessing: SkillsLibrarySourceProcessingSummary[];
};

export type GetSkillsLibraryInput = {
  userId: string;
  now: Date;
};

type SkillsLibrarySkillRecord = {
  id: string;
  title: string;
  objective: string | null;
  tags: string[];
  status: SkillStatus;
  dueAt: Date | null;
  stability: number | null;
  difficulty: number | null;
  fsrsState: SkillFsrsState;
  repetitions: number;
  lapses: number;
  updatedAt: Date;
  collection: {
    name: string;
  } | null;
  sourceRefs: Array<{
    id: string;
  }>;
  generationJobs: SkillsLibraryGenerationJobSummary[];
  exercises: Array<{
    answerKind: AnswerKind;
    verificationStatus: ExerciseVerificationStatus;
    retiredAt: Date | null;
    choices: Prisma.JsonValue | null;
    answerSpec: Prisma.JsonValue;
  }>;
};

export async function getSkillsLibrary(input: GetSkillsLibraryInput): Promise<SkillsLibrary> {
  const prisma = getPrisma();
  const [skills, sourceProcessingRows] = await Promise.all([
    prisma.skill.findMany({
      where: {
        userId: input.userId,
        status: {
          in: [SkillStatus.DRAFT, SkillStatus.ACTIVE, SkillStatus.PAUSED, SkillStatus.ARCHIVED],
        },
      },
      select: {
        id: true,
        title: true,
        objective: true,
        tags: true,
        status: true,
        dueAt: true,
        stability: true,
        difficulty: true,
        fsrsState: true,
        repetitions: true,
        lapses: true,
        updatedAt: true,
        collection: {
          select: {
            name: true,
          },
        },
        sourceRefs: {
          select: {
            id: true,
          },
        },
        generationJobs: {
          orderBy: [{ createdAt: "desc" }, { id: "asc" }],
          take: 1,
          select: {
            id: true,
            status: true,
            errorMessage: true,
            acceptedCount: true,
            rejectedCount: true,
            completedAt: true,
            createdAt: true,
          },
        },
        exercises: {
          select: {
            answerKind: true,
            verificationStatus: true,
            retiredAt: true,
            choices: true,
            answerSpec: true,
          },
        },
      },
    }),
    prisma.sourceFile.findMany({
      where: {
        userId: input.userId,
        status: {
          in: [SourceFileStatus.UPLOADED, SourceFileStatus.PROCESSING, SourceFileStatus.FAILED],
        },
        kind: {
          in: [SourceFileKind.IMAGE, SourceFileKind.PDF],
        },
      },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      select: {
        id: true,
        originalName: true,
        kind: true,
        status: true,
        byteSize: true,
        metadata: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
  ]);

  const sourceProcessing = sourceProcessingRows
    .filter(isSourceProcessingRecord)
    .map((sourceFile) => ({
      id: sourceFile.id,
      originalName: sourceFile.originalName,
      kind: sourceFile.kind,
      status: sourceFile.status,
      byteSize: sourceFile.byteSize,
      errorMessage: getMetadataString(sourceFile.metadata, "errorMessage"),
      createdAt: sourceFile.createdAt,
      updatedAt: sourceFile.updatedAt,
    }));

  const draftSkills = skills
    .filter((skill) => skill.status === SkillStatus.DRAFT)
    .map(toDraftSkillSummary)
    .toSorted(compareDraftSkills);
  const activeSkills = skills
    .filter((skill) => skill.status === SkillStatus.ACTIVE)
    .map((skill) => toActiveSkillSummary(skill, input.now))
    .toSorted(compareActiveSkills);
  const recoverySkills = skills
    .filter(isRecoverySkillRecord)
    .map((skill) => toRecoverySkillSummary(skill, input.now))
    .toSorted(compareRecoverySkills);

  return {
    draftSkills,
    activeSkills,
    recoverySkills,
    sourceProcessing,
  };
}

function isSourceProcessingRecord<T extends { status: SourceFileStatus }>(
  sourceFile: T,
): sourceFile is T & {
  status: Extract<SourceFileStatus, "UPLOADED" | "PROCESSING" | "FAILED">;
} {
  return (
    sourceFile.status === SourceFileStatus.UPLOADED ||
    sourceFile.status === SourceFileStatus.PROCESSING ||
    sourceFile.status === SourceFileStatus.FAILED
  );
}

function toDraftSkillSummary(skill: SkillsLibrarySkillRecord): SkillsLibraryDraftSkill {
  return {
    id: skill.id,
    title: skill.title,
    objective: skill.objective,
    collectionName: skill.collection?.name ?? null,
    tags: skill.tags,
    sourceRefCount: skill.sourceRefs.length,
    updatedAt: skill.updatedAt,
    latestGenerationJob: skill.generationJobs[0] ?? null,
  };
}

function toActiveSkillSummary(
  skill: SkillsLibrarySkillRecord,
  now: Date,
): SkillsLibraryActiveSkill {
  const readyExerciseCount = skill.exercises.filter((exercise) =>
    isPracticeEligibleExercise(skill, exercise),
  ).length;

  return {
    id: skill.id,
    title: skill.title,
    objective: skill.objective,
    collectionName: skill.collection?.name ?? null,
    tags: skill.tags,
    sourceRefCount: skill.sourceRefs.length,
    dueAt: skill.dueAt,
    fsrsState: skill.fsrsState,
    repetitions: skill.repetitions,
    lapses: skill.lapses,
    verifiedExerciseCount: skill.exercises.filter(
      (exercise) => exercise.verificationStatus === ExerciseVerificationStatus.VERIFIED,
    ).length,
    retiredExerciseCount: skill.exercises.filter((exercise) => exercise.retiredAt !== null).length,
    readyExerciseCount,
    isReadyNow: isReadyNow(skill, now, readyExerciseCount),
    dueLabel: getDueLabel(skill, now, readyExerciseCount),
  };
}

function toRecoverySkillSummary(
  skill: SkillsLibrarySkillRecord & { status: Extract<SkillStatus, "PAUSED" | "ARCHIVED"> },
  now: Date,
): SkillsLibraryRecoverySkill {
  const readyExerciseCount = skill.exercises.filter((exercise) =>
    isPracticeEligibleExercise(skill, exercise),
  ).length;

  return {
    id: skill.id,
    title: skill.title,
    objective: skill.objective,
    collectionName: skill.collection?.name ?? null,
    tags: skill.tags,
    status: skill.status,
    sourceRefCount: skill.sourceRefs.length,
    updatedAt: skill.updatedAt,
    dueAt: skill.dueAt,
    fsrsState: skill.fsrsState,
    repetitions: skill.repetitions,
    verifiedExerciseCount: skill.exercises.filter(
      (exercise) => exercise.verificationStatus === ExerciseVerificationStatus.VERIFIED,
    ).length,
    retiredExerciseCount: skill.exercises.filter((exercise) => exercise.retiredAt !== null).length,
    readyExerciseCount,
    dueLabel: getDueLabel(skill, now, readyExerciseCount),
  };
}

function isRecoverySkillRecord(
  skill: SkillsLibrarySkillRecord,
): skill is SkillsLibrarySkillRecord & { status: Extract<SkillStatus, "PAUSED" | "ARCHIVED"> } {
  return skill.status === SkillStatus.PAUSED || skill.status === SkillStatus.ARCHIVED;
}

function isReadyNow(
  skill: SkillsLibrarySkillRecord,
  now: Date,
  readyExerciseCount: number,
): boolean {
  return (
    skill.status === SkillStatus.ACTIVE &&
    skill.dueAt !== null &&
    skill.dueAt.getTime() <= now.getTime() &&
    hasInitializedSchedule(skill) &&
    readyExerciseCount > 0
  );
}

function getDueLabel(
  skill: SkillsLibrarySkillRecord,
  now: Date,
  readyExerciseCount: number,
): string {
  if (!hasInitializedSchedule(skill)) {
    return "Not scheduled";
  }

  if (readyExerciseCount === 0) {
    return "Not available in practice yet";
  }

  if (!skill.dueAt) {
    return "Not scheduled";
  }

  if (skill.dueAt.getTime() <= now.getTime()) {
    return "Due now";
  }

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (skill.dueAt.toDateString() === tomorrow.toDateString()) {
    return "Tomorrow";
  }

  return skill.dueAt.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

function hasInitializedSchedule(skill: SkillsLibrarySkillRecord): boolean {
  return skill.dueAt !== null && skill.stability !== null && skill.difficulty !== null;
}

function isPracticeEligibleExercise(
  skill: SkillsLibrarySkillRecord,
  exercise: SkillsLibrarySkillRecord["exercises"][number],
): boolean {
  return isPracticeReadModelExerciseReady(exercise, skill);
}

function compareDraftSkills(
  left: SkillsLibraryDraftSkill,
  right: SkillsLibraryDraftSkill,
): number {
  const updatedDifference = right.updatedAt.getTime() - left.updatedAt.getTime();

  if (updatedDifference !== 0) {
    return updatedDifference;
  }

  const titleDifference = left.title.localeCompare(right.title);

  if (titleDifference !== 0) {
    return titleDifference;
  }

  return left.id.localeCompare(right.id);
}

function compareActiveSkills(
  left: SkillsLibraryActiveSkill,
  right: SkillsLibraryActiveSkill,
): number {
  if (left.dueAt === null && right.dueAt !== null) {
    return 1;
  }

  if (left.dueAt !== null && right.dueAt === null) {
    return -1;
  }

  if (left.dueAt !== null && right.dueAt !== null) {
    const dueDifference = left.dueAt.getTime() - right.dueAt.getTime();

    if (dueDifference !== 0) {
      return dueDifference;
    }
  }

  const titleDifference = left.title.localeCompare(right.title);

  if (titleDifference !== 0) {
    return titleDifference;
  }

  return left.id.localeCompare(right.id);
}

function compareRecoverySkills(
  left: SkillsLibraryRecoverySkill,
  right: SkillsLibraryRecoverySkill,
): number {
  const statusDifference = getRecoveryStatusRank(left.status) - getRecoveryStatusRank(right.status);

  if (statusDifference !== 0) {
    return statusDifference;
  }

  const updatedDifference = right.updatedAt.getTime() - left.updatedAt.getTime();

  if (updatedDifference !== 0) {
    return updatedDifference;
  }

  const titleDifference = left.title.localeCompare(right.title);

  if (titleDifference !== 0) {
    return titleDifference;
  }

  return left.id.localeCompare(right.id);
}

function getRecoveryStatusRank(status: SkillsLibraryRecoverySkill["status"]): number {
  return status === SkillStatus.PAUSED ? 0 : 1;
}

function getMetadataString(metadata: Prisma.JsonValue | null, key: string): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}
