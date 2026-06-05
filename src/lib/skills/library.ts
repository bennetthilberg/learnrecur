import "server-only";

import {
  AnswerKind,
  ExerciseVerificationStatus,
  GenerationJobStatus,
  SkillStatus,
  type Prisma,
  type SkillFsrsState,
} from "@/generated/prisma/client";
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

export type SkillsLibrary = {
  draftSkills: SkillsLibraryDraftSkill[];
  activeSkills: SkillsLibraryActiveSkill[];
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
  }>;
};

export async function getSkillsLibrary(input: GetSkillsLibraryInput): Promise<SkillsLibrary> {
  const prisma = getPrisma();
  const skills = await prisma.skill.findMany({
    where: {
      userId: input.userId,
      status: {
        in: [SkillStatus.DRAFT, SkillStatus.ACTIVE],
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
        },
      },
    },
  });

  const draftSkills = skills
    .filter((skill) => skill.status === SkillStatus.DRAFT)
    .map(toDraftSkillSummary)
    .toSorted(compareDraftSkills);
  const activeSkills = skills
    .filter((skill) => skill.status === SkillStatus.ACTIVE)
    .map((skill) => toActiveSkillSummary(skill, input.now))
    .toSorted(compareActiveSkills);

  return {
    draftSkills,
    activeSkills,
  };
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
  const readyExerciseCount = skill.exercises.filter(isPracticeEligibleExercise).length;

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
  exercise: SkillsLibrarySkillRecord["exercises"][number],
): boolean {
  return (
    exercise.answerKind === AnswerKind.CHOICE &&
    exercise.verificationStatus === ExerciseVerificationStatus.VERIFIED &&
    exercise.retiredAt === null &&
    hasRenderableChoices(exercise.choices)
  );
}

function hasRenderableChoices(choices: Prisma.JsonValue | null): boolean {
  return (
    Array.isArray(choices) &&
    choices.length > 0 &&
    choices.every(
      (choice) =>
        typeof choice === "object" &&
        choice !== null &&
        !Array.isArray(choice) &&
        typeof choice.id === "string" &&
        typeof choice.label === "string",
    )
  );
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
