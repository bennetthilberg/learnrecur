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
} from "@/generated/prisma/client";
import {
  commitPracticeReview,
  flagPracticeExercise,
  getNextPracticeItem,
  previewPracticeAnswer,
} from "@/lib/practice";
import { ensureDevPracticeSampleData } from "@/lib/practice/sample-data";
import { getPrisma } from "@/lib/prisma";
import { createInitialSkillSchedule } from "@/lib/scheduling";
import { EXACT_INPUT_UNLOCK_REPETITIONS } from "@/lib/skills";

import { getNextChoicePracticeItemForUser } from "@/app/practice/queries";

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
    repetitions = 0,
  }: {
    userId: string;
    title: string;
    dueAt?: Date;
    status?: SkillStatus;
    initialized?: boolean;
    repetitions?: number;
  }) {
    const schedule = initialized ? createInitialSkillSchedule(dueAt) : {};

    return prisma.skill.create({
      data: {
        userId,
        title,
        status,
        ...schedule,
        repetitions,
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

  async function createTextExercise({
    userId,
    skillId,
    prompt = "Type the correct verb.",
  }: {
    userId: string;
    skillId: string;
    prompt?: string;
  }) {
    return prisma.exercise.create({
      data: {
        userId,
        skillId,
        type: ExerciseType.EXACT_INPUT,
        answerKind: AnswerKind.TEXT,
        prompt,
        answerSpec: {
          kind: "text",
          accepted: ["ser"],
        },
        correctAnswerDisplay: "ser",
        explanation: "Use ser for identity.",
        difficulty: 1,
        expectedSeconds: 30,
        verificationStatus: ExerciseVerificationStatus.VERIFIED,
      },
    });
  }

  async function createNumericExercise({
    userId,
    skillId,
    prompt = "Enter one half as a decimal.",
  }: {
    userId: string;
    skillId: string;
    prompt?: string;
  }) {
    return prisma.exercise.create({
      data: {
        userId,
        skillId,
        type: ExerciseType.EXACT_INPUT,
        answerKind: AnswerKind.NUMERIC,
        prompt,
        answerSpec: {
          kind: "numeric",
          accepted: ["1/2", 0.5],
          tolerance: 0,
        },
        correctAnswerDisplay: "0.5",
        explanation: "One half is 0.5.",
        difficulty: 1,
        expectedSeconds: 30,
        verificationStatus: ExerciseVerificationStatus.VERIFIED,
      },
    });
  }

  async function createAttemptFixture({
    userId,
    skillId,
    exerciseId,
    createdAt,
    label = randomUUID(),
  }: {
    userId: string;
    skillId: string;
    exerciseId: string;
    createdAt: Date;
    label?: string;
  }) {
    return prisma.exerciseAttempt.create({
      data: {
        id: `${runId}_rotation_attempt_${label}`,
        userId,
        skillId,
        exerciseId,
        answer: { raw: "ser" },
        normalizedAnswer: "ser",
        isCorrect: true,
        result: ExerciseAttemptResult.CORRECT,
        responseMs: 20_000,
        proposedRating: FsrsRating.GOOD,
        finalRating: FsrsRating.GOOD,
        createdAt,
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

    const laterReadySkill = await createSkillFixture({
      userId,
      title: "later ready skill",
      dueAt: new Date("2026-06-03T11:00:00.000Z"),
    });
    await createChoiceExercise({
      userId,
      skillId: laterReadySkill.id,
      prompt: "Which later verb describes location?",
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

  it("rotates to an unattempted exercise within the earliest due skill", async () => {
    const userId = await createUser("rotation_unattempted");
    const skill = await createSkillFixture({
      userId,
      title: "rotation skill",
      dueAt: new Date("2026-06-03T09:00:00.000Z"),
    });
    const attemptedExercise = await createChoiceExercise({
      userId,
      skillId: skill.id,
      prompt: "Already practiced prompt.",
    });
    const unattemptedExercise = await createChoiceExercise({
      userId,
      skillId: skill.id,
      prompt: "Fresh prompt.",
    });

    await createAttemptFixture({
      userId,
      skillId: skill.id,
      exerciseId: attemptedExercise.id,
      createdAt: new Date("2026-06-03T10:00:00.000Z"),
      label: "unattempted",
    });

    await expect(getNextPracticeItem({ userId, now })).resolves.toMatchObject({
      status: "ready",
      skill: {
        id: skill.id,
      },
      exercise: {
        id: unattemptedExercise.id,
        prompt: "Fresh prompt.",
      },
    });
  });

  it("rotates to the least recently attempted exercise after all candidates have history", async () => {
    const userId = await createUser("rotation_least_recent");
    const skill = await createSkillFixture({
      userId,
      title: "least recent rotation skill",
      dueAt: new Date("2026-06-03T09:00:00.000Z"),
    });
    const oldestExercise = await createChoiceExercise({
      userId,
      skillId: skill.id,
      prompt: "Oldest practiced prompt.",
    });
    const newestExercise = await createChoiceExercise({
      userId,
      skillId: skill.id,
      prompt: "Newest practiced prompt.",
    });

    await createAttemptFixture({
      userId,
      skillId: skill.id,
      exerciseId: newestExercise.id,
      createdAt: new Date("2026-06-03T11:00:00.000Z"),
      label: "newest",
    });
    await createAttemptFixture({
      userId,
      skillId: skill.id,
      exerciseId: oldestExercise.id,
      createdAt: new Date("2026-06-03T08:00:00.000Z"),
      label: "oldest",
    });

    await expect(getNextPracticeItem({ userId, now })).resolves.toMatchObject({
      status: "ready",
      exercise: {
        id: oldestExercise.id,
        prompt: "Oldest practiced prompt.",
      },
    });
  });

  it("uses attempt count after last-attempted ties", async () => {
    const userId = await createUser("rotation_attempt_count");
    const skill = await createSkillFixture({
      userId,
      title: "attempt count rotation skill",
      dueAt: new Date("2026-06-03T09:00:00.000Z"),
    });
    const fewerAttemptsExercise = await createChoiceExercise({
      userId,
      skillId: skill.id,
      prompt: "Fewer attempts prompt.",
    });
    const moreAttemptsExercise = await createChoiceExercise({
      userId,
      skillId: skill.id,
      prompt: "More attempts prompt.",
    });
    const tiedLastAttemptedAt = new Date("2026-06-03T10:30:00.000Z");

    await createAttemptFixture({
      userId,
      skillId: skill.id,
      exerciseId: fewerAttemptsExercise.id,
      createdAt: tiedLastAttemptedAt,
      label: "fewer",
    });
    await createAttemptFixture({
      userId,
      skillId: skill.id,
      exerciseId: moreAttemptsExercise.id,
      createdAt: new Date("2026-06-03T09:30:00.000Z"),
      label: "more_old",
    });
    await createAttemptFixture({
      userId,
      skillId: skill.id,
      exerciseId: moreAttemptsExercise.id,
      createdAt: tiedLastAttemptedAt,
      label: "more_tied",
    });

    await expect(getNextPracticeItem({ userId, now })).resolves.toMatchObject({
      status: "ready",
      exercise: {
        id: fewerAttemptsExercise.id,
        prompt: "Fewer attempts prompt.",
      },
    });
  });

  it("keeps due skill priority ahead of exercise rotation freshness", async () => {
    const userId = await createUser("rotation_due_priority");
    const earlierSkill = await createSkillFixture({
      userId,
      title: "earlier due skill",
      dueAt: new Date("2026-06-03T09:00:00.000Z"),
    });
    const earlierExercise = await createChoiceExercise({
      userId,
      skillId: earlierSkill.id,
      prompt: "Earlier due practiced prompt.",
    });
    const laterSkill = await createSkillFixture({
      userId,
      title: "later due skill",
      dueAt: new Date("2026-06-03T10:00:00.000Z"),
    });
    const laterFreshExercise = await createChoiceExercise({
      userId,
      skillId: laterSkill.id,
      prompt: "Later due fresh prompt.",
    });

    await createAttemptFixture({
      userId,
      skillId: earlierSkill.id,
      exerciseId: earlierExercise.id,
      createdAt: new Date("2026-06-03T11:00:00.000Z"),
      label: "due_priority",
    });

    await expect(getNextPracticeItem({ userId, now })).resolves.toMatchObject({
      status: "ready",
      skill: {
        id: earlierSkill.id,
      },
      exercise: {
        id: earlierExercise.id,
      },
    });

    await expect(
      prisma.exerciseAttempt.count({
        where: {
          userId,
          exerciseId: laterFreshExercise.id,
        },
      }),
    ).resolves.toBe(0);
  });

  it("keeps another user's attempt history isolated from rotation", async () => {
    const userId = await createUser("rotation_owner");
    const otherUserId = await createUser("rotation_other");
    const ownerSkill = await createSkillFixture({
      userId,
      title: "owner rotation skill",
      dueAt: new Date("2026-06-03T09:00:00.000Z"),
    });
    const ownerFirstExercise = await createChoiceExercise({
      userId,
      skillId: ownerSkill.id,
      prompt: "Owner first prompt.",
    });
    const ownerSecondExercise = await createChoiceExercise({
      userId,
      skillId: ownerSkill.id,
      prompt: "Owner second prompt.",
    });
    const otherSkill = await createSkillFixture({
      userId: otherUserId,
      title: "other rotation skill",
      dueAt: new Date("2026-06-03T08:00:00.000Z"),
    });
    const otherExercise = await createChoiceExercise({
      userId: otherUserId,
      skillId: otherSkill.id,
      prompt: "Other user prompt.",
    });

    await createAttemptFixture({
      userId: otherUserId,
      skillId: otherSkill.id,
      exerciseId: otherExercise.id,
      createdAt: new Date("2026-06-03T11:30:00.000Z"),
      label: "other_user",
    });

    await expect(getNextPracticeItem({ userId, now })).resolves.toMatchObject({
      status: "ready",
      skill: {
        id: ownerSkill.id,
      },
      exercise: {
        id: ownerFirstExercise.id,
      },
    });

    await expect(
      prisma.exerciseAttempt.count({
        where: {
          userId,
          exerciseId: { in: [ownerFirstExercise.id, ownerSecondExercise.id] },
        },
      }),
    ).resolves.toBe(0);
  });

  it("selects the next eligible exercise after one is flagged and retired", async () => {
    const userId = await createUser("rotation_flagged");
    const skill = await createSkillFixture({
      userId,
      title: "flagged rotation skill",
    });
    const flaggedExercise = await createChoiceExercise({
      userId,
      skillId: skill.id,
      prompt: "Bad prompt.",
    });
    const remainingExercise = await createChoiceExercise({
      userId,
      skillId: skill.id,
      prompt: "Remaining prompt.",
    });

    await flagPracticeExercise({
      userId,
      exerciseId: flaggedExercise.id,
      reasons: [ExerciseFlagReason.UNCLEAR_PROMPT],
      flaggedAt: new Date("2026-06-03T12:30:00.000Z"),
    });

    await expect(getNextPracticeItem({ userId, now })).resolves.toMatchObject({
      status: "ready",
      skill: {
        id: skill.id,
      },
      exercise: {
        id: remainingExercise.id,
        prompt: "Remaining prompt.",
      },
    });
  });

  it("filters eligible practice items by answer kind", async () => {
    const userId = await createUser("answer_kind_filter");

    const textSkill = await createSkillFixture({
      userId,
      title: "earlier text skill",
      dueAt: new Date("2026-06-03T09:00:00.000Z"),
    });
    const textExercise = await createTextExercise({
      userId,
      skillId: textSkill.id,
      prompt: "Earlier exact-input prompt.",
    });

    const choiceSkill = await createSkillFixture({
      userId,
      title: "later choice skill",
      dueAt: new Date("2026-06-03T10:00:00.000Z"),
    });
    const choiceExercise = await createChoiceExercise({
      userId,
      skillId: choiceSkill.id,
      prompt: "Later multiple-choice prompt.",
    });

    await expect(
      getNextPracticeItem({
        userId,
        now,
        answerKinds: [AnswerKind.CHOICE],
      }),
    ).resolves.toMatchObject({
      status: "ready",
      skill: {
        id: choiceSkill.id,
      },
      exercise: {
        id: choiceExercise.id,
      },
    });

    await expect(
      previewPracticeAnswer({
        userId,
        exerciseId: textExercise.id,
        submittedAnswer: "ser",
        now,
        answerKinds: [AnswerKind.CHOICE],
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "exercise-not-found",
    });
  });

  it("keeps exact-input exercises out before the skill review threshold", async () => {
    const userId = await createUser("exact_locked_selection");
    const skill = await createSkillFixture({
      userId,
      title: "locked exact skill",
      dueAt: new Date("2026-06-03T09:00:00.000Z"),
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS - 1,
    });
    const textExercise = await createTextExercise({
      userId,
      skillId: skill.id,
      prompt: "Locked exact prompt.",
    });

    await expect(getNextPracticeItem({ userId, now })).resolves.toMatchObject({
      status: "none-due",
    });

    await expect(
      previewPracticeAnswer({
        userId,
        exerciseId: textExercise.id,
        submittedAnswer: "ser",
        now,
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "exercise-not-found",
    });
  });

  it("includes exact-input exercises once the skill review threshold is reached", async () => {
    const userId = await createUser("exact_unlocked_selection");
    const skill = await createSkillFixture({
      userId,
      title: "unlocked exact skill",
      dueAt: new Date("2026-06-03T09:00:00.000Z"),
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    const textExercise = await createTextExercise({
      userId,
      skillId: skill.id,
      prompt: "Unlocked exact prompt.",
    });

    await expect(getNextPracticeItem({ userId, now })).resolves.toMatchObject({
      status: "ready",
      skill: {
        id: skill.id,
      },
      exercise: {
        id: textExercise.id,
        answerKind: AnswerKind.TEXT,
      },
    });
  });

  it("keeps unsupported math exercises out even when requested explicitly", async () => {
    const userId = await createUser("unsupported_math_filter");
    const mathSkill = await createSkillFixture({
      userId,
      title: "math skill",
      dueAt: new Date("2026-06-03T09:00:00.000Z"),
    });

    await prisma.exercise.create({
      data: {
        userId,
        skillId: mathSkill.id,
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

    await expect(
      getNextPracticeItem({
        userId,
        now,
        answerKinds: [AnswerKind.MATH],
      }),
    ).resolves.toMatchObject({
      status: "none-due",
    });
  });

  it("fails closed when a choice practice item would drop malformed choices", async () => {
    const userId = await createUser("malformed_choice_query");
    const skill = await createSkillFixture({
      userId,
      title: "malformed choices skill",
      dueAt: new Date("2026-06-03T09:00:00.000Z"),
    });

    await prisma.exercise.create({
      data: {
        userId,
        skillId: skill.id,
        type: ExerciseType.MULTIPLE_CHOICE,
        answerKind: AnswerKind.CHOICE,
        prompt: "Choose the correct verb.",
        choices: [{ id: "ser", label: "ser" }, { id: "estar" }],
        answerSpec: {
          kind: "choice",
          correctChoiceId: "ser",
        },
        correctAnswerDisplay: "ser",
        verificationStatus: ExerciseVerificationStatus.VERIFIED,
      },
    });

    await expect(getNextChoicePracticeItemForUser(userId, now)).resolves.toMatchObject({
      status: "unavailable",
      message: "This exercise does not have valid answer choices.",
    });
  });

  it("fails closed when a choice practice item has no choices", async () => {
    const userId = await createUser("empty_choice_query");
    const skill = await createSkillFixture({
      userId,
      title: "empty choices skill",
      dueAt: new Date("2026-06-03T09:00:00.000Z"),
    });
    await createChoiceExercise({
      userId,
      skillId: skill.id,
      choices: [],
    });

    await expect(getNextChoicePracticeItemForUser(userId, now)).resolves.toMatchObject({
      status: "unavailable",
      message: "This exercise does not have valid answer choices.",
    });
  });

  it("creates idempotent development sample practice data", async () => {
    const userId = await createUser("sample_data");

    await expect(
      ensureDevPracticeSampleData({
        userId,
        now,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      skillCount: 2,
      exerciseCount: 3,
    });

    const reviewedAt = new Date("2026-06-04T09:30:00.000Z");
    const dueAt = new Date("2026-06-10T12:00:00.000Z");
    const progressedSkill = await prisma.skill.findFirstOrThrow({
      where: {
        userId,
        title: "Ser vs. estar for identity and location",
        tags: { has: "learnrecur-sample" },
      },
    });
    await prisma.skill.update({
      where: { id: progressedSkill.id },
      data: {
        dueAt,
        stability: 8.5,
        difficulty: 4.25,
        repetitions: 3,
        lapses: 1,
        fsrsState: SkillFsrsState.REVIEW,
        lastReviewedAt: reviewedAt,
      },
    });

    await expect(
      ensureDevPracticeSampleData({
        userId,
        now: new Date("2026-06-04T12:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      status: "ready",
      skillCount: 2,
      exerciseCount: 3,
    });

    await expect(
      Promise.all([
        prisma.collection.count({
          where: {
            userId,
            name: "LearnRecur samples",
          },
        }),
        prisma.skill.count({
          where: {
            userId,
            tags: { has: "learnrecur-sample" },
            status: SkillStatus.ACTIVE,
          },
        }),
        prisma.exercise.count({
          where: {
            userId,
            freshnessKey: { startsWith: "learnrecur-sample:" },
            verificationStatus: ExerciseVerificationStatus.VERIFIED,
            retiredAt: null,
          },
        }),
      ]),
    ).resolves.toEqual([1, 2, 3]);

    await expect(
      prisma.skill.findUniqueOrThrow({
        where: { id: progressedSkill.id },
        select: {
          dueAt: true,
          stability: true,
          difficulty: true,
          repetitions: true,
          lapses: true,
          fsrsState: true,
          lastReviewedAt: true,
        },
      }),
    ).resolves.toEqual({
      dueAt,
      stability: 8.5,
      difficulty: 4.25,
      repetitions: 3,
      lapses: 1,
      fsrsState: SkillFsrsState.REVIEW,
      lastReviewedAt: reviewedAt,
    });
  });

  it("flags and retires an exercise without committing a review", async () => {
    const { userId, skill, exercise } = await createDueChoiceFixture("flag_retire");
    const flaggedAt = new Date("2026-06-03T12:10:00.000Z");
    const initialSkill = await prisma.skill.findUniqueOrThrow({
      where: { id: skill.id },
      select: {
        dueAt: true,
        stability: true,
        difficulty: true,
        elapsedDays: true,
        scheduledDays: true,
        learningSteps: true,
        repetitions: true,
        lapses: true,
        fsrsState: true,
        lastReviewedAt: true,
      },
    });

    await expect(
      flagPracticeExercise({
        userId,
        exerciseId: exercise.id,
        reasons: [ExerciseFlagReason.UNCLEAR_PROMPT],
        flaggedAt,
      }),
    ).resolves.toMatchObject({
      status: "flagged",
      exerciseId: exercise.id,
      flagCount: 1,
      retiredAt: flaggedAt,
      retirementReason: ExerciseRetirementReason.FLAGGED_UNCLEAR,
    });

    await expect(
      prisma.exercise.findUniqueOrThrow({
        where: { id: exercise.id },
        include: { flags: true },
      }),
    ).resolves.toMatchObject({
      id: exercise.id,
      retiredAt: flaggedAt,
      retirementReason: ExerciseRetirementReason.FLAGGED_UNCLEAR,
      flags: [
        {
          reason: ExerciseFlagReason.UNCLEAR_PROMPT,
          status: ExerciseFlagStatus.RESOLVED,
          resolvedAt: flaggedAt,
          resolutionNote: "Retired from practice.",
          retiredExerciseAt: flaggedAt,
          retirementReason: ExerciseRetirementReason.FLAGGED_UNCLEAR,
        },
      ],
    });

    await expect(getNextPracticeItem({ userId, now })).resolves.toMatchObject({
      status: "none-due",
    });

    await expect(
      Promise.all([
        prisma.exerciseAttempt.count({ where: { userId } }),
        prisma.reviewLog.count({ where: { userId } }),
        prisma.skill.findUniqueOrThrow({
          where: { id: skill.id },
          select: {
            dueAt: true,
            stability: true,
            difficulty: true,
            elapsedDays: true,
            scheduledDays: true,
            learningSteps: true,
            repetitions: true,
            lapses: true,
            fsrsState: true,
            lastReviewedAt: true,
          },
        }),
      ]),
    ).resolves.toEqual([0, 0, initialSkill]);
  });

  it("flags an exact-input exercise without committing a review", async () => {
    const userId = await createUser("flag_exact_input");
    const skill = await createSkillFixture({
      userId,
      title: "exact flag skill",
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    const exercise = await createTextExercise({ userId, skillId: skill.id });

    await expect(
      flagPracticeExercise({
        userId,
        exerciseId: exercise.id,
        reasons: [ExerciseFlagReason.NOT_USEFUL],
        flaggedAt: now,
      }),
    ).resolves.toMatchObject({
      status: "flagged",
      exerciseId: exercise.id,
      retirementReason: ExerciseRetirementReason.OTHER,
    });

    await expect(
      Promise.all([
        prisma.exerciseAttempt.count({ where: { userId, exerciseId: exercise.id } }),
        prisma.reviewLog.count({ where: { userId, skillId: skill.id } }),
        prisma.exercise.findUniqueOrThrow({
          where: { id: exercise.id },
          select: { retiredAt: true, retirementReason: true },
        }),
      ]),
    ).resolves.toEqual([
      0,
      0,
      {
        retiredAt: now,
        retirementReason: ExerciseRetirementReason.OTHER,
      },
    ]);
  });

  it("creates multiple resolved flag rows and stores a custom other note", async () => {
    const { userId, exercise } = await createDueChoiceFixture("flag_multiple");
    const flaggedAt = new Date("2026-06-03T12:15:00.000Z");

    await expect(
      flagPracticeExercise({
        userId,
        exerciseId: exercise.id,
        reasons: [ExerciseFlagReason.INCORRECT_ANSWER, ExerciseFlagReason.OTHER],
        otherNote: "The answer key disagrees with my worksheet.",
        flaggedAt,
      }),
    ).resolves.toMatchObject({
      status: "flagged",
      flagCount: 2,
      retirementReason: ExerciseRetirementReason.FLAGGED_INCORRECT,
    });

    await expect(
      prisma.exerciseFlag.findMany({
        where: { userId, exerciseId: exercise.id },
        orderBy: { reason: "asc" },
        select: {
          reason: true,
          note: true,
          status: true,
          resolvedAt: true,
          retiredExerciseAt: true,
          retirementReason: true,
        },
      }),
    ).resolves.toEqual([
      {
        reason: ExerciseFlagReason.INCORRECT_ANSWER,
        note: null,
        status: ExerciseFlagStatus.RESOLVED,
        resolvedAt: flaggedAt,
        retiredExerciseAt: flaggedAt,
        retirementReason: ExerciseRetirementReason.FLAGGED_INCORRECT,
      },
      {
        reason: ExerciseFlagReason.OTHER,
        note: "The answer key disagrees with my worksheet.",
        status: ExerciseFlagStatus.RESOLVED,
        resolvedAt: flaggedAt,
        retiredExerciseAt: flaggedAt,
        retirementReason: ExerciseRetirementReason.FLAGGED_INCORRECT,
      },
    ]);
  });

  it("does not duplicate flag rows on repeated submissions", async () => {
    const { userId, exercise } = await createDueChoiceFixture("flag_duplicate");
    const flaggedAt = new Date("2026-06-03T12:20:00.000Z");

    for (const note of ["First note.", "Updated note."]) {
      await expect(
        flagPracticeExercise({
          userId,
          exerciseId: exercise.id,
          reasons: [ExerciseFlagReason.NOT_USEFUL, ExerciseFlagReason.OTHER],
          otherNote: note,
          flaggedAt,
        }),
      ).resolves.toMatchObject({
        status: "flagged",
        flagCount: 2,
      });
    }

    await expect(
      Promise.all([
        prisma.exerciseFlag.count({ where: { userId, exerciseId: exercise.id } }),
        prisma.exerciseFlag.findFirstOrThrow({
          where: { userId, exerciseId: exercise.id, reason: ExerciseFlagReason.OTHER },
          select: { note: true },
        }),
      ]),
    ).resolves.toEqual([2, { note: "Updated note." }]);
  });

  it("rejects invalid flags without writing", async () => {
    const { userId, exercise } = await createDueChoiceFixture("flag_invalid");

    await expect(
      flagPracticeExercise({
        userId,
        exerciseId: exercise.id,
        reasons: [],
        flaggedAt: now,
      }),
    ).resolves.toMatchObject({
      status: "not-flagged",
      reason: "invalid-flag",
    });

    await expect(
      flagPracticeExercise({
        userId,
        exerciseId: exercise.id,
        reasons: [ExerciseFlagReason.OTHER],
        otherNote: "  ",
        flaggedAt: now,
      }),
    ).resolves.toMatchObject({
      status: "not-flagged",
      reason: "invalid-flag",
    });

    await expect(
      Promise.all([
        prisma.exerciseFlag.count({ where: { userId, exerciseId: exercise.id } }),
        prisma.exercise.findUniqueOrThrow({
          where: { id: exercise.id },
          select: { retiredAt: true, retirementReason: true },
        }),
      ]),
    ).resolves.toEqual([0, { retiredAt: null, retirementReason: null }]);
  });

  it("rejects cross-user flagging without writing", async () => {
    const owner = await createDueChoiceFixture("flag_cross_owner");
    const otherUserId = await createUser("flag_cross_other");

    await expect(
      flagPracticeExercise({
        userId: otherUserId,
        exerciseId: owner.exercise.id,
        reasons: [ExerciseFlagReason.OFF_TOPIC],
        flaggedAt: now,
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "exercise-not-found",
    });

    await expect(
      Promise.all([
        prisma.exerciseFlag.count({ where: { exerciseId: owner.exercise.id } }),
        prisma.exercise.findUniqueOrThrow({
          where: { id: owner.exercise.id },
          select: { retiredAt: true, retirementReason: true },
        }),
      ]),
    ).resolves.toEqual([0, { retiredAt: null, retirementReason: null }]);
  });

  it("previews deterministic answer feedback without writing attempts or review logs", async () => {
    const { userId, exercise } = await createDueChoiceFixture("preview");

    await expect(
      previewPracticeAnswer({
        userId,
        exerciseId: exercise.id,
        submittedAnswer: "ser",
        responseMs: 20_000,
        now,
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

  it("commits correct text and numeric exact-input reviews", async () => {
    const userId = await createUser("exact_commit");

    const textSkill = await createSkillFixture({
      userId,
      title: "text exact commit skill",
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    const textExercise = await createTextExercise({ userId, skillId: textSkill.id });
    const numericSkill = await createSkillFixture({
      userId,
      title: "numeric exact commit skill",
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    const numericExercise = await createNumericExercise({ userId, skillId: numericSkill.id });

    await expect(
      commitPracticeReview({
        userId,
        exerciseId: textExercise.id,
        attemptId: `${runId}_text_exact_attempt`,
        submittedAnswer: " SER ",
        responseMs: 28_000,
        reviewedAt: now,
      }),
    ).resolves.toMatchObject({
      status: "committed",
      answerCheck: {
        status: "correct",
        normalizedAnswer: "ser",
      },
      finalRating: FsrsRating.GOOD,
    });

    await expect(
      commitPracticeReview({
        userId,
        exerciseId: numericExercise.id,
        attemptId: `${runId}_numeric_exact_attempt`,
        submittedAnswer: "1/2",
        responseMs: 28_000,
        reviewedAt: now,
      }),
    ).resolves.toMatchObject({
      status: "committed",
      answerCheck: {
        status: "correct",
        normalizedAnswer: "0.5",
      },
      finalRating: FsrsRating.GOOD,
    });

    await expect(
      prisma.exerciseAttempt.count({
        where: {
          userId,
          exerciseId: { in: [textExercise.id, numericExercise.id] },
        },
      }),
    ).resolves.toBe(2);
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
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
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

    const invalidTextSkill = await createSkillFixture({
      userId,
      title: "invalid text skill",
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    const invalidTextExercise = await createTextExercise({
      userId,
      skillId: invalidTextSkill.id,
    });
    const invalidNumericSkill = await createSkillFixture({
      userId,
      title: "invalid numeric skill",
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    const invalidNumericExercise = await createNumericExercise({
      userId,
      skillId: invalidNumericSkill.id,
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
      commitPracticeReview({
        userId,
        exerciseId: invalidTextExercise.id,
        attemptId: `${runId}_invalid_text`,
        submittedAnswer: "   ",
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
        exerciseId: invalidNumericExercise.id,
        attemptId: `${runId}_invalid_numeric`,
        submittedAnswer: "not a number",
        responseMs: 4_000,
        reviewedAt: now,
      }),
    ).resolves.toMatchObject({
      status: "not-committed",
      answerCheck: { status: "invalid-input" },
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

  it("returns the committed skill snapshot for idempotent retries", async () => {
    const { userId, skill, exercise } = await createDueChoiceFixture("idempotent_snapshot");
    const attemptId = `${runId}_idempotent_snapshot_attempt`;

    const first = await commitPracticeReview({
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

    if (first.status !== "committed") {
      throw new Error("Expected first review commit to succeed.");
    }

    await prisma.skill.update({
      where: { id: skill.id },
      data: {
        dueAt: new Date("2026-07-01T12:00:00.000Z"),
        stability: 99,
        difficulty: 1,
        elapsedDays: 99,
        scheduledDays: 99,
        learningSteps: 99,
        repetitions: 99,
        lapses: 99,
        lastReviewedAt: new Date("2026-07-01T12:00:00.000Z"),
      },
    });

    await expect(
      commitPracticeReview({
        userId,
        exerciseId: exercise.id,
        attemptId,
        submittedAnswer: "ser",
        responseMs: 20_000,
        reviewedAt: now,
      }),
    ).resolves.toMatchObject({
      status: "committed",
      idempotent: true,
      skill: first.skill,
    });
  });
});
