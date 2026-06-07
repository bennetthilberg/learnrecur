import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ExerciseAttemptResult,
  FsrsRating,
  SkillFsrsState,
  SkillStatus,
} from "@/generated/prisma/client";
import {
  getPracticeHistory,
  getSkillPracticeHistory,
} from "@/lib/practice/history";
import { getPrisma } from "@/lib/prisma";

import {
  createChoiceExercise,
  createSkillFixture,
} from "./test-helpers";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `practice_history_${randomUUID()}`;
const now = new Date("2026-06-07T14:00:00.000Z");

describeDatabase("practice history read model", () => {
  const prisma = getPrisma();
  const ownedUserIds: string[] = [];

  function makeUserId(label: string) {
    const userId = `${runId}_${label}`;
    ownedUserIds.push(userId);
    return userId;
  }

  async function cleanupUser(userId: string) {
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  async function createUser(label: string) {
    const userId = makeUserId(label);
    await cleanupUser(userId);
    await prisma.user.create({
      data: {
        id: userId,
        email: `${label}-${runId}@example.com`,
      },
    });
    return userId;
  }

  async function createCollection(userId: string, name: string) {
    return prisma.collection.create({
      data: {
        userId,
        name,
      },
    });
  }

  async function createReviewedAttempt({
    collectionId,
    correctAnswerDisplay = "Right",
    finalRating = FsrsRating.GOOD,
    label,
    nextDueAt = new Date("2026-06-08T10:00:00.000Z"),
    nextState = SkillFsrsState.REVIEW,
    previousDueAt = new Date("2026-06-06T10:00:00.000Z"),
    previousState = SkillFsrsState.LEARNING,
    responseMs = 2200,
    result = ExerciseAttemptResult.CORRECT,
    reviewedAt,
    status = SkillStatus.ACTIVE,
    userId,
  }: {
    collectionId?: string | null;
    correctAnswerDisplay?: string;
    finalRating?: FsrsRating;
    label: string;
    nextDueAt?: Date | null;
    nextState?: SkillFsrsState | null;
    previousDueAt?: Date | null;
    previousState?: SkillFsrsState | null;
    responseMs?: number | null;
    result?: ExerciseAttemptResult;
    reviewedAt: Date;
    status?: SkillStatus;
    userId: string;
  }) {
    const skill = await createSkillFixture(prisma, {
      userId,
      collectionId,
      title: `History skill ${label}`,
      status,
    });
    const exercise = await createChoiceExercise({
      prisma,
      userId,
      skillId: skill.id,
      prompt: `Private prompt with source text ${label}`,
      correctChoiceId: "right",
    });
    await prisma.exercise.update({
      where: { id: exercise.id },
      data: { correctAnswerDisplay },
    });
    const attempt = await prisma.exerciseAttempt.create({
      data: {
        userId,
        skillId: skill.id,
        exerciseId: exercise.id,
        answer: `raw-secret-answer-${label}`,
        normalizedAnswer: result === ExerciseAttemptResult.CORRECT ? "right" : "wrong",
        isCorrect: result === ExerciseAttemptResult.CORRECT,
        result,
        responseMs,
        proposedRating: finalRating,
        finalRating,
        createdAt: reviewedAt,
      },
    });
    const reviewLog = await prisma.reviewLog.create({
      data: {
        userId,
        skillId: skill.id,
        exerciseAttemptId: attempt.id,
        finalRating,
        reviewedAt,
        previousDueAt,
        nextDueAt,
        previousStability: 1.4,
        nextStability: 2.1,
        previousDifficulty: 5.5,
        nextDifficulty: 4.9,
        previousElapsedDays: 0,
        nextElapsedDays: 1,
        previousScheduledDays: 0,
        nextScheduledDays: 2,
        previousLearningSteps: 0,
        nextLearningSteps: 0,
        previousRepetitions: 1,
        nextRepetitions: 2,
        previousLapses: 0,
        nextLapses: finalRating === FsrsRating.AGAIN ? 1 : 0,
        previousState,
        nextState,
        schedulerName: "ts-fsrs",
        schedulerVersion: "test",
        desiredRetention: 0.9,
        schedulerParameters: { source: "test" },
      },
    });

    return { attempt, exercise, reviewLog, skill };
  }

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    for (const userId of ownedUserIds.reverse()) {
      await cleanupUser(userId);
    }

    await prisma.$disconnect();
  });

  it("returns signed-in user review logs in stable newest-first order", async () => {
    const userId = await createUser("ordered");
    const collection = await createCollection(userId, "Spanish grammar");
    const older = await createReviewedAttempt({
      userId,
      collectionId: collection.id,
      label: "older",
      reviewedAt: new Date("2026-06-05T12:00:00.000Z"),
      finalRating: FsrsRating.HARD,
    });
    const newer = await createReviewedAttempt({
      userId,
      collectionId: collection.id,
      label: "newer",
      reviewedAt: new Date("2026-06-06T12:00:00.000Z"),
      finalRating: FsrsRating.EASY,
    });
    await createReviewedAttempt({
      userId,
      collectionId: collection.id,
      label: "same-time",
      reviewedAt: new Date("2026-06-06T12:00:00.000Z"),
      finalRating: FsrsRating.GOOD,
    });
    const otherUserId = await createUser("other");
    await createReviewedAttempt({
      userId: otherUserId,
      label: "other-user",
      reviewedAt: new Date("2026-06-07T12:00:00.000Z"),
    });

    const history = await getPracticeHistory({ userId, now, limit: 10 });

    expect(history.status).toBe("ready");
    if (history.status !== "ready") {
      throw new Error("expected ready history");
    }
    expect(history.reviews).toHaveLength(3);
    expect(history.reviews.map((review) => review.reviewedAt.getTime())).toEqual([
      new Date("2026-06-06T12:00:00.000Z").getTime(),
      new Date("2026-06-06T12:00:00.000Z").getTime(),
      new Date("2026-06-05T12:00:00.000Z").getTime(),
    ]);
    expect(history.reviews.map((review) => review.id).slice(0, 2)).toEqual(
      history.reviews
        .slice(0, 2)
        .map((review) => review.id)
        .toSorted(),
    );
    expect(history.reviews.some((review) => review.skillId === older.skill.id)).toBe(true);
    expect(history.reviews.some((review) => review.skillId === newer.skill.id)).toBe(true);
    expect(history.reviews.every((review) => review.collectionName === "Spanish grammar")).toBe(
      true,
    );
  });

  it("excludes skipped, non-committed, future, and cross-user attempts", async () => {
    const userId = await createUser("excluded");
    const valid = await createReviewedAttempt({
      userId,
      label: "valid",
      reviewedAt: new Date("2026-06-05T12:00:00.000Z"),
    });
    await createReviewedAttempt({
      userId,
      label: "skipped",
      reviewedAt: new Date("2026-06-05T13:00:00.000Z"),
      result: ExerciseAttemptResult.SKIPPED,
    });
    await createReviewedAttempt({
      userId,
      label: "future",
      reviewedAt: new Date("2026-06-08T12:00:00.000Z"),
    });
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Non committed skill",
    });
    const exercise = await createChoiceExercise({ prisma, userId, skillId: skill.id });
    await prisma.exerciseAttempt.create({
      data: {
        userId,
        skillId: skill.id,
        exerciseId: exercise.id,
        answer: "right",
        normalizedAnswer: "right",
        isCorrect: true,
        result: ExerciseAttemptResult.CORRECT,
        finalRating: FsrsRating.GOOD,
        createdAt: new Date("2026-06-05T14:00:00.000Z"),
      },
    });

    const history = await getPracticeHistory({ userId, now });

    expect(history.status).toBe("ready");
    if (history.status !== "ready") {
      throw new Error("expected ready history");
    }
    expect(history.reviews).toHaveLength(1);
    expect(history.reviews[0]?.id).toBe(valid.reviewLog.id);
  });

  it("includes archived and paused skill history without exposing raw answers or prompts", async () => {
    const userId = await createUser("privacy");
    await createReviewedAttempt({
      userId,
      label: "archived",
      reviewedAt: new Date("2026-06-05T12:00:00.000Z"),
      status: SkillStatus.ARCHIVED,
      finalRating: FsrsRating.AGAIN,
      result: ExerciseAttemptResult.INCORRECT,
      responseMs: 4600,
      correctAnswerDisplay: "Correct display only",
      previousState: SkillFsrsState.REVIEW,
      nextState: SkillFsrsState.RELEARNING,
    });
    await createReviewedAttempt({
      userId,
      label: "paused",
      reviewedAt: new Date("2026-06-04T12:00:00.000Z"),
      status: SkillStatus.PAUSED,
    });

    const history = await getPracticeHistory({ userId, now });

    expect(history.status).toBe("ready");
    if (history.status !== "ready") {
      throw new Error("expected ready history");
    }
    expect(history.reviews).toHaveLength(2);
    expect(history.reviews[0]).toMatchObject({
      answerKind: "CHOICE",
      correctAnswerDisplay: "Correct display only",
      finalRating: FsrsRating.AGAIN,
      result: ExerciseAttemptResult.INCORRECT,
      responseMs: 4600,
      previousState: SkillFsrsState.REVIEW,
      nextState: SkillFsrsState.RELEARNING,
    });
    const serialized = JSON.stringify(history.reviews);
    expect(serialized).not.toContain("raw-secret-answer");
    expect(serialized).not.toContain("Private prompt with source text");
    expect(serialized).not.toContain("answerSpec");
  });

  it("returns recent reviews for one user-owned skill", async () => {
    const userId = await createUser("skill");
    const target = await createReviewedAttempt({
      userId,
      label: "target",
      reviewedAt: new Date("2026-06-05T12:00:00.000Z"),
    });
    await createReviewedAttempt({
      userId,
      label: "other-skill",
      reviewedAt: new Date("2026-06-06T12:00:00.000Z"),
    });
    const otherUserId = await createUser("skill_other");

    const skillHistory = await getSkillPracticeHistory({
      userId,
      skillId: target.skill.id,
      now,
      limit: 5,
    });
    const crossUser = await getSkillPracticeHistory({
      userId: otherUserId,
      skillId: target.skill.id,
      now,
      limit: 5,
    });

    expect(skillHistory.status).toBe("ready");
    if (skillHistory.status !== "ready") {
      throw new Error("expected ready skill history");
    }
    expect(skillHistory.reviews).toHaveLength(1);
    expect(skillHistory.reviews[0]?.skillId).toBe(target.skill.id);
    expect(crossUser).toEqual({
      status: "not-found",
      message: "Skill not found.",
    });
  });
});
