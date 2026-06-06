import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CollectionStatus,
  ExerciseAttemptResult,
  ExerciseFlagReason,
  ExerciseFlagStatus,
  FsrsRating,
  GenerationJobKind,
  GenerationJobStatus,
  SkillStatus,
  SourceFileKind,
  SourceFileStatus,
} from "@/generated/prisma/client";
import { getCollectionsHome } from "@/lib/collections";
import {
  archiveCollection,
  createCollection,
  restoreCollection,
  updateCollection,
} from "@/lib/collections";
import { getDashboardHome } from "@/lib/dashboard";
import { getNextPracticeItem } from "@/lib/practice";
import { getPrisma } from "@/lib/prisma";
import { SCHEDULER_NAME, SCHEDULER_VERSION } from "@/lib/scheduling";

import {
  createChoiceExercise,
  createSkillFixture,
} from "./test-helpers";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `collections_${randomUUID()}`;
const now = new Date("2026-06-04T12:00:00.000Z");

describeDatabase("collections management", () => {
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
        email: `${label}@example.com`,
      },
    });
    return userId;
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

  it("returns user-owned collections with lifecycle, ready, and source counts", async () => {
    const userId = await createUser("home");
    const otherUserId = await createUser("home_other");
    const grammar = await prisma.collection.create({
      data: {
        userId,
        name: "Spanish grammar",
        description: "Practice from class notes.",
        status: CollectionStatus.ACTIVE,
      },
    });
    const archived = await prisma.collection.create({
      data: {
        userId,
        name: "Archived area",
        status: CollectionStatus.ARCHIVED,
      },
    });
    const otherCollection = await prisma.collection.create({
      data: {
        userId: otherUserId,
        name: "Other user",
      },
    });

    const activeReadySkill = await createSkillFixture(prisma, {
      userId,
      collectionId: grammar.id,
      title: "Ready grammar skill",
    });
    await createChoiceExercise({ prisma, userId, skillId: activeReadySkill.id });
    const futureSkill = await createSkillFixture(prisma, {
      userId,
      collectionId: grammar.id,
      title: "Future grammar skill",
      dueAt: new Date("2026-06-05T09:00:00.000Z"),
    });
    await createChoiceExercise({ prisma, userId, skillId: futureSkill.id });
    await createSkillFixture(prisma, {
      userId,
      collectionId: grammar.id,
      title: "Draft grammar skill",
      status: SkillStatus.DRAFT,
    });
    await createSkillFixture(prisma, {
      userId,
      collectionId: grammar.id,
      title: "Paused grammar skill",
      status: SkillStatus.PAUSED,
    });
    await createSkillFixture(prisma, {
      userId,
      collectionId: grammar.id,
      title: "Archived grammar skill",
      status: SkillStatus.ARCHIVED,
    });
    const archivedCollectionSkill = await createSkillFixture(prisma, {
      userId,
      collectionId: archived.id,
      title: "Ready archived collection skill",
    });
    await createChoiceExercise({ prisma, userId, skillId: archivedCollectionSkill.id });
    await prisma.sourceFile.createMany({
      data: [
        {
          userId,
          collectionId: grammar.id,
          kind: SourceFileKind.TEXT,
          status: SourceFileStatus.READY,
          originalName: "Grammar notes",
        },
        {
          userId,
          collectionId: grammar.id,
          kind: SourceFileKind.IMAGE,
          status: SourceFileStatus.READY,
          originalName: "Grammar worksheet",
        },
        {
          userId: otherUserId,
          collectionId: otherCollection.id,
          kind: SourceFileKind.TEXT,
          status: SourceFileStatus.READY,
          originalName: "Other notes",
        },
      ],
    });

    const home = await getCollectionsHome({ userId, now });

    expect(home.activeCollections).toHaveLength(1);
    expect(home.archivedCollections).toHaveLength(1);
    expect(home.activeCollections[0]).toMatchObject({
      id: grammar.id,
      name: "Spanish grammar",
      description: "Practice from class notes.",
      status: CollectionStatus.ACTIVE,
      skillCounts: {
        active: 2,
        draft: 1,
        paused: 1,
        archived: 1,
      },
      readyNowCount: 1,
      sourceCount: 2,
    });
    expect(home.archivedCollections[0]).toMatchObject({
      id: archived.id,
      status: CollectionStatus.ARCHIVED,
      skillCounts: {
        active: 1,
      },
      readyNowCount: 1,
    });
  });

  it("creates and updates collections with user ownership and active-name uniqueness", async () => {
    const userId = await createUser("write");
    const otherUserId = await createUser("write_other");
    const created = await createCollection({
      userId,
      input: {
        name: "  Spanish   grammar  ",
        description: "  Notes from class.  ",
      },
    });

    expect(created).toMatchObject({
      status: "created",
      collection: {
        userId,
        name: "Spanish grammar",
        description: "Notes from class.",
        status: CollectionStatus.ACTIVE,
      },
    });

    await expect(
      createCollection({
        userId,
        input: {
          name: "spanish grammar",
        },
      }),
    ).resolves.toMatchObject({
      status: "invalid",
      fieldErrors: {
        name: ["An active collection with this name already exists."],
      },
    });

    if (created.status !== "created") {
      throw new Error("Expected collection creation to succeed.");
    }

    await expect(
      updateCollection({
        userId: otherUserId,
        collectionId: created.collection.id,
        input: {
          name: "Cross-user rename",
        },
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "collection-not-found",
    });

    const updated = await updateCollection({
      userId,
      collectionId: created.collection.id,
      input: {
        name: "Spanish verbs",
        description: "Updated description.",
      },
    });

    expect(updated).toMatchObject({
      status: "updated",
      collection: {
        name: "Spanish verbs",
        description: "Updated description.",
      },
    });
  });

  it("archives and restores collections without mutating schedule or related records", async () => {
    const userId = await createUser("lifecycle");
    const collection = await prisma.collection.create({
      data: {
        userId,
        name: "Lifecycle collection",
        status: CollectionStatus.ACTIVE,
      },
    });
    const skill = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "Lifecycle skill",
      repetitions: 4,
      tags: ["collections"],
    });
    const source = await prisma.sourceFile.create({
      data: {
        userId,
        collectionId: collection.id,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.READY,
        originalName: "Lifecycle source",
        extractedText: "Small source text.",
      },
    });
    await prisma.skillSourceRef.create({
      data: {
        userId,
        skillId: skill.id,
        sourceFileId: source.id,
      },
    });
    const exercise = await createChoiceExercise({ prisma, userId, skillId: skill.id });
    const attempt = await prisma.exerciseAttempt.create({
      data: {
        userId,
        skillId: skill.id,
        exerciseId: exercise.id,
        answer: { selectedChoiceId: "right" },
        normalizedAnswer: "right",
        isCorrect: true,
        result: ExerciseAttemptResult.CORRECT,
        finalRating: FsrsRating.GOOD,
        createdAt: now,
      },
    });
    await prisma.reviewLog.create({
      data: {
        userId,
        skillId: skill.id,
        exerciseAttemptId: attempt.id,
        finalRating: FsrsRating.GOOD,
        reviewedAt: now,
        previousDueAt: skill.dueAt,
        nextDueAt: new Date("2026-06-07T09:00:00.000Z"),
        previousStability: skill.stability,
        nextStability: skill.stability,
        previousDifficulty: skill.difficulty,
        nextDifficulty: skill.difficulty,
        previousRepetitions: skill.repetitions,
        nextRepetitions: skill.repetitions + 1,
        schedulerName: SCHEDULER_NAME,
        schedulerVersion: SCHEDULER_VERSION,
        desiredRetention: 0.9,
        schedulerParameters: {},
      },
    });
    await prisma.exerciseFlag.create({
      data: {
        userId,
        exerciseId: exercise.id,
        reason: ExerciseFlagReason.UNCLEAR_PROMPT,
        status: ExerciseFlagStatus.RESOLVED,
      },
    });
    await prisma.generationJob.create({
      data: {
        userId,
        skillId: skill.id,
        kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
        status: GenerationJobStatus.SUCCEEDED,
        provider: "google",
        model: "test-gemini",
        promptVersion: "skill-mcq-v0",
        requestedCount: 5,
        acceptedCount: 3,
        rejectedCount: 2,
        completedAt: now,
      },
    });
    const beforeSkill = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });

    await expect(archiveCollection({ userId, collectionId: collection.id })).resolves.toMatchObject({
      status: "updated",
      previousStatus: CollectionStatus.ACTIVE,
      collection: {
        status: CollectionStatus.ARCHIVED,
      },
    });

    const archivedSkill = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(archivedSkill).toMatchObject({
      status: beforeSkill.status,
      dueAt: beforeSkill.dueAt,
      stability: beforeSkill.stability,
      difficulty: beforeSkill.difficulty,
      repetitions: beforeSkill.repetitions,
      collectionId: collection.id,
    });
    await expect(prisma.sourceFile.count({ where: { userId, collectionId: collection.id } })).resolves.toBe(1);
    await expect(prisma.skillSourceRef.count({ where: { userId, skillId: skill.id } })).resolves.toBe(1);
    await expect(prisma.exerciseAttempt.count({ where: { userId, skillId: skill.id } })).resolves.toBe(1);
    await expect(prisma.reviewLog.count({ where: { userId, skillId: skill.id } })).resolves.toBe(1);
    await expect(prisma.exerciseFlag.count({ where: { userId, exerciseId: exercise.id } })).resolves.toBe(1);
    await expect(prisma.generationJob.count({ where: { userId, skillId: skill.id } })).resolves.toBe(1);

    const dashboard = await getDashboardHome({ userId, now });
    expect(dashboard.collections).toEqual([]);
    expect(dashboard.skills).toEqual([
      expect.objectContaining({
        id: skill.id,
        collectionName: "Lifecycle collection",
        isReadyNow: true,
      }),
    ]);
    await expect(getNextPracticeItem({ userId, now })).resolves.toMatchObject({
      status: "ready",
      skill: {
        id: skill.id,
      },
    });

    await expect(restoreCollection({ userId, collectionId: collection.id })).resolves.toMatchObject({
      status: "updated",
      previousStatus: CollectionStatus.ARCHIVED,
      collection: {
        status: CollectionStatus.ACTIVE,
      },
    });
  });

  it("rejects cross-user lifecycle actions and restore name conflicts", async () => {
    const userId = await createUser("restore_conflict");
    const otherUserId = await createUser("restore_conflict_other");
    const active = await prisma.collection.create({
      data: {
        userId,
        name: "Spanish",
        status: CollectionStatus.ACTIVE,
      },
    });
    const archived = await prisma.collection.create({
      data: {
        userId,
        name: "SPANISH",
        status: CollectionStatus.ARCHIVED,
      },
    });

    await expect(archiveCollection({ userId: otherUserId, collectionId: active.id })).resolves.toMatchObject({
      status: "not-found",
      reason: "collection-not-found",
    });
    await expect(restoreCollection({ userId, collectionId: archived.id })).resolves.toMatchObject({
      status: "invalid",
      fieldErrors: {
        name: ["An active collection with this name already exists."],
      },
    });
  });
});
