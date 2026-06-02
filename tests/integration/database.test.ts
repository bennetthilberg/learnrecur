import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AnswerKind,
  ExerciseAttemptResult,
  ExerciseType,
  ExerciseVerificationStatus,
  SkillFsrsState,
  SkillStatus,
  SourceFileKind,
  SourceFileStatus,
} from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import { ensureDatabaseUser } from "@/lib/users";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `test_${randomUUID()}`;

describeDatabase("database integration", () => {
  const prisma = getPrisma();
  const ownedUserIds: string[] = [];

  async function cleanupUser(userId: string) {
    await prisma.user.deleteMany({
      where: { id: userId },
    });
  }

  function makeUserId(label: string) {
    const userId = `${runId}_${label}`;
    ownedUserIds.push(userId);
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

  it("lazily mirrors a Clerk user and updates the same row on later visits", async () => {
    const userId = makeUserId("mirror");
    await cleanupUser(userId);

    const first = await ensureDatabaseUser(
      {
        id: userId,
        fullName: "First Name",
        imageUrl: "https://example.com/first.png",
        primaryEmailAddress: { emailAddress: "first@example.com" },
      },
      { skipEnvCheck: true },
    );

    expect(first).toMatchObject({
      status: "ready",
      user: {
        id: userId,
        email: "first@example.com",
        name: "First Name",
      },
    });

    const second = await ensureDatabaseUser(
      {
        id: userId,
        fullName: "Second Name",
        imageUrl: "https://example.com/second.png",
        primaryEmailAddress: { emailAddress: "second@example.com" },
      },
      { skipEnvCheck: true },
    );

    expect(second).toMatchObject({
      status: "ready",
      user: {
        id: userId,
        email: "second@example.com",
        name: "Second Name",
      },
    });

    const rows = await prisma.user.findMany({
      where: { id: userId },
      select: { email: true, imageUrl: true, name: true },
    });

    expect(rows).toEqual([
      {
        email: "second@example.com",
        imageUrl: "https://example.com/second.png",
        name: "Second Name",
      },
    ]);
  });

  it("stores the initial learning graph and deletes all owned records when a user is deleted", async () => {
    const userId = makeUserId("graph");
    await cleanupUser(userId);

    await prisma.user.create({
      data: {
        id: userId,
        email: "graph@example.com",
        name: "Graph Owner",
      },
    });

    const collection = await prisma.collection.create({
      data: {
        userId,
        name: "Calculus",
        description: "Limits, derivatives, and integrals",
      },
    });

    const sourceFile = await prisma.sourceFile.create({
      data: {
        userId,
        collectionId: collection.id,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.READY,
        originalName: "chapter-1.pdf",
        mimeType: "application/pdf",
        byteSize: 123_456,
        extractedText: "The derivative is the limit of the difference quotient.",
        metadata: {
          pageCount: 12,
          uploadedBy: "integration-test",
        },
      },
    });

    const dueAt = new Date("2026-06-01T12:00:00.000Z");
    const skill = await prisma.skill.create({
      data: {
        userId,
        collectionId: collection.id,
        title: "Differentiate a polynomial",
        objective: "Use the power rule accurately.",
        rules: {
          formula: "d/dx x^n = n*x^(n-1)",
        },
        examples: [
          {
            input: "x^3",
            output: "3x^2",
          },
        ],
        exerciseConstraints: {
          maxDegree: 5,
        },
        tags: ["calculus", "derivatives"],
        status: SkillStatus.ACTIVE,
        dueAt,
        stability: 2.5,
        difficulty: 4.1,
      },
    });

    const sourceRef = await prisma.skillSourceRef.create({
      data: {
        skillId: skill.id,
        sourceFileId: sourceFile.id,
        locator: {
          page: 3,
          quote: "power rule",
        },
        note: "Primary explanation",
      },
    });

    const exercise = await prisma.exercise.create({
      data: {
        userId,
        skillId: skill.id,
        type: ExerciseType.EXACT_INPUT,
        answerKind: AnswerKind.MATH,
        prompt: "Differentiate x^4.",
        answerSpec: {
          accepted: ["4x^3", "4*x^3"],
          normalizer: "symbolic-lite",
        },
        correctAnswerDisplay: "4x^3",
        explanation: "Apply the power rule.",
        difficulty: 2,
        expectedSeconds: 30,
        verificationStatus: ExerciseVerificationStatus.VERIFIED,
        sourceRefs: [{ skillSourceRefId: sourceRef.id }],
      },
    });

    await prisma.exerciseAttempt.create({
      data: {
        userId,
        skillId: skill.id,
        exerciseId: exercise.id,
        answer: {
          raw: "4x^3",
        },
        normalizedAnswer: "4*x^3",
        isCorrect: true,
        result: ExerciseAttemptResult.CORRECT,
        responseMs: 4_200,
        feedbackShownAt: new Date("2026-06-01T12:01:00.000Z"),
      },
    });

    await expect(
      prisma.skill.findUniqueOrThrow({
        where: { id: skill.id },
        include: {
          sourceRefs: true,
          exercises: {
            include: { attempts: true },
          },
        },
      }),
    ).resolves.toMatchObject({
      id: skill.id,
      fsrsState: SkillFsrsState.NEW,
      elapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
      repetitions: 0,
      lapses: 0,
      sourceRefs: [{ id: sourceRef.id }],
      exercises: [
        {
          id: exercise.id,
          answerSpec: {
            accepted: ["4x^3", "4*x^3"],
            normalizer: "symbolic-lite",
          },
          attempts: [
            {
              isCorrect: true,
              normalizedAnswer: "4*x^3",
            },
          ],
        },
      ],
    });

    await prisma.user.delete({
      where: { id: userId },
    });

    await expect(
      Promise.all([
        prisma.collection.count({ where: { userId } }),
        prisma.sourceFile.count({ where: { userId } }),
        prisma.skill.count({ where: { userId } }),
        prisma.exercise.count({ where: { userId } }),
        prisma.exerciseAttempt.count({ where: { userId } }),
        prisma.skillSourceRef.count({ where: { id: sourceRef.id } }),
      ]),
    ).resolves.toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("prevents duplicate links between the same skill and source file", async () => {
    const userId = makeUserId("unique_ref");
    await cleanupUser(userId);

    await prisma.user.create({
      data: {
        id: userId,
        email: "unique-ref@example.com",
      },
    });

    const sourceFile = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.READY,
        originalName: "source.txt",
      },
    });

    const skill = await prisma.skill.create({
      data: {
        userId,
        title: "Recall a source-backed fact",
      },
    });

    await prisma.skillSourceRef.create({
      data: {
        skillId: skill.id,
        sourceFileId: sourceFile.id,
      },
    });

    await expect(
      prisma.skillSourceRef.create({
        data: {
          skillId: skill.id,
          sourceFileId: sourceFile.id,
        },
      }),
    ).rejects.toThrow();
  });
});
