import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AnswerKind,
  ExerciseAttemptResult,
  ExerciseRetirementReason,
  ExerciseType,
  ExerciseVerificationStatus,
  FsrsRating,
  SkillStatus,
} from "@/generated/prisma/client";
import {
  commitPracticeReview,
  getNextPracticeItem,
  previewPracticeAnswer,
} from "@/lib/practice";
import { getPrisma } from "@/lib/prisma";
import { createInitialSkillSchedule } from "@/lib/scheduling";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `practice_${randomUUID()}`;
const now = new Date("2026-06-03T12:00:00.000Z");

describeDatabase("practice review service", () => {
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

  async function createSkillFixture({
    userId,
    title,
    dueAt = new Date("2026-06-02T11:00:00.000Z"),
    status = SkillStatus.ACTIVE,
    initialized = true,
  }: {
    userId: string;
    title: string;
    dueAt?: Date;
    status?: SkillStatus;
    initialized?: boolean;
  }) {
    const schedule = initialized ? createInitialSkillSchedule(dueAt) : {};

    return prisma.skill.create({
      data: {
        userId,
        title,
        status,
        ...schedule,
      },
    });
  }

  async function createChoiceExercise({
    userId,
    skillId,
    prompt = "Choose the correct verb.",
    correctChoiceId = "ser",
    choices = [
      { id: "ser", label: "ser" },
      { id: "estar", label: "estar" },
    ],
    verificationStatus = ExerciseVerificationStatus.VERIFIED,
    retiredAt = null,
  }: {
    userId: string;
    skillId: string;
    prompt?: string;
    correctChoiceId?: string;
    choices?: Array<{ id: string; label: string }>;
    verificationStatus?: ExerciseVerificationStatus;
    retiredAt?: Date | null;
  }) {
    return prisma.exercise.create({
      data: {
        userId,
        skillId,
        type: ExerciseType.MULTIPLE_CHOICE,
        answerKind: AnswerKind.CHOICE,
        prompt,
        choices,
        answerSpec: {
          kind: "choice",
          correctChoiceId,
        },
        correctAnswerDisplay: correctChoiceId,
        explanation: "Use ser for identity.",
        difficulty: 1,
        expectedSeconds: 30,
        verificationStatus,
        retiredAt,
        retirementReason: retiredAt ? ExerciseRetirementReason.MANUAL : null,
      },
    });
  }

  async function createDueChoiceFixture(label: string) {
    const userId = await createUser(label);
    const skill = await createSkillFixture({
      userId,
      title: `${label} skill`,
    });
    const exercise = await createChoiceExercise({
      userId,
      skillId: skill.id,
    });

    return { userId, skill, exercise };
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

  it("selects the next eligible due practice item and skips excluded records", async () => {
    const userId = await createUser("selection");

    for (const status of [SkillStatus.DRAFT, SkillStatus.PAUSED, SkillStatus.ARCHIVED]) {
      const skill = await createSkillFixture({
        userId,
        title: `${status.toLowerCase()} skill`,
        dueAt: new Date("2026-06-03T09:00:00.000Z"),
        status,
      });
      await createChoiceExercise({ userId, skillId: skill.id });
    }

    const futureSkill = await createSkillFixture({
      userId,
      title: "future skill",
      dueAt: new Date("2026-06-03T13:00:00.000Z"),
    });
    await createChoiceExercise({ userId, skillId: futureSkill.id });

    const missingScheduleSkill = await createSkillFixture({
      userId,
      title: "missing schedule skill",
      initialized: false,
    });
    await createChoiceExercise({ userId, skillId: missingScheduleSkill.id });

    const unverifiedSkill = await createSkillFixture({
      userId,
      title: "unverified exercise skill",
      dueAt: new Date("2026-06-03T09:10:00.000Z"),
    });
    await createChoiceExercise({
      userId,
      skillId: unverifiedSkill.id,
      verificationStatus: ExerciseVerificationStatus.UNVERIFIED,
    });

    const retiredSkill = await createSkillFixture({
      userId,
      title: "retired exercise skill",
      dueAt: new Date("2026-06-03T09:20:00.000Z"),
    });
    await createChoiceExercise({
      userId,
      skillId: retiredSkill.id,
      retiredAt: new Date("2026-06-03T10:00:00.000Z"),
    });

    const mathOnlySkill = await createSkillFixture({
      userId,
      title: "math only skill",
      dueAt: new Date("2026-06-03T09:30:00.000Z"),
    });
    await prisma.exercise.create({
      data: {
        userId,
        skillId: mathOnlySkill.id,
        type: ExerciseType.EXACT_INPUT,
        answerKind: AnswerKind.MATH,
        prompt: "Differentiate x^2.",
        answerSpec: {
          kind: "math",
          acceptedExpressions: ["2x"],
        },
        correctAnswerDisplay: "2x",
        verificationStatus: ExerciseVerificationStatus.VERIFIED,
      },
    });

    const otherUserId = await createUser("selection_other");
    const otherSkill = await createSkillFixture({
      userId: otherUserId,
      title: "other user skill",
      dueAt: new Date("2026-06-03T08:00:00.000Z"),
    });
    await createChoiceExercise({ userId: otherUserId, skillId: otherSkill.id });

    const readySkill = await createSkillFixture({
      userId,
      title: "ready skill",
      dueAt: new Date("2026-06-03T10:00:00.000Z"),
    });
    const readyExercise = await createChoiceExercise({
      userId,
      skillId: readySkill.id,
      prompt: "Which verb describes identity?",
    });

    await expect(getNextPracticeItem({ userId, now })).resolves.toMatchObject({
      status: "ready",
      skill: {
        id: readySkill.id,
        title: "ready skill",
      },
      exercise: {
        id: readyExercise.id,
        prompt: "Which verb describes identity?",
      },
    });
  });

  it("previews deterministic answer feedback without writing attempts or review logs", async () => {
    const { userId, exercise } = await createDueChoiceFixture("preview");

    await expect(
      previewPracticeAnswer({
        userId,
        exerciseId: exercise.id,
        submittedAnswer: "ser",
        responseMs: 20_000,
      }),
    ).resolves.toMatchObject({
      status: "checked",
      answerCheck: {
        status: "correct",
        isCorrect: true,
        normalizedAnswer: "ser",
      },
      proposedRating: FsrsRating.GOOD,
      correctAnswerDisplay: "ser",
    });

    await expect(
      Promise.all([
        prisma.exerciseAttempt.count({ where: { userId } }),
        prisma.reviewLog.count({ where: { userId } }),
      ]),
    ).resolves.toEqual([0, 0]);
  });

  it("commits a correct multiple-choice review in one transaction", async () => {
    const { userId, skill, exercise } = await createDueChoiceFixture("correct_commit");
    const reviewedAt = new Date("2026-06-03T12:05:00.000Z");
    const attemptId = `${runId}_correct_attempt`;

    const result = await commitPracticeReview({
      userId,
      exerciseId: exercise.id,
      attemptId,
      submittedAnswer: "ser",
      responseMs: 20_000,
      reviewedAt,
    });

    expect(result).toMatchObject({
      status: "committed",
      idempotent: false,
      answerCheck: {
        status: "correct",
        normalizedAnswer: "ser",
      },
      proposedRating: FsrsRating.GOOD,
      finalRating: FsrsRating.GOOD,
    });

    await expect(
      prisma.exerciseAttempt.findUniqueOrThrow({
        where: { id: attemptId },
        include: { reviewLog: true },
      }),
    ).resolves.toMatchObject({
      id: attemptId,
      userId,
      skillId: skill.id,
      exerciseId: exercise.id,
      normalizedAnswer: "ser",
      isCorrect: true,
      result: ExerciseAttemptResult.CORRECT,
      responseMs: 20_000,
      proposedRating: FsrsRating.GOOD,
      finalRating: FsrsRating.GOOD,
      reviewLog: {
        finalRating: FsrsRating.GOOD,
        reviewedAt,
      },
    });

    await expect(
      prisma.skill.findUniqueOrThrow({
        where: { id: skill.id },
        select: { repetitions: true, lastReviewedAt: true, dueAt: true },
      }),
    ).resolves.toMatchObject({
      repetitions: 1,
      lastReviewedAt: reviewedAt,
      dueAt: expect.any(Date),
    });
  });

  it("maps incorrect committed reviews to Again", async () => {
    const { userId, exercise } = await createDueChoiceFixture("incorrect_commit");

    await expect(
      commitPracticeReview({
        userId,
        exerciseId: exercise.id,
        attemptId: `${runId}_incorrect_attempt`,
        submittedAnswer: "estar",
        responseMs: 8_000,
        manualRating: FsrsRating.EASY,
        reviewedAt: now,
      }),
    ).resolves.toMatchObject({
      status: "committed",
      answerCheck: {
        status: "incorrect",
        isCorrect: false,
      },
      proposedRating: FsrsRating.AGAIN,
      finalRating: FsrsRating.AGAIN,
    });
  });

  it("persists correct-answer manual Hard, Good, and Easy overrides", async () => {
    const userId = await createUser("manual_overrides");

    for (const manualRating of [FsrsRating.HARD, FsrsRating.GOOD, FsrsRating.EASY]) {
      const skill = await createSkillFixture({
        userId,
        title: `manual ${manualRating}`,
      });
      const exercise = await createChoiceExercise({
        userId,
        skillId: skill.id,
      });
      const attemptId = `${runId}_manual_${manualRating}`;

      await expect(
        commitPracticeReview({
          userId,
          exerciseId: exercise.id,
          attemptId,
          submittedAnswer: "ser",
          responseMs: 30_000,
          manualRating,
          reviewedAt: now,
        }),
      ).resolves.toMatchObject({
        status: "committed",
        finalRating: manualRating,
      });

      await expect(
        prisma.exerciseAttempt.findUniqueOrThrow({
          where: { id: attemptId },
          select: { finalRating: true, reviewLog: { select: { finalRating: true } } },
        }),
      ).resolves.toEqual({
        finalRating: manualRating,
        reviewLog: { finalRating: manualRating },
      });
    }
  });

  it("does not write attempts for invalid input, invalid specs, or unsupported specs", async () => {
    const userId = await createUser("no_write_failures");

    const invalidInputSkill = await createSkillFixture({
      userId,
      title: "invalid input skill",
    });
    const invalidInputExercise = await createChoiceExercise({
      userId,
      skillId: invalidInputSkill.id,
    });

    const invalidSpecSkill = await createSkillFixture({
      userId,
      title: "invalid spec skill",
    });
    const invalidSpecExercise = await createChoiceExercise({
      userId,
      skillId: invalidSpecSkill.id,
      correctChoiceId: "missing",
      choices: [{ id: "ser", label: "ser" }],
    });

    const unsupportedSkill = await createSkillFixture({
      userId,
      title: "unsupported spec skill",
    });
    const unsupportedExercise = await prisma.exercise.create({
      data: {
        userId,
        skillId: unsupportedSkill.id,
        type: ExerciseType.EXACT_INPUT,
        answerKind: AnswerKind.TEXT,
        prompt: "Differentiate x^2.",
        answerSpec: {
          kind: "math",
          acceptedExpressions: ["2x"],
        },
        correctAnswerDisplay: "2x",
        verificationStatus: ExerciseVerificationStatus.VERIFIED,
      },
    });

    await expect(
      commitPracticeReview({
        userId,
        exerciseId: invalidInputExercise.id,
        attemptId: `${runId}_invalid_input`,
        submittedAnswer: "haber",
        responseMs: 4_000,
        reviewedAt: now,
      }),
    ).resolves.toMatchObject({
      status: "not-committed",
      answerCheck: { status: "invalid-input" },
    });

    await expect(
      commitPracticeReview({
        userId,
        exerciseId: invalidSpecExercise.id,
        attemptId: `${runId}_invalid_spec`,
        submittedAnswer: "ser",
        responseMs: 4_000,
        reviewedAt: now,
      }),
    ).resolves.toMatchObject({
      status: "not-committed",
      answerCheck: { status: "invalid-spec" },
    });

    await expect(
      commitPracticeReview({
        userId,
        exerciseId: unsupportedExercise.id,
        attemptId: `${runId}_unsupported`,
        submittedAnswer: "2x",
        responseMs: 4_000,
        reviewedAt: now,
      }),
    ).resolves.toMatchObject({
      status: "not-committed",
      answerCheck: { status: "unsupported" },
    });

    await expect(
      Promise.all([
        prisma.exerciseAttempt.count({ where: { userId } }),
        prisma.reviewLog.count({ where: { userId } }),
      ]),
    ).resolves.toEqual([0, 0]);
  });

  it("rejects cross-user submissions without writing attempts", async () => {
    const owner = await createDueChoiceFixture("cross_owner");
    const otherUserId = await createUser("cross_other");

    await expect(
      commitPracticeReview({
        userId: otherUserId,
        exerciseId: owner.exercise.id,
        attemptId: `${runId}_cross_user`,
        submittedAnswer: "ser",
        responseMs: 4_000,
        reviewedAt: now,
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "exercise-not-found",
    });

    await expect(
      Promise.all([
        prisma.exerciseAttempt.count({
          where: { id: `${runId}_cross_user` },
        }),
        prisma.reviewLog.count({
          where: { userId: otherUserId },
        }),
      ]),
    ).resolves.toEqual([0, 0]);
  });

  it("treats duplicate attempt IDs as idempotent and does not double-advance FSRS", async () => {
    const { userId, skill, exercise } = await createDueChoiceFixture("idempotent");
    const attemptId = `${runId}_idempotent_attempt`;

    const first = await commitPracticeReview({
      userId,
      exerciseId: exercise.id,
      attemptId,
      submittedAnswer: "ser",
      responseMs: 20_000,
      reviewedAt: now,
    });
    const second = await commitPracticeReview({
      userId,
      exerciseId: exercise.id,
      attemptId,
      submittedAnswer: "ser",
      responseMs: 20_000,
      reviewedAt: now,
    });

    expect(first).toMatchObject({
      status: "committed",
      idempotent: false,
    });
    expect(second).toMatchObject({
      status: "committed",
      idempotent: true,
    });

    await expect(
      Promise.all([
        prisma.exerciseAttempt.count({ where: { id: attemptId } }),
        prisma.reviewLog.count({ where: { exerciseAttemptId: attemptId } }),
        prisma.skill.findUniqueOrThrow({
          where: { id: skill.id },
          select: { repetitions: true },
        }),
      ]),
    ).resolves.toEqual([1, 1, { repetitions: 1 }]);
  });
});
