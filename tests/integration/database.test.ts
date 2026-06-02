import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AnswerKind,
  ExerciseAttemptResult,
  ExerciseFlagReason,
  ExerciseFlagStatus,
  ExerciseRetirementReason,
  ExerciseType,
  ExerciseVerificationStatus,
  FsrsRating,
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
        userId,
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

    const attempt = await prisma.exerciseAttempt.create({
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
        proposedRating: FsrsRating.EASY,
        finalRating: FsrsRating.GOOD,
        feedbackShownAt: new Date("2026-06-01T12:01:00.000Z"),
      },
    });

    const reviewLog = await prisma.reviewLog.create({
      data: {
        userId,
        skillId: skill.id,
        exerciseAttemptId: attempt.id,
        finalRating: FsrsRating.GOOD,
        reviewedAt: new Date("2026-06-01T12:02:00.000Z"),
        previousDueAt: dueAt,
        nextDueAt: new Date("2026-06-03T12:00:00.000Z"),
        previousStability: 2.5,
        nextStability: 3.2,
        previousDifficulty: 4.1,
        nextDifficulty: 3.9,
        previousElapsedDays: 0,
        nextElapsedDays: 2,
        previousScheduledDays: 0,
        nextScheduledDays: 2,
        previousLearningSteps: 0,
        nextLearningSteps: 0,
        previousRepetitions: 0,
        nextRepetitions: 1,
        previousLapses: 0,
        nextLapses: 0,
        previousState: SkillFsrsState.NEW,
        nextState: SkillFsrsState.REVIEW,
        schedulerName: "ts-fsrs",
        schedulerVersion: "5.x",
        desiredRetention: 0.9,
        schedulerParameters: {
          source: "default",
          weights: [0.1, 0.2, 0.3],
        },
      },
    });

    const flag = await prisma.exerciseFlag.create({
      data: {
        userId,
        exerciseId: exercise.id,
        reason: ExerciseFlagReason.UNCLEAR_PROMPT,
        note: "The wording needs a source reference.",
      },
    });

    await expect(
      prisma.skill.findUniqueOrThrow({
        where: { id: skill.id },
        include: {
          sourceRefs: true,
          exercises: {
            include: {
              attempts: { include: { reviewLog: true } },
              flags: true,
            },
          },
          reviewLogs: true,
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
      reviewLogs: [{ id: reviewLog.id, nextState: SkillFsrsState.REVIEW }],
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
              finalRating: FsrsRating.GOOD,
              reviewLog: {
                id: reviewLog.id,
                schedulerName: "ts-fsrs",
                schedulerVersion: "5.x",
              },
            },
          ],
          flags: [
            {
              id: flag.id,
              reason: ExerciseFlagReason.UNCLEAR_PROMPT,
              status: ExerciseFlagStatus.OPEN,
            },
          ],
        },
      ],
    });

    const parentCascadeExercise = await prisma.exercise.create({
      data: {
        userId,
        skillId: skill.id,
        type: ExerciseType.EXACT_INPUT,
        answerKind: AnswerKind.TEXT,
        prompt: "State the power rule in words.",
        answerSpec: {
          kind: "text",
          accepted: ["multiply by the exponent and reduce it by one"],
        },
        correctAnswerDisplay:
          "Multiply by the exponent and reduce it by one.",
      },
    });

    const parentCascadeAttempt = await prisma.exerciseAttempt.create({
      data: {
        userId,
        skillId: skill.id,
        exerciseId: parentCascadeExercise.id,
        answer: {
          raw: "multiply by the exponent and reduce it by one",
        },
        normalizedAnswer: "multiply by the exponent and reduce it by one",
        isCorrect: true,
        result: ExerciseAttemptResult.CORRECT,
        finalRating: FsrsRating.GOOD,
      },
    });

    const parentCascadeReviewLog = await prisma.reviewLog.create({
      data: {
        userId,
        skillId: skill.id,
        exerciseAttemptId: parentCascadeAttempt.id,
        finalRating: FsrsRating.GOOD,
        nextState: SkillFsrsState.REVIEW,
        schedulerName: "ts-fsrs",
        schedulerVersion: "5.x",
        desiredRetention: 0.9,
        schedulerParameters: { source: "default" },
      },
    });

    const parentCascadeFlag = await prisma.exerciseFlag.create({
      data: {
        userId,
        exerciseId: parentCascadeExercise.id,
        reason: ExerciseFlagReason.NOT_USEFUL,
        note: "Parent cascade check.",
      },
    });

    const exerciseCascadeAttempt = await prisma.exerciseAttempt.create({
      data: {
        userId,
        skillId: skill.id,
        exerciseId: parentCascadeExercise.id,
        answer: {
          raw: "power rule",
        },
        normalizedAnswer: "power rule",
        isCorrect: false,
        result: ExerciseAttemptResult.INCORRECT,
        finalRating: FsrsRating.HARD,
      },
    });

    const exerciseCascadeReviewLog = await prisma.reviewLog.create({
      data: {
        userId,
        skillId: skill.id,
        exerciseAttemptId: exerciseCascadeAttempt.id,
        finalRating: FsrsRating.HARD,
        nextState: SkillFsrsState.LEARNING,
        schedulerName: "ts-fsrs",
        schedulerVersion: "5.x",
        desiredRetention: 0.9,
        schedulerParameters: { source: "default" },
      },
    });

    await prisma.exerciseAttempt.delete({
      where: { id: parentCascadeAttempt.id },
    });

    await expect(
      Promise.all([
        prisma.exerciseAttempt.count({
          where: { id: parentCascadeAttempt.id },
        }),
        prisma.reviewLog.count({
          where: { id: parentCascadeReviewLog.id },
        }),
      ]),
    ).resolves.toEqual([0, 0]);

    await prisma.exercise.delete({
      where: { id: parentCascadeExercise.id },
    });

    await expect(
      Promise.all([
        prisma.exercise.count({
          where: { id: parentCascadeExercise.id },
        }),
        prisma.exerciseFlag.count({
          where: { id: parentCascadeFlag.id },
        }),
        prisma.exerciseAttempt.count({
          where: { id: exerciseCascadeAttempt.id },
        }),
        prisma.reviewLog.count({
          where: { id: exerciseCascadeReviewLog.id },
        }),
      ]),
    ).resolves.toEqual([0, 0, 0, 0]);

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
        prisma.reviewLog.count({ where: { userId } }),
        prisma.exerciseFlag.count({ where: { userId } }),
        prisma.skillSourceRef.count({ where: { id: sourceRef.id } }),
      ]),
    ).resolves.toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });

  it("supports the draft-to-active skill lifecycle without losing ownership or FSRS fields", async () => {
    const userId = makeUserId("draft_lifecycle");
    await cleanupUser(userId);

    await prisma.user.create({
      data: {
        id: userId,
        email: "draft@example.com",
      },
    });

    const draft = await prisma.skill.create({
      data: {
        userId,
        title: "Use ser for identity",
        objective: "Choose ser when describing stable identity.",
        tags: ["spanish", "grammar"],
      },
    });

    expect(draft).toMatchObject({
      userId,
      status: SkillStatus.DRAFT,
      fsrsState: SkillFsrsState.NEW,
      repetitions: 0,
      lapses: 0,
    });

    const activated = await prisma.skill.update({
      where: { id: draft.id },
      data: {
        status: SkillStatus.ACTIVE,
        dueAt: new Date("2026-06-04T14:00:00.000Z"),
        stability: 0.4,
        difficulty: 5.5,
      },
    });

    expect(activated).toMatchObject({
      id: draft.id,
      userId,
      status: SkillStatus.ACTIVE,
      tags: ["spanish", "grammar"],
      fsrsState: SkillFsrsState.NEW,
      stability: 0.4,
      difficulty: 5.5,
    });
  });

  it("keeps attempts and review logs when an exercise is retired after being flagged", async () => {
    const userId = makeUserId("retirement");
    await cleanupUser(userId);

    await prisma.user.create({
      data: { id: userId, email: "retirement@example.com" },
    });

    const skill = await prisma.skill.create({
      data: {
        userId,
        title: "Pick preterite endings",
        status: SkillStatus.ACTIVE,
      },
    });

    const retiredExercise = await prisma.exercise.create({
      data: {
        userId,
        skillId: skill.id,
        type: ExerciseType.MULTIPLE_CHOICE,
        answerKind: AnswerKind.CHOICE,
        prompt: "Choose the preterite yo ending for -ar verbs.",
        choices: [
          { id: "a", label: "-é" },
          { id: "b", label: "-aba" },
        ],
        answerSpec: {
          kind: "choice",
          correctChoiceId: "a",
        },
        correctAnswerDisplay: "-é",
        verificationStatus: ExerciseVerificationStatus.VERIFIED,
        retiredAt: new Date("2026-06-05T10:00:00.000Z"),
        retirementReason: ExerciseRetirementReason.FLAGGED_UNCLEAR,
      },
    });

    const readyExercise = await prisma.exercise.create({
      data: {
        userId,
        skillId: skill.id,
        type: ExerciseType.EXACT_INPUT,
        answerKind: AnswerKind.TEXT,
        prompt: "Write the preterite yo form of hablar.",
        answerSpec: {
          kind: "text",
          accepted: ["hablé"],
          normalizeCase: true,
          normalizeWhitespace: true,
          normalizeDiacritics: false,
        },
        correctAnswerDisplay: "hablé",
        verificationStatus: ExerciseVerificationStatus.VERIFIED,
      },
    });

    const attempt = await prisma.exerciseAttempt.create({
      data: {
        userId,
        skillId: skill.id,
        exerciseId: retiredExercise.id,
        answer: { selectedChoiceId: "b" },
        normalizedAnswer: "b",
        isCorrect: false,
        result: ExerciseAttemptResult.INCORRECT,
        finalRating: FsrsRating.AGAIN,
      },
    });

    const flag = await prisma.exerciseFlag.create({
      data: {
        userId,
        exerciseId: retiredExercise.id,
        reason: ExerciseFlagReason.UNCLEAR_PROMPT,
        note: "This confused imperfect and preterite examples.",
        status: ExerciseFlagStatus.RESOLVED,
        resolvedAt: new Date("2026-06-05T10:01:00.000Z"),
        resolutionNote: "Retired from practice.",
        retiredExerciseAt: new Date("2026-06-05T10:00:00.000Z"),
        retirementReason: ExerciseRetirementReason.FLAGGED_UNCLEAR,
      },
    });

    const reviewLog = await prisma.reviewLog.create({
      data: {
        userId,
        skillId: skill.id,
        exerciseAttemptId: attempt.id,
        finalRating: FsrsRating.AGAIN,
        reviewedAt: new Date("2026-06-05T10:02:00.000Z"),
        nextDueAt: new Date("2026-06-05T10:12:00.000Z"),
        nextElapsedDays: 0,
        nextScheduledDays: 0,
        nextState: SkillFsrsState.LEARNING,
        schedulerName: "ts-fsrs",
        schedulerVersion: "5.x",
        desiredRetention: 0.9,
        schedulerParameters: { source: "default" },
      },
    });

    await expect(
      prisma.exercise.findMany({
        where: {
          userId,
          skillId: skill.id,
          verificationStatus: ExerciseVerificationStatus.VERIFIED,
          retiredAt: null,
        },
        select: { id: true },
      }),
    ).resolves.toEqual([{ id: readyExercise.id }]);

    await expect(
      prisma.exercise.findUniqueOrThrow({
        where: { id: retiredExercise.id },
        include: {
          attempts: { include: { reviewLog: true } },
          flags: true,
        },
      }),
    ).resolves.toMatchObject({
      id: retiredExercise.id,
      retiredAt: expect.any(Date),
      retirementReason: ExerciseRetirementReason.FLAGGED_UNCLEAR,
      attempts: [{ id: attempt.id, reviewLog: { id: reviewLog.id } }],
      flags: [{ id: flag.id, status: ExerciseFlagStatus.RESOLVED }],
    });
  });

  it("persists typed JSON answer specs and choices for V1 exercise kinds", async () => {
    const userId = makeUserId("answer_specs");
    await cleanupUser(userId);

    await prisma.user.create({
      data: { id: userId, email: "answer-specs@example.com" },
    });

    const skill = await prisma.skill.create({
      data: {
        userId,
        title: "Answer spec examples",
      },
    });

    const exercises = await Promise.all([
      prisma.exercise.create({
        data: {
          userId,
          skillId: skill.id,
          type: ExerciseType.MULTIPLE_CHOICE,
          answerKind: AnswerKind.CHOICE,
          prompt: "Which option means to be for identity?",
          choices: [
            { id: "ser", label: "ser" },
            { id: "estar", label: "estar" },
          ],
          answerSpec: { kind: "choice", correctChoiceId: "ser" },
          correctAnswerDisplay: "ser",
        },
      }),
      prisma.exercise.create({
        data: {
          userId,
          skillId: skill.id,
          type: ExerciseType.EXACT_INPUT,
          answerKind: AnswerKind.TEXT,
          prompt: "Write the feminine singular form of rojo.",
          answerSpec: {
            kind: "text",
            accepted: ["roja"],
            normalizeCase: true,
            normalizeWhitespace: true,
            normalizeDiacritics: false,
          },
          correctAnswerDisplay: "roja",
        },
      }),
      prisma.exercise.create({
        data: {
          userId,
          skillId: skill.id,
          type: ExerciseType.EXACT_INPUT,
          answerKind: AnswerKind.NUMERIC,
          prompt: "Write 3/4 as a decimal.",
          answerSpec: {
            kind: "numeric",
            accepted: [{ type: "decimal", value: 0.75 }],
            tolerance: 0.0001,
          },
          correctAnswerDisplay: "0.75",
        },
      }),
      prisma.exercise.create({
        data: {
          userId,
          skillId: skill.id,
          type: ExerciseType.EXACT_INPUT,
          answerKind: AnswerKind.MATH,
          prompt: "Differentiate 3x^2.",
          answerSpec: {
            kind: "math",
            acceptedExpressions: ["6x", "6*x"],
            equivalence: "basic-symbolic",
          },
          correctAnswerDisplay: "6x",
        },
      }),
    ]);

    await expect(
      prisma.exercise.findMany({
        where: { id: { in: exercises.map((exercise) => exercise.id) } },
        orderBy: { answerKind: "asc" },
        select: {
          answerKind: true,
          answerSpec: true,
          choices: true,
        },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          answerKind: AnswerKind.CHOICE,
          choices: [
            { id: "ser", label: "ser" },
            { id: "estar", label: "estar" },
          ],
          answerSpec: { kind: "choice", correctChoiceId: "ser" },
        }),
        expect.objectContaining({
          answerKind: AnswerKind.TEXT,
          answerSpec: {
            kind: "text",
            accepted: ["roja"],
            normalizeCase: true,
            normalizeWhitespace: true,
            normalizeDiacritics: false,
          },
        }),
        expect.objectContaining({
          answerKind: AnswerKind.NUMERIC,
          answerSpec: {
            kind: "numeric",
            accepted: [{ type: "decimal", value: 0.75 }],
            tolerance: 0.0001,
          },
        }),
        expect.objectContaining({
          answerKind: AnswerKind.MATH,
          answerSpec: {
            kind: "math",
            acceptedExpressions: ["6x", "6*x"],
            equivalence: "basic-symbolic",
          },
        }),
      ]),
    );
  });

  it("rejects cross-user ownership mismatches at the database boundary", async () => {
    const userAId = makeUserId("ownership_a");
    const userBId = makeUserId("ownership_b");
    await cleanupUser(userAId);
    await cleanupUser(userBId);

    await prisma.user.createMany({
      data: [
        { id: userAId, email: "ownership-a@example.com" },
        { id: userBId, email: "ownership-b@example.com" },
      ],
    });

    const collectionA = await prisma.collection.create({
      data: {
        userId: userAId,
        name: "User A collection",
      },
    });

    const skillA = await prisma.skill.create({
      data: {
        userId: userAId,
        collectionId: collectionA.id,
        title: "User A skill",
      },
    });

    const sourceA = await prisma.sourceFile.create({
      data: {
        userId: userAId,
        collectionId: collectionA.id,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.READY,
        originalName: "user-a-source.txt",
      },
    });

    const sourceB = await prisma.sourceFile.create({
      data: {
        userId: userBId,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.READY,
        originalName: "user-b-source.txt",
      },
    });

    await expect(
      prisma.skill.create({
        data: {
          userId: userBId,
          collectionId: collectionA.id,
          title: "Cross-user collection skill",
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.sourceFile.create({
        data: {
          userId: userBId,
          collectionId: collectionA.id,
          kind: SourceFileKind.TEXT,
          originalName: "cross-user-collection-source.txt",
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.skillSourceRef.create({
        data: {
          userId: userAId,
          skillId: skillA.id,
          sourceFileId: sourceB.id,
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.exercise.create({
        data: {
          userId: userBId,
          skillId: skillA.id,
          type: ExerciseType.EXACT_INPUT,
          answerKind: AnswerKind.TEXT,
          prompt: "Cross-user exercise",
          answerSpec: { kind: "text", accepted: ["x"] },
          correctAnswerDisplay: "x",
        },
      }),
    ).rejects.toThrow();

    const exerciseA = await prisma.exercise.create({
      data: {
        userId: userAId,
        skillId: skillA.id,
        type: ExerciseType.EXACT_INPUT,
        answerKind: AnswerKind.TEXT,
        prompt: "User A exercise",
        answerSpec: { kind: "text", accepted: ["x"] },
        correctAnswerDisplay: "x",
      },
    });

    const otherSkillA = await prisma.skill.create({
      data: {
        userId: userAId,
        title: "User A unrelated skill",
      },
    });

    await expect(
      prisma.exerciseAttempt.create({
        data: {
          userId: userBId,
          skillId: skillA.id,
          exerciseId: exerciseA.id,
          answer: { raw: "x" },
          isCorrect: true,
          result: ExerciseAttemptResult.CORRECT,
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.exerciseAttempt.create({
        data: {
          userId: userAId,
          skillId: otherSkillA.id,
          exerciseId: exerciseA.id,
          answer: { raw: "x" },
          isCorrect: true,
          result: ExerciseAttemptResult.CORRECT,
        },
      }),
    ).rejects.toThrow();

    const attemptA = await prisma.exerciseAttempt.create({
      data: {
        userId: userAId,
        skillId: skillA.id,
        exerciseId: exerciseA.id,
        answer: { raw: "x" },
        isCorrect: true,
        result: ExerciseAttemptResult.CORRECT,
        finalRating: FsrsRating.GOOD,
      },
    });

    await expect(
      prisma.reviewLog.create({
        data: {
          userId: userBId,
          skillId: skillA.id,
          exerciseAttemptId: attemptA.id,
          finalRating: FsrsRating.GOOD,
          nextState: SkillFsrsState.REVIEW,
          schedulerName: "ts-fsrs",
          schedulerVersion: "5.x",
          desiredRetention: 0.9,
          schedulerParameters: { source: "default" },
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.reviewLog.create({
        data: {
          userId: userAId,
          skillId: otherSkillA.id,
          exerciseAttemptId: attemptA.id,
          finalRating: FsrsRating.GOOD,
          nextState: SkillFsrsState.REVIEW,
          schedulerName: "ts-fsrs",
          schedulerVersion: "5.x",
          desiredRetention: 0.9,
          schedulerParameters: { source: "default" },
        },
      }),
    ).rejects.toThrow();

    await prisma.reviewLog.create({
      data: {
        userId: userAId,
        skillId: skillA.id,
        exerciseAttemptId: attemptA.id,
        finalRating: FsrsRating.GOOD,
        nextState: SkillFsrsState.REVIEW,
        schedulerName: "ts-fsrs",
        schedulerVersion: "5.x",
        desiredRetention: 0.9,
        schedulerParameters: { source: "default" },
      },
    });

    await expect(
      prisma.reviewLog.create({
        data: {
          userId: userAId,
          skillId: skillA.id,
          exerciseAttemptId: attemptA.id,
          finalRating: FsrsRating.EASY,
          nextState: SkillFsrsState.REVIEW,
          schedulerName: "ts-fsrs",
          schedulerVersion: "5.x",
          desiredRetention: 0.9,
          schedulerParameters: { source: "default" },
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.exerciseFlag.create({
        data: {
          userId: userBId,
          exerciseId: exerciseA.id,
          reason: ExerciseFlagReason.OFF_TOPIC,
        },
      }),
    ).rejects.toThrow();

    await expect(
      prisma.collection.delete({
        where: { id: collectionA.id },
      }),
    ).rejects.toThrow();

    await prisma.skillSourceRef.create({
      data: {
        userId: userAId,
        skillId: skillA.id,
        sourceFileId: sourceA.id,
      },
    });
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
        userId,
        skillId: skill.id,
        sourceFileId: sourceFile.id,
      },
    });

    await expect(
      prisma.skillSourceRef.create({
        data: {
          userId,
          skillId: skill.id,
          sourceFileId: sourceFile.id,
        },
      }),
    ).rejects.toThrow();
  });
});
