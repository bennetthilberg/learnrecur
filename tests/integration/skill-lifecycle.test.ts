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
import {
  archiveSkill,
  pauseSkill,
  restoreArchivedSkill,
  resumeSkill,
} from "@/lib/skills/lifecycle";
import { getPrisma } from "@/lib/prisma";
import { SCHEDULER_NAME, SCHEDULER_VERSION } from "@/lib/scheduling";

import {
  createChoiceExercise,
  createSkillFixture,
  createTextExercise,
} from "./test-helpers";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `skill_lifecycle_${randomUUID()}`;
const now = new Date("2026-06-05T12:00:00.000Z");

describeDatabase("skill lifecycle controls", () => {
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

  async function createCollection(userId: string) {
    return prisma.collection.create({
      data: {
        userId,
        name: "Lifecycle collection",
        status: CollectionStatus.ACTIVE,
      },
    });
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

  it("pauses, resumes, and archives an active skill without rewriting schedule or history", async () => {
    const userId = await createUser("preserve");
    const collection = await createCollection(userId);
    const skill = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "Lifecycle skill",
      status: SkillStatus.ACTIVE,
      dueAt: new Date("2026-06-04T09:00:00.000Z"),
      repetitions: 4,
      tags: ["lifecycle"],
    });
    const sourceFile = await prisma.sourceFile.create({
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
        sourceFileId: sourceFile.id,
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
        responseMs: 12_000,
        proposedRating: FsrsRating.GOOD,
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

    const before = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });

    expect(await pauseSkill({ userId, skillId: skill.id })).toMatchObject({
      status: "updated",
      previousStatus: SkillStatus.ACTIVE,
      skill: { status: SkillStatus.PAUSED },
    });
    expect(await resumeSkill({ userId, skillId: skill.id })).toMatchObject({
      status: "updated",
      previousStatus: SkillStatus.PAUSED,
      skill: { status: SkillStatus.ACTIVE },
    });
    expect(await archiveSkill({ userId, skillId: skill.id })).toMatchObject({
      status: "updated",
      previousStatus: SkillStatus.ACTIVE,
      skill: { status: SkillStatus.ARCHIVED },
    });

    const after = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect({
      dueAt: after.dueAt,
      stability: after.stability,
      difficulty: after.difficulty,
      repetitions: after.repetitions,
      lapses: after.lapses,
      fsrsState: after.fsrsState,
      collectionId: after.collectionId,
      tags: after.tags,
    }).toEqual({
      dueAt: before.dueAt,
      stability: before.stability,
      difficulty: before.difficulty,
      repetitions: before.repetitions,
      lapses: before.lapses,
      fsrsState: before.fsrsState,
      collectionId: before.collectionId,
      tags: before.tags,
    });

    await expect(
      Promise.all([
        prisma.skillSourceRef.count({ where: { skillId: skill.id } }),
        prisma.sourceFile.count({ where: { id: sourceFile.id } }),
        prisma.exercise.count({ where: { skillId: skill.id } }),
        prisma.exerciseAttempt.count({ where: { skillId: skill.id } }),
        prisma.reviewLog.count({ where: { skillId: skill.id } }),
        prisma.exerciseFlag.count({ where: { exerciseId: exercise.id } }),
        prisma.generationJob.count({ where: { skillId: skill.id } }),
      ]),
    ).resolves.toEqual([1, 1, 1, 1, 1, 1, 1]);
  });

  it("rejects invalid lifecycle transitions and cross-user access", async () => {
    const userId = await createUser("invalid");
    const otherUserId = await createUser("invalid_other");
    const draftSkill = await createSkillFixture(prisma, {
      userId,
      title: "Draft lifecycle skill",
      status: SkillStatus.DRAFT,
    });
    const activeSkill = await createSkillFixture(prisma, {
      userId,
      title: "Active lifecycle skill",
      status: SkillStatus.ACTIVE,
    });
    const archivedSkill = await createSkillFixture(prisma, {
      userId,
      title: "Archived lifecycle skill",
      status: SkillStatus.ARCHIVED,
    });

    await expect(pauseSkill({ userId, skillId: draftSkill.id })).resolves.toMatchObject({
      status: "invalid-transition",
      currentStatus: SkillStatus.DRAFT,
    });
    await expect(resumeSkill({ userId, skillId: activeSkill.id })).resolves.toMatchObject({
      status: "invalid-transition",
      currentStatus: SkillStatus.ACTIVE,
    });
    await expect(archiveSkill({ userId, skillId: archivedSkill.id })).resolves.toMatchObject({
      status: "invalid-transition",
      currentStatus: SkillStatus.ARCHIVED,
    });
    await expect(restoreArchivedSkill({ userId, skillId: activeSkill.id })).resolves.toMatchObject({
      status: "invalid-transition",
      currentStatus: SkillStatus.ACTIVE,
    });
    await expect(pauseSkill({ userId: otherUserId, skillId: activeSkill.id })).resolves.toMatchObject({
      status: "not-found",
    });

    await expect(
      prisma.skill.findMany({
        where: { id: { in: [draftSkill.id, activeSkill.id, archivedSkill.id] } },
        orderBy: { title: "asc" },
        select: { title: true, status: true },
      }),
    ).resolves.toEqual([
      { title: "Active lifecycle skill", status: SkillStatus.ACTIVE },
      { title: "Archived lifecycle skill", status: SkillStatus.ARCHIVED },
      { title: "Draft lifecycle skill", status: SkillStatus.DRAFT },
    ]);
  });

  it("restores archived skills to active only when they are scheduled and practice-compatible", async () => {
    const userId = await createUser("restore");

    const scheduledArchived = await createSkillFixture(prisma, {
      userId,
      title: "Scheduled archived skill",
      status: SkillStatus.ACTIVE,
    });
    await prisma.skill.update({
      where: { id: scheduledArchived.id },
      data: { status: SkillStatus.ARCHIVED },
    });
    await createChoiceExercise({ prisma, userId, skillId: scheduledArchived.id });

    const draftArchived = await createSkillFixture(prisma, {
      userId,
      title: "Draft archived skill",
      status: SkillStatus.ARCHIVED,
      initialized: false,
    });

    const exactLockedArchived = await createSkillFixture(prisma, {
      userId,
      title: "Locked exact archived skill",
      status: SkillStatus.ACTIVE,
      repetitions: 0,
    });
    await prisma.skill.update({
      where: { id: exactLockedArchived.id },
      data: { status: SkillStatus.ARCHIVED },
    });
    await createTextExercise(prisma, userId, exactLockedArchived.id);

    await expect(restoreArchivedSkill({ userId, skillId: scheduledArchived.id })).resolves.toMatchObject({
      status: "updated",
      previousStatus: SkillStatus.ARCHIVED,
      skill: { status: SkillStatus.ACTIVE },
    });
    await expect(restoreArchivedSkill({ userId, skillId: draftArchived.id })).resolves.toMatchObject({
      status: "updated",
      previousStatus: SkillStatus.ARCHIVED,
      skill: { status: SkillStatus.DRAFT },
    });
    await expect(
      restoreArchivedSkill({ userId, skillId: exactLockedArchived.id }),
    ).resolves.toMatchObject({
      status: "updated",
      previousStatus: SkillStatus.ARCHIVED,
      skill: { status: SkillStatus.DRAFT },
    });
  });
});
