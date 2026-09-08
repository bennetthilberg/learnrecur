import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ExerciseAttemptResult,
  ExerciseFlagReason,
  FsrsRating,
} from "@/generated/prisma/client";
import { getNeedsAttention } from "@/lib/practice/needs-attention";
import { getPrisma } from "@/lib/prisma";

import {
  createChoiceExercise,
  createSkillFixture,
} from "./test-helpers";

const suite = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;

suite("needs-attention persisted read model", () => {
  const prisma = getPrisma();
  const userId = `needs_attention_${randomUUID()}`;
  const otherUserId = `${userId}_other`;
  const now = new Date("2026-09-08T18:00:00.000Z");

  beforeAll(async () => {
    await prisma.user.createMany({ data: [{ id: userId }, { id: otherUserId }] });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  it("finds only persisted independent scheduled patterns and paginates across nonmatching skills", async () => {
    const repeated = await createSkillFixture(prisma, {
      userId,
      title: "Repeated recall",
      dueAt: new Date("2026-09-02T09:00:00.000Z"),
      repetitions: 5,
    });
    const assistedRecovery = await createSkillFixture(prisma, {
      userId,
      title: "Assisted recovery stays visible",
      dueAt: new Date("2026-09-03T09:00:00.000Z"),
      repetitions: 4,
    });
    const practiceOnlyNoise = await createSkillFixture(prisma, {
      userId,
      title: "Practice only does not recover",
      dueAt: new Date("2026-09-04T09:00:00.000Z"),
      repetitions: 4,
    });
    const correctedRecovery = await createSkillFixture(prisma, {
      userId,
      title: "Corrected evidence does not recover",
      dueAt: new Date("2026-09-05T09:00:00.000Z"),
      repetitions: 4,
    });
    const preparation = await createSkillFixture(prisma, {
      userId,
      title: "Preparation needs a retry",
      dueAt: new Date("2026-09-06T09:00:00.000Z"),
      repetitions: 1,
    });
    const lifetimeLapseOnly = await createSkillFixture(prisma, {
      userId,
      title: "Lifetime lapse only",
      dueAt: new Date("2026-09-01T09:00:00.000Z"),
      repetitions: 0,
      initialized: false,
    });
    await prisma.skill.update({
      where: { id: lifetimeLapseOnly.id },
      data: { lapses: 40 },
    });

    const otherSkill = await createSkillFixture(prisma, {
      userId: otherUserId,
      title: "Other learner repeated recall",
      dueAt: new Date("2026-09-07T09:00:00.000Z"),
      repetitions: 5,
    });

    await createPersistedReviews(prisma, userId, repeated.id, now, [
      { isCorrect: false },
      { isCorrect: true, finalRating: FsrsRating.GOOD },
      { isCorrect: false },
      { isCorrect: true, finalRating: FsrsRating.GOOD },
      { isCorrect: false },
    ]);
    await createPersistedReviews(prisma, userId, assistedRecovery.id, now, [
      { isCorrect: false },
      { isCorrect: false },
      { isCorrect: false },
      {
        isCorrect: true,
        finalRating: FsrsRating.GOOD,
        practiceContext: { assistance: "observed" },
      },
    ]);
    await createPersistedReviews(prisma, userId, practiceOnlyNoise.id, now, [
      { isCorrect: false },
      { isCorrect: false },
      { isCorrect: false },
      {
        isCorrect: true,
        finalRating: FsrsRating.GOOD,
        practiceContext: {
          sessionMode: "PRACTICE_ONLY",
          exposure: "PRACTICE_ONLY",
        },
      },
    ]);
    const correctedExercises = await createPersistedReviews(
      prisma,
      userId,
      correctedRecovery.id,
      now,
      [
        { isCorrect: false },
        { isCorrect: false },
        { isCorrect: false },
        { isCorrect: true, finalRating: FsrsRating.GOOD },
      ],
      { separateExercises: true },
    );
    await prisma.exerciseFlag.create({
      data: {
        userId,
        exerciseId: correctedExercises.at(-1)!.exerciseId,
        reason: ExerciseFlagReason.UNCLEAR_PROMPT,
        practiceEvidenceNeedsCorrection: true,
        evidenceCorrectionStatus: "PENDING",
      },
    });

    await createPersistedReviews(prisma, otherUserId, otherSkill.id, now, [
      { isCorrect: false },
      { isCorrect: false },
      { isCorrect: false },
    ]);

    const firstPage = await getNeedsAttention({ userId, now, limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.items[0]?.skillId).not.toBe(otherSkill.id);
    expect(firstPage.nextCursor).toBeTruthy();

    const pages = [firstPage.items];
    let cursor = firstPage.nextCursor;
    while (cursor) {
      const page = await getNeedsAttention({ userId, now, limit: 1, cursor });
      pages.push(page.items);
      cursor = page.nextCursor;
    }

    const items = pages.flat();
    const itemKeys = new Set(items.map((item) => `${item.kind}:${item.skillId}`));
    expect(itemKeys).toEqual(
      new Set([
        `repeated-misses:${repeated.id}`,
        `repeated-misses:${assistedRecovery.id}`,
        `repeated-misses:${practiceOnlyNoise.id}`,
        `repeated-misses:${correctedRecovery.id}`,
        `preparation:${preparation.id}`,
      ]),
    );
    expect(items.find((item) => item.skillId === assistedRecovery.id)?.reason).toContain(
      "3 misses in the last 3 independent scheduled reviews",
    );
    expect(items.find((item) => item.skillId === practiceOnlyNoise.id)?.reason).toContain(
      "3 misses in the last 3 independent scheduled reviews",
    );
    expect(items.find((item) => item.skillId === correctedRecovery.id)?.reason).toContain(
      "3 misses in the last 3 independent scheduled reviews",
    );
    expect(items.some((item) => item.skillId === lifetimeLapseOnly.id)).toBe(false);
    expect(items.some((item) => item.skillId === otherSkill.id)).toBe(false);
    expect(items.find((item) => item.skillId === preparation.id)).toMatchObject({
      kind: "preparation",
      reasonCode: "no-ready-exercises",
    });
  });

  it("does not classify a due skill with a verified usable exercise as preparation trouble", async () => {
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Ready due skill",
      dueAt: new Date("2026-09-07T09:00:00.000Z"),
      repetitions: 1,
    });
    await createChoiceExercise({ prisma, userId, skillId: skill.id });

    const result = await getNeedsAttention({ userId, now, limit: 50 });
    expect(result.items.some((item) => item.skillId === skill.id)).toBe(false);
  });

  it("filters findings by the requested owned collection", async () => {
    const firstCollection = await prisma.collection.create({
      data: { userId, name: "Needs attention first collection" },
    });
    const secondCollection = await prisma.collection.create({
      data: { userId, name: "Needs attention second collection" },
    });
    const included = await createSkillFixture(prisma, {
      userId,
      title: "Included collection finding",
      collectionId: firstCollection.id,
      dueAt: new Date("2026-09-07T09:00:00.000Z"),
      repetitions: 5,
    });
    const excluded = await createSkillFixture(prisma, {
      userId,
      title: "Excluded collection finding",
      collectionId: secondCollection.id,
      dueAt: new Date("2026-09-07T09:00:00.000Z"),
      repetitions: 5,
    });
    await createPersistedReviews(prisma, userId, included.id, now, [
      { isCorrect: false },
      { isCorrect: false },
      { isCorrect: false },
    ]);
    await createPersistedReviews(prisma, userId, excluded.id, now, [
      { isCorrect: false },
      { isCorrect: false },
      { isCorrect: false },
    ]);

    const result = await getNeedsAttention({
      userId,
      now,
      limit: 50,
      collectionId: firstCollection.id,
    });

    expect(result.items.some((item) => item.skillId === included.id)).toBe(true);
    expect(result.items.some((item) => item.skillId === excluded.id)).toBe(false);
  });
});

type PersistedReviewInput = {
  isCorrect: boolean;
  finalRating?: FsrsRating;
  practiceContext?: Record<string, unknown>;
};

async function createPersistedReviews(
  prisma: ReturnType<typeof getPrisma>,
  userId: string,
  skillId: string,
  now: Date,
  reviews: readonly PersistedReviewInput[],
  options: { separateExercises?: boolean } = {},
) {
  const sharedExercise = options.separateExercises
    ? null
    : await createChoiceExercise({ prisma, userId, skillId });
  const created: Array<{ exerciseId: string; reviewId: string }> = [];

  for (const [index, input] of reviews.entries()) {
    const reviewedAt = new Date(now.getTime() - (reviews.length - index) * 86_400_000);
    const exercise =
      sharedExercise ?? (await createChoiceExercise({ prisma, userId, skillId }));
    const attemptId = randomUUID();
    const reviewId = randomUUID();
    await prisma.exerciseAttempt.create({
      data: {
        id: attemptId,
        userId,
        skillId,
        exerciseId: exercise.id,
        answer: { choiceId: input.isCorrect ? "right" : "wrong" },
        isCorrect: input.isCorrect,
        result: input.isCorrect ? ExerciseAttemptResult.CORRECT : ExerciseAttemptResult.INCORRECT,
        finalRating: input.finalRating ?? FsrsRating.AGAIN,
        proposedRating: input.finalRating ?? FsrsRating.AGAIN,
        practiceContext: {
          version: 1,
          answerMode: "CHOICE",
          mixedReview: false,
          reducedRuleCues: false,
          assistance: "none",
          exposure: "SCHEDULED",
          sessionMode: "SCHEDULED",
          ...input.practiceContext,
        },
        answerPolicySnapshot: { kind: "choice", correctChoiceId: "right" },
        feedbackShownAt: reviewedAt,
        createdAt: reviewedAt,
      },
    });
    await prisma.reviewLog.create({
      data: {
        id: reviewId,
        userId,
        skillId,
        exerciseAttemptId: attemptId,
        finalRating: input.finalRating ?? FsrsRating.AGAIN,
        reviewedAt,
        previousDueAt: new Date(reviewedAt.getTime() - 3_600_000),
        nextDueAt: new Date(reviewedAt.getTime() + 86_400_000),
        schedulerName: "test",
        schedulerVersion: "test",
        desiredRetention: 0.9,
        schedulerParameters: {},
        createdAt: reviewedAt,
      },
    });
    created.push({ exerciseId: exercise.id, reviewId });
  }

  return created;
}
