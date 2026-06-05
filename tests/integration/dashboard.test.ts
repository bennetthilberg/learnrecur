import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AnswerKind,
  CollectionStatus,
  ExerciseAttemptResult,
  ExerciseRetirementReason,
  ExerciseType,
  ExerciseVerificationStatus,
  SkillFsrsState,
  SkillStatus,
} from "@/generated/prisma/client";
import { getDashboardHome } from "@/lib/dashboard";
import { ensureDevPracticeSampleData } from "@/lib/practice/sample-data";
import { getPrisma } from "@/lib/prisma";
import { EXACT_INPUT_UNLOCK_REPETITIONS } from "@/lib/skills";

import {
  createNumericExercise,
  createSkillFixture,
  createTextExercise,
} from "./test-helpers";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `dashboard_${randomUUID()}`;
const now = new Date("2026-06-04T12:00:00.000Z");

describeDatabase("dashboard home read model", () => {
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

  async function createCollection(userId: string, name: string) {
    return prisma.collection.create({
      data: {
        userId,
        name,
        status: CollectionStatus.ACTIVE,
      },
    });
  }

  async function createChoiceExercise({
    userId,
    skillId,
    verificationStatus = ExerciseVerificationStatus.VERIFIED,
    retiredAt = null,
    choices = [
      { id: "right", label: "Right" },
      { id: "wrong", label: "Wrong" },
    ],
  }: {
    userId: string;
    skillId: string;
    verificationStatus?: ExerciseVerificationStatus;
    retiredAt?: Date | null;
    choices?: Array<{ id: string; label?: string }>;
  }) {
    return prisma.exercise.create({
      data: {
        userId,
        skillId,
        type: ExerciseType.MULTIPLE_CHOICE,
        answerKind: AnswerKind.CHOICE,
        prompt: "Choose the right answer.",
        choices,
        answerSpec: {
          kind: "choice",
          correctChoiceId: "right",
        },
        correctAnswerDisplay: "Right",
        verificationStatus,
        retiredAt,
        retirementReason: retiredAt ? ExerciseRetirementReason.MANUAL : null,
      },
    });
  }

  async function createAttempt({
    userId,
    skillId,
    exerciseId,
    createdAt,
    result,
  }: {
    userId: string;
    skillId: string;
    exerciseId: string;
    createdAt: Date;
    result: ExerciseAttemptResult;
  }) {
    return prisma.exerciseAttempt.create({
      data: {
        userId,
        skillId,
        exerciseId,
        answer: "right",
        normalizedAnswer: "right",
        isCorrect: result === ExerciseAttemptResult.CORRECT,
        result,
        createdAt,
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

  it("summarizes ready practice, active skills, collections, and recent accuracy for one user", async () => {
    const userId = await createUser("home");
    const grammar = await createCollection(userId, "Spanish grammar");
    const vocabulary = await createCollection(userId, "Spanish vocabulary");

    const readySkill = await createSkillFixture(prisma, {
      userId,
      collectionId: grammar.id,
      title: "Ser vs. estar",
      tags: ["spanish", "grammar"],
    });
    const readyExercise = await createChoiceExercise({ userId, skillId: readySkill.id });

    const futureSkill = await createSkillFixture(prisma, {
      userId,
      collectionId: grammar.id,
      title: "Future tense",
      dueAt: new Date("2026-06-05T09:00:00.000Z"),
    });
    await createChoiceExercise({ userId, skillId: futureSkill.id });

    const textOnlySkill = await createSkillFixture(prisma, {
      userId,
      collectionId: vocabulary.id,
      title: "Exact accent marks",
      dueAt: new Date("2026-06-03T09:30:00.000Z"),
    });
    await createTextExercise(prisma, userId, textOnlySkill.id);

    const pausedSkill = await createSkillFixture(prisma, {
      userId,
      collectionId: vocabulary.id,
      title: "Paused skill",
      status: SkillStatus.PAUSED,
    });
    await createChoiceExercise({ userId, skillId: pausedSkill.id });

    const draftSkill = await createSkillFixture(prisma, {
      userId,
      collectionId: vocabulary.id,
      title: "Draft skill",
      status: SkillStatus.DRAFT,
    });
    await createChoiceExercise({ userId, skillId: draftSkill.id });

    const uninitializedSkill = await createSkillFixture(prisma, {
      userId,
      collectionId: vocabulary.id,
      title: "Missing schedule",
      initialized: false,
    });
    await createChoiceExercise({ userId, skillId: uninitializedSkill.id });

    const unverifiedSkill = await createSkillFixture(prisma, {
      userId,
      collectionId: vocabulary.id,
      title: "Unverified exercise",
      dueAt: new Date("2026-06-03T10:00:00.000Z"),
    });
    await createChoiceExercise({
      userId,
      skillId: unverifiedSkill.id,
      verificationStatus: ExerciseVerificationStatus.UNVERIFIED,
    });

    const retiredSkill = await createSkillFixture(prisma, {
      userId,
      collectionId: vocabulary.id,
      title: "Retired exercise",
      dueAt: new Date("2026-06-03T10:15:00.000Z"),
    });
    await createChoiceExercise({
      userId,
      skillId: retiredSkill.id,
      retiredAt: new Date("2026-06-04T08:00:00.000Z"),
    });

    await createAttempt({
      userId,
      skillId: readySkill.id,
      exerciseId: readyExercise.id,
      createdAt: new Date("2026-06-03T11:00:00.000Z"),
      result: ExerciseAttemptResult.CORRECT,
    });
    await createAttempt({
      userId,
      skillId: readySkill.id,
      exerciseId: readyExercise.id,
      createdAt: new Date("2026-06-02T11:00:00.000Z"),
      result: ExerciseAttemptResult.INCORRECT,
    });
    await createAttempt({
      userId,
      skillId: readySkill.id,
      exerciseId: readyExercise.id,
      createdAt: new Date("2026-06-01T11:00:00.000Z"),
      result: ExerciseAttemptResult.SKIPPED,
    });
    await createAttempt({
      userId,
      skillId: readySkill.id,
      exerciseId: readyExercise.id,
      createdAt: new Date("2026-05-01T11:00:00.000Z"),
      result: ExerciseAttemptResult.CORRECT,
    });

    const otherUserId = await createUser("other");
    const otherCollection = await createCollection(otherUserId, "Other collection");
    const otherSkill = await createSkillFixture(prisma, {
      userId: otherUserId,
      collectionId: otherCollection.id,
      title: "Other user's ready skill",
    });
    await createChoiceExercise({ userId: otherUserId, skillId: otherSkill.id });

    const dashboard = await getDashboardHome({ userId, now });

    expect(dashboard).toMatchObject({
      readyNowCount: 1,
      activeSkillCount: 6,
      recentReviewCount: 2,
      recentAccuracyPercent: 50,
      collections: [
        {
          id: grammar.id,
          name: "Spanish grammar",
          activeSkillCount: 2,
          readyNowCount: 1,
        },
        {
          id: vocabulary.id,
          name: "Spanish vocabulary",
          activeSkillCount: 4,
          readyNowCount: 0,
        },
      ],
    });

    expect(dashboard.skills.slice(0, 2)).toMatchObject([
      {
        id: readySkill.id,
        title: "Ser vs. estar",
        collectionName: "Spanish grammar",
        tags: ["spanish", "grammar"],
        fsrsState: SkillFsrsState.NEW,
        repetitions: 0,
        lapses: 0,
        isReadyNow: true,
        dueLabel: "Due now",
      },
      {
        id: textOnlySkill.id,
        title: "Exact accent marks",
        isReadyNow: false,
        dueLabel: "Not available in practice yet",
      },
    ]);
    expect(dashboard.collections).toHaveLength(2);
    expect(dashboard.skills.map((skill) => skill.title)).not.toContain("Other user's ready skill");
  });

  it("returns empty recent accuracy when there are no recent committed answers", async () => {
    const userId = await createUser("no_attempts");
    const collection = await createCollection(userId, "Empty collection");
    const skill = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "Ready without reviews",
    });
    await createChoiceExercise({ userId, skillId: skill.id });

    await expect(getDashboardHome({ userId, now })).resolves.toMatchObject({
      readyNowCount: 1,
      activeSkillCount: 1,
      recentReviewCount: 0,
      recentAccuracyPercent: null,
    });
  });

  it("does not count malformed choice exercises as ready for the current practice UI", async () => {
    const userId = await createUser("malformed_choices");
    const collection = await createCollection(userId, "Malformed collection");
    const skill = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "Broken options",
    });
    await createChoiceExercise({
      userId,
      skillId: skill.id,
      choices: [{ id: "right" }],
    });

    await expect(getDashboardHome({ userId, now })).resolves.toMatchObject({
      readyNowCount: 0,
      activeSkillCount: 1,
      collections: [
        {
          id: collection.id,
          readyNowCount: 0,
        },
      ],
      skills: [
        {
          id: skill.id,
          isReadyNow: false,
          dueLabel: "Not available in practice yet",
        },
      ],
    });
  });

  it("counts exact-input readiness using the current practice eligibility rules", async () => {
    const userId = await createUser("exact_readiness");
    const otherUserId = await createUser("exact_readiness_other");
    const collection = await createCollection(userId, "Exact input collection");
    const otherCollection = await createCollection(otherUserId, "Other exact collection");

    const readyTextSkill = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "Unlocked exact text",
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    await createTextExercise(prisma, userId, readyTextSkill.id);

    const readyNumericSkill = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "Unlocked numeric",
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
      dueAt: new Date("2026-06-03T09:15:00.000Z"),
    });
    await createNumericExercise(prisma, userId, readyNumericSkill.id);

    const lockedExactSkill = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "Locked exact text",
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS - 1,
      dueAt: new Date("2026-06-03T09:30:00.000Z"),
    });
    await createTextExercise(prisma, userId, lockedExactSkill.id);

    const malformedExactSkill = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "Malformed exact text",
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
      dueAt: new Date("2026-06-03T09:45:00.000Z"),
    });
    // Deliberately createTextExercise with malformedExactSkill and answerSpec.kind = "numeric"
    // to validate TEXT exercise/spec-kind mismatch detection.
    await createTextExercise(prisma, userId, malformedExactSkill.id, {
      answerSpec: {
        kind: "numeric",
        accepted: ["1/2"],
        tolerance: 0,
      },
    });

    const unverifiedExactSkill = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "Unverified exact text",
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
      dueAt: new Date("2026-06-03T10:00:00.000Z"),
    });
    await createTextExercise(prisma, userId, unverifiedExactSkill.id, {
      verificationStatus: ExerciseVerificationStatus.UNVERIFIED,
    });

    const retiredExactSkill = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "Retired exact text",
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
      dueAt: new Date("2026-06-03T10:15:00.000Z"),
    });
    await createTextExercise(prisma, userId, retiredExactSkill.id, {
      retiredAt: new Date("2026-06-04T08:00:00.000Z"),
    });

    const mathSkill = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "Math exact",
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
      dueAt: new Date("2026-06-03T10:30:00.000Z"),
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

    const otherSkill = await createSkillFixture(prisma, {
      userId: otherUserId,
      collectionId: otherCollection.id,
      title: "Other user's exact skill",
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    await createTextExercise(prisma, otherUserId, otherSkill.id);

    const dashboard = await getDashboardHome({ userId, now });

    expect(dashboard).toMatchObject({
      readyNowCount: 2,
      activeSkillCount: 7,
      collections: [
        {
          id: collection.id,
          readyNowCount: 2,
        },
      ],
    });
    expect(dashboard.skills.find((skill) => skill.id === readyTextSkill.id)).toMatchObject({
      isReadyNow: true,
      dueLabel: "Due now",
    });
    expect(dashboard.skills.find((skill) => skill.id === readyNumericSkill.id)).toMatchObject({
      isReadyNow: true,
      dueLabel: "Due now",
    });

    for (const notReadySkill of [
      lockedExactSkill,
      malformedExactSkill,
      unverifiedExactSkill,
      retiredExactSkill,
      mathSkill,
    ]) {
      expect(dashboard.skills.find((skill) => skill.id === notReadySkill.id)).toMatchObject({
        isReadyNow: false,
        dueLabel: "Not available in practice yet",
      });
    }

    expect(dashboard.skills.map((skill) => skill.id)).not.toContain(otherSkill.id);
  });

  it("does not unretire flagged sample exercises when sample data is reseeded", async () => {
    const userId = await createUser("sample_retirement");
    const retiredAt = new Date("2026-06-04T09:00:00.000Z");

    await ensureDevPracticeSampleData({ userId, now });

    const sampleExercise = await prisma.exercise.findFirstOrThrow({
      where: {
        userId,
        freshnessKey: { startsWith: "learnrecur-sample:" },
      },
    });

    await prisma.exercise.update({
      where: { id: sampleExercise.id },
      data: {
        retiredAt,
        retirementReason: ExerciseRetirementReason.FLAGGED_UNCLEAR,
      },
    });

    await ensureDevPracticeSampleData({
      userId,
      now: new Date("2026-06-04T12:30:00.000Z"),
    });

    await expect(
      prisma.exercise.findUniqueOrThrow({
        where: { id: sampleExercise.id },
        select: {
          retiredAt: true,
          retirementReason: true,
        },
      }),
    ).resolves.toEqual({
      retiredAt,
      retirementReason: ExerciseRetirementReason.FLAGGED_UNCLEAR,
    });
  });
});
