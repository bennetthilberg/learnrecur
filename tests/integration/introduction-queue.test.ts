import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { getPrisma } from "@/lib/prisma";
import {
  getIntroductionQueuePage,
  updateIntroductionQueue,
} from "@/lib/practice/introduction-queue";
import { recordSkillIntroduction } from "@/lib/practice/daily-limit";
import { getNextPracticeItem, previewNextPracticeItem } from "@/lib/practice";
import { createChoiceExercise, createSkillFixture } from "./test-helpers";

const suite = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;

suite("persisted introduction queues", () => {
  const prisma = getPrisma();
  const userIds: string[] = [];
  const now = new Date("2026-09-19T15:00:00.000Z");

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("persists order, rejects stale and cross-account writes, and removes only introduced skills", async () => {
    const userId = `introduction_queue_${randomUUID()}`;
    const otherUserId = `introduction_queue_other_${randomUUID()}`;
    userIds.push(userId, otherUserId);
    await prisma.user.createMany({ data: [{ id: userId }, { id: otherUserId }] });
    const collection = await prisma.collection.create({ data: { userId, name: "Spanish sequence" } });
    const otherCollection = await prisma.collection.create({ data: { userId: otherUserId, name: "Other sequence" } });
    const first = await createSkillFixture(prisma, { userId, title: "First", collectionId: collection.id });
    const second = await createSkillFixture(prisma, { userId, title: "Second", collectionId: collection.id });
    const paused = await createSkillFixture(prisma, { userId, title: "Paused", collectionId: collection.id, status: "PAUSED" });
    const foreign = await createSkillFixture(prisma, { userId: otherUserId, title: "Foreign", collectionId: otherCollection.id });
    await createChoiceExercise({ prisma, userId, skillId: first.id });
    await createChoiceExercise({ prisma, userId, skillId: second.id });

    const initial = await prisma.$transaction((tx) =>
      getIntroductionQueuePage(tx, { userId, collectionId: collection.id, limit: 50 }),
    );
    expect(initial.items.map((item) => item.skillId)).toEqual([first.id, second.id, paused.id]);
    expect(initial.items.map((item) => item.status)).toEqual(["queued", "queued", "paused"]);
    expect(initial.introducedCount).toBe(0);

    const reordered = await prisma.$transaction((tx) =>
      updateIntroductionQueue(tx, {
        userId,
        collectionId: collection.id,
        expectedVersion: initial.version,
        skillIds: [second.id, first.id, paused.id],
      }),
    );
    expect(reordered.items.map((item) => item.skillId)).toEqual([second.id, first.id, paused.id]);

    await expect(
      prisma.$transaction((tx) =>
        updateIntroductionQueue(tx, {
          userId,
          collectionId: collection.id,
          expectedVersion: initial.version,
          skillIds: [first.id, second.id, paused.id],
        }),
      ),
    ).rejects.toMatchObject({ code: "stale_state" });

    await expect(
      prisma.$transaction((tx) =>
        updateIntroductionQueue(tx, {
          userId,
          collectionId: collection.id,
          expectedVersion: reordered.version,
          skillIds: [second.id, first.id, paused.id, foreign.id],
        }),
      ),
    ).rejects.toMatchObject({ code: "skill_not_found" });

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
      await recordSkillIntroduction(tx, userId, second.id, now);
    });
    const afterIntroduction = await prisma.$transaction((tx) =>
      getIntroductionQueuePage(tx, { userId, collectionId: collection.id, limit: 50 }),
    );
    expect(afterIntroduction.items.map((item) => item.skillId)).toEqual([first.id, paused.id]);
    expect(afterIntroduction.introducedCount).toBe(1);
    expect(await prisma.exerciseAttempt.count({ where: { userId } })).toBe(0);
    expect(await prisma.reviewLog.count({ where: { userId } })).toBe(0);
  });

  it("uses due introduced reviews before new queue entries and keeps previews read-only", async () => {
    const userId = `introduction_queue_practice_${randomUUID()}`;
    userIds.push(userId);
    await prisma.user.create({ data: { id: userId, dailyNewSkillLimit: 5 } });
    const collection = await prisma.collection.create({ data: { userId, name: "Practice order" } });
    const newSkill = await createSkillFixture(prisma, { userId, title: "New queue item", collectionId: collection.id });
    const reviewSkill = await createSkillFixture(prisma, {
      userId,
      title: "Due review",
      collectionId: collection.id,
      repetitions: 3,
      dueAt: now,
    });
    await prisma.skill.update({
      where: { id: reviewSkill.id },
      data: { firstIntroducedAt: new Date("2026-09-01T15:00:00.000Z"), lastReviewedAt: new Date("2026-09-01T15:00:00.000Z") },
    });
    const newExercise = await createChoiceExercise({ prisma, userId, skillId: newSkill.id });
    const reviewExercise = await createChoiceExercise({ prisma, userId, skillId: reviewSkill.id });

    const preview = await previewNextPracticeItem({ userId, now, collectionId: collection.id });
    expect(preview).toMatchObject({ status: "ready", skill: { id: reviewSkill.id }, exercise: { id: reviewExercise.id } });
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: newSkill.id } })).toMatchObject({
      firstIntroducedAt: null,
      repetitions: 0,
      lastReviewedAt: null,
    });
    expect(await prisma.exerciseAttempt.count({ where: { userId } })).toBe(0);

    await prisma.skill.update({ where: { id: reviewSkill.id }, data: { dueAt: new Date("2026-10-01T15:00:00.000Z") } });
    const next = await getNextPracticeItem({ userId, now, collectionId: collection.id });
    expect(next).toMatchObject({ status: "ready", skill: { id: newSkill.id }, exercise: { id: newExercise.id } });
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: newSkill.id } })).toMatchObject({
      firstIntroducedAt: now,
      repetitions: 0,
      lastReviewedAt: null,
    });
    expect(await prisma.exerciseAttempt.count({ where: { userId } })).toBe(0);
  });
});
