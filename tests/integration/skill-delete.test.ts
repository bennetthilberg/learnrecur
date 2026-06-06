import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
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
import { getDashboardHome } from "@/lib/dashboard";
import { getNextPracticeItem } from "@/lib/practice";
import { getPrisma } from "@/lib/prisma";
import { SCHEDULER_NAME, SCHEDULER_VERSION } from "@/lib/scheduling";
import { deleteSkillPermanently } from "@/lib/skills/delete";
import { getSkillsLibrary } from "@/lib/skills/library";

import { createChoiceExercise, createSkillFixture } from "./test-helpers";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `skill_delete_${randomUUID()}`;
const now = new Date("2026-06-06T15:00:00.000Z");

describeDatabase("skill permanent delete", () => {
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

  async function createTextSource(userId: string, originalName = "Delete source") {
    return prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.READY,
        originalName,
        extractedText: "Small source text for a skill that may be deleted.",
      },
    });
  }

  async function createUploadedSource(userId: string, key: string) {
    return prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.IMAGE,
        status: SourceFileStatus.READY,
        originalName: "uploaded-source.png",
        mimeType: "image/png",
        byteSize: 2048,
        storageBucket: "learnrecur-dev",
        storageKey: key,
        extractedText: "Uploaded source text.",
      },
    });
  }

  async function linkSource(userId: string, skillId: string, sourceFileId: string) {
    return prisma.skillSourceRef.create({
      data: {
        userId,
        skillId,
        sourceFileId,
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

  it("deletes a draft skill and its final-ref pasted source", async () => {
    const userId = await createUser("draft");
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Delete draft skill",
      status: SkillStatus.DRAFT,
    });
    const sourceFile = await createTextSource(userId);
    const sourceRef = await linkSource(userId, skill.id, sourceFile.id);

    await expect(
      deleteSkillPermanently({
        userId,
        skillId: skill.id,
        confirmationTitle: "  Delete draft skill  ",
      }),
    ).resolves.toMatchObject({
      status: "deleted",
      deletedSourceFileIds: [sourceFile.id],
    });

    await expect(
      Promise.all([
        prisma.skill.count({ where: { id: skill.id, userId } }),
        prisma.skillSourceRef.count({ where: { id: sourceRef.id, userId } }),
        prisma.sourceFile.count({ where: { id: sourceFile.id, userId } }),
      ]),
    ).resolves.toEqual([0, 0, 0]);
  });

  it("deletes an archived skill and cascades exercises, history, flags, and jobs", async () => {
    const userId = await createUser("archive");
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Delete archived skill",
      status: SkillStatus.ARCHIVED,
      initialized: false,
      repetitions: 5,
    });
    const sourceFile = await createTextSource(userId, "Archived source");
    await linkSource(userId, skill.id, sourceFile.id);
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
        responseMs: 10_000,
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
        previousRepetitions: 4,
        nextRepetitions: 5,
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
        reason: ExerciseFlagReason.NOT_USEFUL,
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

    await expect(
      deleteSkillPermanently({
        userId,
        skillId: skill.id,
        confirmationTitle: skill.title,
      }),
    ).resolves.toMatchObject({
      status: "deleted",
      deletedSourceFileIds: [sourceFile.id],
    });

    await expect(
      Promise.all([
        prisma.skill.count({ where: { id: skill.id, userId } }),
        prisma.exercise.count({ where: { id: exercise.id, userId } }),
        prisma.exerciseAttempt.count({ where: { id: attempt.id, userId } }),
        prisma.reviewLog.count({ where: { exerciseAttemptId: attempt.id, userId } }),
        prisma.exerciseFlag.count({ where: { exerciseId: exercise.id, userId } }),
        prisma.generationJob.count({ where: { skillId: skill.id, userId } }),
        prisma.sourceFile.count({ where: { id: sourceFile.id, userId } }),
      ]),
    ).resolves.toEqual([0, 0, 0, 0, 0, 0, 0]);
  });

  it("deletes the stored object for a final-ref uploaded source", async () => {
    const userId = await createUser("uploaded");
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Delete uploaded source skill",
      status: SkillStatus.DRAFT,
    });
    const sourceFile = await createUploadedSource(
      userId,
      `source-uploads/${userId}/uploaded-source.png`,
    );
    await linkSource(userId, skill.id, sourceFile.id);
    const deletedObjects: Array<{ bucketName: string; key: string }> = [];

    const result = await deleteSkillPermanently({
      userId,
      skillId: skill.id,
      confirmationTitle: skill.title,
      deleteStoredObject: async (object) => {
        deletedObjects.push(object);
      },
    });

    expect(result).toMatchObject({
      status: "deleted",
      deletedSourceFileIds: [sourceFile.id],
    });
    expect(deletedObjects).toEqual([
      {
        bucketName: "learnrecur-dev",
        key: `source-uploads/${userId}/uploaded-source.png`,
      },
    ]);
    await expect(prisma.sourceFile.count({ where: { id: sourceFile.id, userId } })).resolves.toBe(0);
  });

  it("keeps shared source files and stored objects when deleting one linked skill", async () => {
    const userId = await createUser("shared");
    const deletedSkill = await createSkillFixture(prisma, {
      userId,
      title: "Delete one shared source skill",
      status: SkillStatus.DRAFT,
    });
    const keptSkill = await createSkillFixture(prisma, {
      userId,
      title: "Keep shared source skill",
      status: SkillStatus.DRAFT,
    });
    const sourceFile = await createUploadedSource(
      userId,
      `source-uploads/${userId}/shared-source.png`,
    );
    await linkSource(userId, deletedSkill.id, sourceFile.id);
    await linkSource(userId, keptSkill.id, sourceFile.id);
    const deletedObjects: Array<{ bucketName: string; key: string }> = [];

    await expect(
      deleteSkillPermanently({
        userId,
        skillId: deletedSkill.id,
        confirmationTitle: deletedSkill.title,
        deleteStoredObject: async (object) => {
          deletedObjects.push(object);
        },
      }),
    ).resolves.toMatchObject({
      status: "deleted",
      deletedSourceFileIds: [],
    });

    expect(deletedObjects).toEqual([]);
    await expect(
      Promise.all([
        prisma.skill.count({ where: { id: deletedSkill.id, userId } }),
        prisma.skill.count({ where: { id: keptSkill.id, userId } }),
        prisma.sourceFile.count({ where: { id: sourceFile.id, userId } }),
        prisma.skillSourceRef.count({ where: { skillId: keptSkill.id, sourceFileId: sourceFile.id } }),
      ]),
    ).resolves.toEqual([0, 1, 1, 1]);
  });

  it("keeps rows intact when final-ref storage deletion fails", async () => {
    const userId = await createUser("storage_failure");
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Storage failure skill",
      status: SkillStatus.DRAFT,
    });
    const sourceFile = await createUploadedSource(
      userId,
      `source-uploads/${userId}/storage-failure.png`,
    );
    const sourceRef = await linkSource(userId, skill.id, sourceFile.id);

    await expect(
      deleteSkillPermanently({
        userId,
        skillId: skill.id,
        confirmationTitle: skill.title,
        deleteStoredObject: async () => {
          throw new Error("S3 delete failed");
        },
      }),
    ).resolves.toMatchObject({
      status: "not-deleted",
      reason: "storage-delete-failed",
    });

    await expect(
      Promise.all([
        prisma.skill.count({ where: { id: skill.id, userId } }),
        prisma.skillSourceRef.count({ where: { id: sourceRef.id, userId } }),
        prisma.sourceFile.count({ where: { id: sourceFile.id, userId } }),
      ]),
    ).resolves.toEqual([1, 1, 1]);
  });

  it("rejects title mismatches, active and paused skills, active jobs, and cross-user access", async () => {
    const userId = await createUser("reject");
    const otherUserId = await createUser("reject_other");
    const draftSkill = await createSkillFixture(prisma, {
      userId,
      title: "Exact title required",
      status: SkillStatus.DRAFT,
    });
    const activeSkill = await createSkillFixture(prisma, {
      userId,
      title: "Active delete blocked",
      status: SkillStatus.ACTIVE,
    });
    const pausedSkill = await createSkillFixture(prisma, {
      userId,
      title: "Paused delete blocked",
      status: SkillStatus.PAUSED,
      initialized: false,
    });
    const jobSkill = await createSkillFixture(prisma, {
      userId,
      title: "Job delete blocked",
      status: SkillStatus.DRAFT,
    });
    await prisma.generationJob.create({
      data: {
        userId,
        skillId: jobSkill.id,
        kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
        status: GenerationJobStatus.PENDING,
        provider: "google",
        model: "test-gemini",
        promptVersion: "skill-mcq-v0",
        requestedCount: 5,
      },
    });

    await expect(
      deleteSkillPermanently({
        userId,
        skillId: draftSkill.id,
        confirmationTitle: "Wrong title",
      }),
    ).resolves.toMatchObject({
      status: "not-deleted",
      reason: "title-mismatch",
    });
    await expect(
      deleteSkillPermanently({
        userId,
        skillId: activeSkill.id,
        confirmationTitle: activeSkill.title,
      }),
    ).resolves.toMatchObject({
      status: "not-deleted",
      reason: "invalid-transition",
      currentStatus: SkillStatus.ACTIVE,
    });
    await expect(
      deleteSkillPermanently({
        userId,
        skillId: pausedSkill.id,
        confirmationTitle: pausedSkill.title,
      }),
    ).resolves.toMatchObject({
      status: "not-deleted",
      reason: "invalid-transition",
      currentStatus: SkillStatus.PAUSED,
    });
    await expect(
      deleteSkillPermanently({
        userId,
        skillId: jobSkill.id,
        confirmationTitle: jobSkill.title,
      }),
    ).resolves.toMatchObject({
      status: "not-deleted",
      reason: "job-in-progress",
    });
    await expect(
      deleteSkillPermanently({
        userId: otherUserId,
        skillId: draftSkill.id,
        confirmationTitle: draftSkill.title,
      }),
    ).resolves.toMatchObject({
      status: "not-found",
    });

    await expect(
      Promise.all([
        prisma.skill.count({ where: { id: draftSkill.id, userId } }),
        prisma.skill.count({ where: { id: activeSkill.id, userId } }),
        prisma.skill.count({ where: { id: pausedSkill.id, userId } }),
        prisma.skill.count({ where: { id: jobSkill.id, userId } }),
      ]),
    ).resolves.toEqual([1, 1, 1, 1]);
  });

  it("removes deleted skills from library, dashboard, and practice read models", async () => {
    const userId = await createUser("read_models");
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Read model delete skill",
      status: SkillStatus.DRAFT,
    });
    const sourceFile = await createTextSource(userId, "Read model source");
    await linkSource(userId, skill.id, sourceFile.id);

    await expect(getSkillsLibrary({ userId, now })).resolves.toMatchObject({
      draftSkills: [expect.objectContaining({ id: skill.id })],
    });

    await deleteSkillPermanently({
      userId,
      skillId: skill.id,
      confirmationTitle: skill.title,
    });

    const [library, dashboard, practice] = await Promise.all([
      getSkillsLibrary({ userId, now }),
      getDashboardHome({ userId, now }),
      getNextPracticeItem({ userId, now }),
    ]);

    expect(library.draftSkills.some((librarySkill) => librarySkill.id === skill.id)).toBe(false);
    expect(library.sourceProcessing.some((source) => source.id === sourceFile.id)).toBe(false);
    expect(dashboard.activeSkillCount).toBe(0);
    expect(practice.status).toBe("none-due");
  });
});
