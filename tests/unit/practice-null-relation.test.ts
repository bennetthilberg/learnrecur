import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => mocks.prisma,
}));

import { AnswerKind, ExerciseType, ExerciseVerificationStatus, SkillFsrsState } from "@/generated/prisma/client";
import { previewNextPracticeItem } from "@/lib/practice";

const now = new Date("2026-06-03T12:00:00.000Z");

function makeSkill() {
  return {
    id: "skill-ready",
    title: "Ready skill",
    collectionId: null,
    dueAt: new Date("2026-06-03T11:00:00.000Z"),
    stability: 1,
    difficulty: 5,
    elapsedDays: 1,
    scheduledDays: 1,
    learningSteps: 0,
    repetitions: 1,
    alreadyStudied: true,
    lapses: 0,
    fsrsState: SkillFsrsState.REVIEW,
    lastReviewedAt: null,
    tags: [],
    objective: null,
    practicePreference: null,
    user: {
      practicePreference: "BALANCED",
      desiredRetention: null,
    },
    collection: null,
  };
}

function makeExercise(skill: ReturnType<typeof makeSkill>) {
  return {
    id: "exercise-ready",
    userId: "user-null-relation",
    skillId: skill.id,
    type: ExerciseType.MULTIPLE_CHOICE,
    answerKind: AnswerKind.CHOICE,
    prompt: "Choose the correct answer.",
    choices: [
      { id: "correct", label: "Correct" },
      { id: "wrong", label: "Wrong" },
    ],
    answerSpec: { kind: "choice", correctChoiceId: "correct" },
    correctAnswerDisplay: "Correct",
    explanation: null,
    difficulty: 1,
    expectedSeconds: 30,
    createdAt: new Date("2026-06-03T08:00:00.000Z"),
    verificationStatus: ExerciseVerificationStatus.VERIFIED,
    retiredAt: null,
    skill,
  };
}

function setupTransaction(exercises: unknown[]) {
  const tx = {
    user: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        dailyNewSkillLimit: null,
        practiceTimezone: "UTC",
        practiceDayStartMinutes: 0,
      }),
    },
    skill: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
    exercise: {
      findMany: vi.fn().mockResolvedValue(exercises),
    },
    exerciseAttempt: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
  };

  mocks.prisma.$transaction.mockImplementationOnce(
    async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  );

  return tx;
}

describe("practice selection with a disappearing relation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("omits a missing skill relation and selects the remaining owned exercise", async () => {
    const skill = makeSkill();
    const tx = setupTransaction([
      {
        ...makeExercise(skill),
        id: "exercise-with-missing-skill",
        skillId: "skill-deleted-during-read",
        skill: null,
      },
      makeExercise(skill),
    ]);

    await expect(
      previewNextPracticeItem({ userId: "user-null-relation", now }),
    ).resolves.toMatchObject({
      status: "ready",
      skill: { id: skill.id },
      exercise: { id: "exercise-ready" },
    });
    expect(tx.exerciseAttempt.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          exerciseId: { in: ["exercise-ready"] },
        }),
      }),
    );
  });

  it("returns the normal empty result when every candidate relation disappeared", async () => {
    const tx = setupTransaction([
      {
        ...makeExercise(makeSkill()),
        id: "exercise-with-missing-skill",
        skillId: "skill-deleted-during-read",
        skill: null,
      },
    ]);

    await expect(
      previewNextPracticeItem({ userId: "user-null-relation", now }),
    ).resolves.toMatchObject({
      status: "none-due",
      message: "No due exercise is ready.",
    });
    expect(tx.skill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-null-relation",
          status: "ACTIVE",
        }),
      }),
    );
  });
});
