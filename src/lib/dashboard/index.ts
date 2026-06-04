import "server-only";

import {
  AnswerKind,
  ExerciseAttemptResult,
  ExerciseVerificationStatus,
  SkillStatus,
  type CollectionStatus,
  type Prisma,
  type SkillFsrsState,
} from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";

const RECENT_WINDOW_DAYS = 14;

export type DashboardCollectionSummary = {
  id: string;
  name: string;
  status: CollectionStatus;
  activeSkillCount: number;
  readyNowCount: number;
};

export type DashboardSkillSummary = {
  id: string;
  title: string;
  collectionName: string | null;
  tags: string[];
  fsrsState: SkillFsrsState;
  repetitions: number;
  lapses: number;
  dueAt: Date | null;
  isReadyNow: boolean;
  dueLabel: string;
};

export type DashboardHome = {
  readyNowCount: number;
  activeSkillCount: number;
  recentReviewCount: number;
  recentAccuracyPercent: number | null;
  collections: DashboardCollectionSummary[];
  skills: DashboardSkillSummary[];
};

export type GetDashboardHomeInput = {
  userId: string;
  now: Date;
};

type DashboardSkillRecord = {
  id: string;
  collectionId: string | null;
  title: string;
  tags: string[];
  status: SkillStatus;
  dueAt: Date | null;
  stability: number | null;
  difficulty: number | null;
  fsrsState: SkillFsrsState;
  repetitions: number;
  lapses: number;
  collection: {
    id: string;
    name: string;
  } | null;
  exercises: Array<{
    answerKind: AnswerKind;
    verificationStatus: ExerciseVerificationStatus;
    retiredAt: Date | null;
    choices: Prisma.JsonValue | null;
  }>;
};

export async function getDashboardHome(input: GetDashboardHomeInput): Promise<DashboardHome> {
  const prisma = getPrisma();
  const recentSince = new Date(input.now.getTime() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [collections, activeSkills, recentAttempts] = await Promise.all([
    prisma.collection.findMany({
      where: {
        userId: input.userId,
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      select: {
        id: true,
        name: true,
        status: true,
      },
    }),
    prisma.skill.findMany({
      where: {
        userId: input.userId,
        status: SkillStatus.ACTIVE,
      },
      orderBy: [{ dueAt: "asc" }, { title: "asc" }, { id: "asc" }],
      select: {
        id: true,
        collectionId: true,
        title: true,
        tags: true,
        status: true,
        dueAt: true,
        stability: true,
        difficulty: true,
        fsrsState: true,
        repetitions: true,
        lapses: true,
        collection: {
          select: {
            id: true,
            name: true,
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
    }),
    prisma.exerciseAttempt.findMany({
      where: {
        userId: input.userId,
        createdAt: {
          gte: recentSince,
          lte: input.now,
        },
        result: {
          in: [ExerciseAttemptResult.CORRECT, ExerciseAttemptResult.INCORRECT],
        },
      },
      select: {
        result: true,
      },
    }),
  ]);

  const sortedActiveSkills = activeSkills.toSorted(compareDashboardSkills);
  const readySkillIds = new Set(
    sortedActiveSkills.filter((skill) => isReadyNow(skill, input.now)).map((skill) => skill.id),
  );
  const activeSkillCountByCollection = new Map<string, number>();
  const readySkillCountByCollection = new Map<string, number>();

  for (const skill of sortedActiveSkills) {
    if (!skill.collectionId) {
      continue;
    }

    activeSkillCountByCollection.set(
      skill.collectionId,
      (activeSkillCountByCollection.get(skill.collectionId) ?? 0) + 1,
    );

    if (readySkillIds.has(skill.id)) {
      readySkillCountByCollection.set(
        skill.collectionId,
        (readySkillCountByCollection.get(skill.collectionId) ?? 0) + 1,
      );
    }
  }

  const correctReviewCount = recentAttempts.filter(
    (attempt) => attempt.result === ExerciseAttemptResult.CORRECT,
  ).length;

  return {
    readyNowCount: readySkillIds.size,
    activeSkillCount: sortedActiveSkills.length,
    recentReviewCount: recentAttempts.length,
    recentAccuracyPercent:
      recentAttempts.length === 0
        ? null
        : Math.round((correctReviewCount / recentAttempts.length) * 100),
    collections: collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      status: collection.status,
      activeSkillCount: activeSkillCountByCollection.get(collection.id) ?? 0,
      readyNowCount: readySkillCountByCollection.get(collection.id) ?? 0,
    })),
    skills: sortedActiveSkills.map((skill) => ({
      id: skill.id,
      title: skill.title,
      collectionName: skill.collection?.name ?? null,
      tags: skill.tags,
      fsrsState: skill.fsrsState,
      repetitions: skill.repetitions,
      lapses: skill.lapses,
      dueAt: skill.dueAt,
      isReadyNow: readySkillIds.has(skill.id),
      dueLabel: getDueLabel(skill, input.now),
    })),
  };
}

function isReadyNow(skill: DashboardSkillRecord, now: Date): boolean {
  return (
    skill.status === SkillStatus.ACTIVE &&
    skill.dueAt !== null &&
    skill.dueAt.getTime() <= now.getTime() &&
    skill.stability !== null &&
    skill.difficulty !== null &&
    skill.exercises.some(
      (exercise) =>
        exercise.answerKind === AnswerKind.CHOICE &&
        exercise.verificationStatus === ExerciseVerificationStatus.VERIFIED &&
        exercise.retiredAt === null &&
        hasRenderableChoices(exercise.choices),
    )
  );
}

function getDueLabel(skill: DashboardSkillRecord, now: Date): string {
  if (!hasInitializedSchedule(skill)) {
    return "Not scheduled";
  }

  if (
    !skill.exercises.some(
      (exercise) =>
        exercise.answerKind === AnswerKind.CHOICE &&
        exercise.verificationStatus === ExerciseVerificationStatus.VERIFIED &&
        exercise.retiredAt === null &&
        hasRenderableChoices(exercise.choices),
    )
  ) {
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

function hasInitializedSchedule(skill: DashboardSkillRecord): boolean {
  return skill.dueAt !== null && skill.stability !== null && skill.difficulty !== null;
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

function compareDashboardSkills(left: DashboardSkillRecord, right: DashboardSkillRecord): number {
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
