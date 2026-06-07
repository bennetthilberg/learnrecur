import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AnswerKind,
  CollectionStatus,
  ExerciseAttemptResult,
  ExerciseFlagReason,
  ExerciseFlagStatus,
  ExerciseRetirementReason,
  FsrsRating,
  GenerationJobKind,
  GenerationJobStatus,
  ReminderSendStatus,
  SkillFsrsState,
  SourceFileKind,
  SourceFileStatus,
} from "@/generated/prisma/client";
import { getUserDataExport } from "@/lib/settings/data-export";
import { getPrisma } from "@/lib/prisma";

import {
  createChoiceExercise,
  createSkillFixture,
} from "./test-helpers";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `data_export_${randomUUID()}`;
const generatedAt = new Date("2026-06-07T14:00:00.000Z");

describeDatabase("study data export", () => {
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
        name: `User ${label}`,
        imageUrl: `https://images.example/${label}.png`,
        lastSeenAt: new Date("2026-06-01T08:00:00.000Z"),
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

  it("exports only user-owned study data with private storage fields stripped", async () => {
    const userId = await createUser("owner");
    const otherUserId = await createUser("other");

    const collectionB = await prisma.collection.create({
      data: {
        id: `${runId}_collection_b`,
        userId,
        name: "Spanish grammar",
        description: "Grammar topics.",
      },
    });
    const collectionA = await prisma.collection.create({
      data: {
        id: `${runId}_collection_a`,
        userId,
        name: "Math review",
        status: CollectionStatus.ARCHIVED,
      },
    });
    await prisma.collection.create({
      data: {
        id: `${runId}_collection_other`,
        userId: otherUserId,
        name: "Other user collection",
      },
    });

    const sourceFile = await prisma.sourceFile.create({
      data: {
        id: `${runId}_source_b`,
        userId,
        collectionId: collectionB.id,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.READY,
        originalName: "worksheet.pdf",
        mimeType: "application/pdf",
        byteSize: 2048,
        storageBucket: "private-export-bucket",
        storageKey: "source-uploads/private-key.pdf",
        publicUrl: "https://storage.example/private-key.pdf",
        extractedText: "Stored source text that belongs in the export.",
        metadata: {
          label: "Week 1 worksheet",
          focusNote: "Practice short examples.",
          objectKey: "source-uploads/private-key.pdf",
        },
      },
    });
    await prisma.sourceFile.create({
      data: {
        id: `${runId}_source_other`,
        userId: otherUserId,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.READY,
        originalName: "other-user.txt",
        extractedText: "Other user's private source text.",
      },
    });

    const skill = await createSkillFixture(prisma, {
      userId,
      collectionId: collectionB.id,
      title: "Ser vs estar",
      repetitions: 3,
      tags: ["spanish", "grammar"],
    });
    await prisma.skill.update({
      where: { id: skill.id },
      data: {
        rules: { items: ["Use ser for identity."] },
        examples: { items: ["Soy estudiante."] },
        exerciseConstraints: { style: "short classroom sentences" },
      },
    });
    await createSkillFixture(prisma, {
      userId: otherUserId,
      title: "Other user skill",
    });
    const deletedSkill = await createSkillFixture(prisma, {
      userId,
      title: "Deleted skill",
    });
    await prisma.skill.delete({ where: { id: deletedSkill.id } });

    const sourceRef = await prisma.skillSourceRef.create({
      data: {
        id: `${runId}_source_ref`,
        userId,
        skillId: skill.id,
        sourceFileId: sourceFile.id,
        locator: { page: 1 },
        note: "Main worksheet reference.",
      },
    });

    const exercise = await createChoiceExercise({
      prisma,
      userId,
      skillId: skill.id,
      prompt: "Choose the right verb.",
      correctChoiceId: "ser",
      choices: [
        { id: "ser", label: "ser" },
        { id: "estar", label: "estar" },
      ],
    });
    await prisma.exercise.update({
      where: { id: exercise.id },
      data: {
        explanation: "Identity uses ser.",
        difficulty: 2,
        expectedSeconds: 15,
        freshnessKey: "ser-vs-estar-1",
        sourceRefs: [{ sourceFileId: sourceFile.id }],
      },
    });

    const attempt = await prisma.exerciseAttempt.create({
      data: {
        id: `${runId}_attempt`,
        userId,
        skillId: skill.id,
        exerciseId: exercise.id,
        answer: { selectedChoiceId: "ser" },
        normalizedAnswer: "ser",
        isCorrect: true,
        result: ExerciseAttemptResult.CORRECT,
        responseMs: 1800,
        proposedRating: FsrsRating.EASY,
        finalRating: FsrsRating.EASY,
        feedbackShownAt: new Date("2026-06-05T10:00:05.000Z"),
        createdAt: new Date("2026-06-05T10:00:00.000Z"),
      },
    });
    const reviewLog = await prisma.reviewLog.create({
      data: {
        id: `${runId}_review_log`,
        userId,
        skillId: skill.id,
        exerciseAttemptId: attempt.id,
        finalRating: FsrsRating.EASY,
        reviewedAt: new Date("2026-06-05T10:00:10.000Z"),
        previousDueAt: new Date("2026-06-05T09:00:00.000Z"),
        nextDueAt: new Date("2026-06-08T09:00:00.000Z"),
        previousStability: 1,
        nextStability: 2,
        previousDifficulty: 5,
        nextDifficulty: 4,
        previousElapsedDays: 0,
        nextElapsedDays: 1,
        previousScheduledDays: 0,
        nextScheduledDays: 3,
        previousLearningSteps: 0,
        nextLearningSteps: 0,
        previousRepetitions: 2,
        nextRepetitions: 3,
        previousLapses: 0,
        nextLapses: 0,
        previousState: SkillFsrsState.LEARNING,
        nextState: SkillFsrsState.REVIEW,
        schedulerName: "ts-fsrs",
        schedulerVersion: "test",
        desiredRetention: 0.9,
        schedulerParameters: { source: "test" },
      },
    });
    const flag = await prisma.exerciseFlag.create({
      data: {
        id: `${runId}_flag`,
        userId,
        exerciseId: exercise.id,
        reason: ExerciseFlagReason.UNCLEAR_PROMPT,
        note: "The prompt was too brief.",
        status: ExerciseFlagStatus.RESOLVED,
        resolvedAt: new Date("2026-06-05T11:00:00.000Z"),
        resolutionNote: "Retired from practice.",
        retiredExerciseAt: new Date("2026-06-05T11:00:00.000Z"),
        retirementReason: ExerciseRetirementReason.FLAGGED_UNCLEAR,
      },
    });
    const generationJob = await prisma.generationJob.create({
      data: {
        id: `${runId}_generation_job`,
        userId,
        skillId: skill.id,
        kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
        status: GenerationJobStatus.SUCCEEDED,
        provider: "gemini",
        model: "gemini-3.5-flash",
        promptVersion: "test-v0",
        requestedCount: 3,
        acceptedCount: 3,
        rejectedCount: 0,
        completedAt: new Date("2026-06-04T12:00:00.000Z"),
      },
    });
    const reminderPreference = await prisma.reminderPreference.create({
      data: {
        userId,
        enabled: true,
        email: "owner@example.com",
        localHour: 9,
        timezone: "America/New_York",
        minimumDueCount: 1,
      },
    });
    const reminderSendLog = await prisma.reminderSendLog.create({
      data: {
        id: `${runId}_reminder_log`,
        userId,
        localDate: "2026-06-05",
        status: ReminderSendStatus.SENT,
        dueCount: 2,
        email: "owner@example.com",
        provider: "resend",
        providerMessageId: "email_123",
      },
    });

    const result = await getUserDataExport({ userId, generatedAt });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") {
      throw new Error("expected ready data export");
    }
    expect(result.export.exportVersion).toBe(1);
    expect(result.export.generatedAt).toBe("2026-06-07T14:00:00.000Z");
    expect(result.export.user).toMatchObject({
      id: userId,
      email: `${"owner"}-${runId}@example.com`,
      name: "User owner",
    });
    expect(result.export.collections.map((collection) => collection.id)).toEqual([
      collectionA.id,
      collectionB.id,
    ]);
    expect(result.export.sourceFiles).toHaveLength(1);
    expect(result.export.sourceFiles[0]).toMatchObject({
      id: sourceFile.id,
      extractedText: "Stored source text that belongs in the export.",
    });
    expect(result.export.skills.map((exportedSkill) => exportedSkill.id)).toContain(skill.id);
    expect(result.export.skills.map((exportedSkill) => exportedSkill.id)).not.toContain(
      deletedSkill.id,
    );
    expect(result.export.skillSourceRefs).toEqual([
      expect.objectContaining({
        id: sourceRef.id,
        skillId: skill.id,
        sourceFileId: sourceFile.id,
      }),
    ]);
    expect(result.export.exercises).toEqual([
      expect.objectContaining({
        id: exercise.id,
        answerKind: AnswerKind.CHOICE,
        prompt: "Choose the right verb.",
        correctAnswerDisplay: "ser",
      }),
    ]);
    expect(result.export.exerciseAttempts).toEqual([
      expect.objectContaining({
        id: attempt.id,
        answer: { selectedChoiceId: "ser" },
        finalRating: FsrsRating.EASY,
      }),
    ]);
    expect(result.export.reviewLogs).toEqual([
      expect.objectContaining({
        id: reviewLog.id,
        exerciseAttemptId: attempt.id,
        nextDueAt: "2026-06-08T09:00:00.000Z",
      }),
    ]);
    expect(result.export.exerciseFlags).toEqual([
      expect.objectContaining({
        id: flag.id,
        note: "The prompt was too brief.",
      }),
    ]);
    expect(result.export.generationJobs).toEqual([
      expect.objectContaining({
        id: generationJob.id,
        provider: "gemini",
        promptVersion: "test-v0",
      }),
    ]);
    expect(result.export.reminderPreference).toMatchObject({
      id: reminderPreference.id,
      email: "owner@example.com",
      enabled: true,
    });
    expect(result.export.reminderSendLogs).toEqual([
      expect.objectContaining({
        id: reminderSendLog.id,
        providerMessageId: "email_123",
      }),
    ]);

    const serialized = JSON.stringify(result.export);
    expect(serialized).toContain("Stored source text that belongs in the export.");
    expect(serialized).not.toContain("private-export-bucket");
    expect(serialized).not.toContain("source-uploads/private-key.pdf");
    expect(serialized).not.toContain("storage.example/private-key.pdf");
    expect(serialized).not.toContain("Other user's private source text.");
  });

  it("returns not-found when the user mirror row is missing", async () => {
    const result = await getUserDataExport({
      userId: `${runId}_missing`,
      generatedAt,
    });

    expect(result).toEqual({
      status: "not-found",
      message: "Sign in again before exporting data.",
    });
  });
});
