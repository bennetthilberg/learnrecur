import { getDailyNewSkillAllowance } from "@/lib/practice/daily-limit";
import { countAvailablePracticeSkills, wasSkillIntroduced } from "@/lib/practice/daily-limit-contracts";
import "server-only";

import {
  AnswerKind,
  CollectionStatus,
  ExerciseAttemptResult,
  ExerciseVerificationStatus,
  SkillStatus,
  type Prisma,
  type SkillFsrsState,
} from "@/generated/prisma/client";
import { isPracticeReadModelExerciseReady } from "@/lib/practice/read-model-eligibility";
import { getPrisma } from "@/lib/prisma";

const RECENT_WINDOW_DAYS = 14;
const ACTIVITY_WINDOW_DAYS = 35;

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
  alreadyStudied?: boolean;
  lapses: number;
  dueAt: Date | null;
  stability: number | null;
  isReadyNow: boolean;
  dueLabel: string;
};

export type DashboardHome = {
  readyNowCount: number;
  activeSkillCount: number;
  recentReviewCount: number;
  recentAccuracyPercent: number | null;
  activityReviewCount: number;
  activityValues: number[];
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
  alreadyStudied?: boolean;
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
    answerSpec: Prisma.JsonValue;
  }>;
};

export async function getDashboardHome(input: GetDashboardHomeInput): Promise<DashboardHome> {
  const prisma = getPrisma();
  const recentSince = new Date(input.now.getTime() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const activitySince = startOfLocalDay(input.now);
  activitySince.setDate(activitySince.getDate() - (ACTIVITY_WINDOW_DAYS - 1));

  const [collections, activeSkills, activityAttempts, allowance] = await Promise.all([
    prisma.collection.findMany({
      where: {
        userId: input.userId,
        status: CollectionStatus.ACTIVE,
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
        firstIntroducedAt: true,
        lastReviewedAt: true,
        alreadyStudied: true,
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
            answerSpec: true,
          },
        },
      },
    }),
    prisma.exerciseAttempt.findMany({
      where: {
        userId: input.userId,
        createdAt: {
          gte: activitySince,
          lte: input.now,
        },
        result: {
          in: [ExerciseAttemptResult.CORRECT, ExerciseAttemptResult.INCORRECT],
        },
      },
      select: {
        createdAt: true,
        result: true,
      },
    }),
    getDailyNewSkillAllowance(prisma, input.userId, input.now),
  ]);

  const sortedActiveSkills = activeSkills.toSorted(compareDashboardSkills);
  const recentAttempts = activityAttempts.filter((attempt) => attempt.createdAt >= recentSince);
  const readySkillIds = new Set(
    sortedActiveSkills.filter((skill) => isReadyNow(skill, input.now) && (allowance.remaining !== 0 || wasSkillIntroduced(skill))).map((skill) => skill.id),
  );
  const activeSkillCountByCollection = new Map<string, number>();

  for (const skill of sortedActiveSkills) {
    if (!skill.collectionId) {
      continue;
    }

    activeSkillCountByCollection.set(
      skill.collectionId,
      (activeSkillCountByCollection.get(skill.collectionId) ?? 0) + 1,
    );
  }

  const correctReviewCount = recentAttempts.filter(
    (attempt) => attempt.result === ExerciseAttemptResult.CORRECT,
  ).length;

  return {
    readyNowCount: countAvailablePracticeSkills(sortedActiveSkills.filter(skill => readySkillIds.has(skill.id)), allowance.remaining),
    activeSkillCount: sortedActiveSkills.length,
    recentReviewCount: recentAttempts.length,
    recentAccuracyPercent:
      recentAttempts.length === 0
        ? null
        : Math.round((correctReviewCount / recentAttempts.length) * 100),
    activityReviewCount: activityAttempts.length,
    activityValues: buildActivityValues(activityAttempts, input.now),
    collections: collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      status: collection.status,
      activeSkillCount: activeSkillCountByCollection.get(collection.id) ?? 0,
      readyNowCount: countAvailablePracticeSkills(sortedActiveSkills.filter(skill => skill.collectionId === collection.id && readySkillIds.has(skill.id)), allowance.remaining),
    })),
    skills: sortedActiveSkills.map((skill) => ({
      id: skill.id,
      title: skill.title,
      collectionName: skill.collection?.name ?? null,
      tags: skill.tags,
      fsrsState: skill.fsrsState,
      repetitions: skill.repetitions,
    alreadyStudied: skill.alreadyStudied,
      lapses: skill.lapses,
      dueAt: skill.dueAt,
      stability: skill.stability,
      isReadyNow: readySkillIds.has(skill.id),
      dueLabel: allowance.remaining === 0 && !wasSkillIntroduced(skill) && isReadyNow(skill, input.now)
        ? "Daily limit reached"
        : getDueLabel(skill, input.now),
    })),
  };
}

function buildActivityValues(
  attempts: Array<{ createdAt: Date }>,
  now: Date,
): number[] {
  const start = startOfLocalDay(new Date(now));
  start.setDate(start.getDate() - (ACTIVITY_WINDOW_DAYS - 1));

  const counts = Array.from({ length: ACTIVITY_WINDOW_DAYS }, () => 0);

  for (const attempt of attempts) {
    const dayIndex = daysBetween(start, startOfLocalDay(attempt.createdAt));

    if (dayIndex >= 0 && dayIndex < counts.length) {
      counts[dayIndex] += 1;
    }
  }

  return counts.map((count) => Math.min(4, count));
}

function startOfLocalDay(date: Date): Date {
  const start = new Date(date);
  start.setHours(0, 0, 0, 0);
  return start;
}

function daysBetween(start: Date, end: Date): number {
  const millisecondsPerDay = 24 * 60 * 60 * 1000;
  const startUtc = Date.UTC(start.getFullYear(), start.getMonth(), start.getDate());
  const endUtc = Date.UTC(end.getFullYear(), end.getMonth(), end.getDate());

  return Math.floor((endUtc - startUtc) / millisecondsPerDay);
}

function isReadyNow(skill: DashboardSkillRecord, now: Date): boolean {
  return (
    skill.status === SkillStatus.ACTIVE &&
    skill.dueAt !== null &&
    skill.dueAt.getTime() <= now.getTime() &&
    skill.stability !== null &&
    skill.difficulty !== null &&
    skill.exercises.some((exercise) => isPracticeEligibleExercise(skill, exercise))
  );
}

function getDueLabel(skill: DashboardSkillRecord, now: Date): string {
  if (!hasInitializedSchedule(skill)) {
    return "Not scheduled";
  }

  if (!skill.exercises.some((exercise) => isPracticeEligibleExercise(skill, exercise))) {
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

function isPracticeEligibleExercise(
  skill: DashboardSkillRecord,
  exercise: DashboardSkillRecord["exercises"][number],
): boolean {
  return isPracticeReadModelExerciseReady(exercise, skill);
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
