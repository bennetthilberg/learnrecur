import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => {
  const generationJob = {
    count: vi.fn(),
    create: vi.fn(),
    findFirst: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  };
  const prisma = {
    $queryRaw: vi.fn(),
    generationJob,
    skill: { findFirst: vi.fn() },
    $transaction: vi.fn(async (callback: (tx: typeof prisma) => unknown) => callback(prisma)),
  };
  return {
    generationJob,
    prisma,
    refillLimit: vi.fn(),
  };
});

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => fixtures.prisma,
}));

vi.mock("@/lib/usage-limits", () => ({
  checkExerciseRefillUsageLimit: fixtures.refillLimit,
  startOfUtcDay: (now: Date) =>
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())),
}));

vi.mock("@/lib/skills", () => ({
  DEFAULT_READY_EXACT_INPUT_TARGET: 2,
  DEFAULT_READY_EXERCISE_TARGET: 5,
  DEFAULT_READY_MATH_TARGET: 2,
  GEMINI_PROVIDER: "google",
  SKILL_EXACT_INPUT_PROMPT_VERSION: "exact-test",
  SKILL_MATH_PROMPT_VERSION: "math-test",
  SKILL_MCQ_PROMPT_VERSION: "mcq-test",
  countChoiceExerciseInventory: vi.fn(() => ({ readyExerciseCount: 0 })),
  countExactInputExerciseInventory: vi.fn(() => ({ readyExerciseCount: 0 })),
  countMathExerciseInventory: vi.fn(() => ({ readyExerciseCount: 0 })),
  isExactInputUnlocked: vi.fn(() => true),
  refillChoiceExercisesForSkill: vi.fn(),
  refillExactInputExercisesForSkill: vi.fn(),
  refillMathExercisesForSkill: vi.fn(),
}));

import { GenerationJobKind, SkillStatus } from "@/generated/prisma/client";
import { queueChoiceExerciseRefillForSkill } from "@/lib/skills/refill-jobs";

describe("refill quota deferral", () => {
  const now = new Date("2026-06-23T17:45:30.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    fixtures.prisma.skill.findFirst.mockResolvedValue({
      id: "skill-1",
      status: SkillStatus.ACTIVE,
      exercises: [],
    });
    fixtures.generationJob.findFirst.mockResolvedValue(null);
    fixtures.generationJob.upsert.mockImplementation(async ({ create }) => ({
      id: "deferred-job-1",
      create,
    }));
    fixtures.refillLimit.mockResolvedValue({
      status: "limited",
      code: "daily-exercise-refill-limit",
      message: "refill quota reached",
      resetAt: "2026-06-24T00:00:00.000Z",
    });
  });

  it("persists one idempotent marker and does not publish deferred work", async () => {
    const sender = {
      sendChoiceRefillRequested: vi.fn(),
      sendExactInputRefillRequested: vi.fn(),
      sendMathRefillRequested: vi.fn(),
    };

    const first = await queueChoiceExerciseRefillForSkill({
      userId: "user-1",
      skillId: "skill-1",
      now,
      sender,
      model: "test-gemini",
    });
    const second = await queueChoiceExerciseRefillForSkill({
      userId: "user-1",
      skillId: "skill-1",
      now,
      sender,
      model: "test-gemini",
    });

    expect(first).toMatchObject({
      status: "deferred",
      generationJobId: "deferred-job-1",
      retryAt: "2026-06-24T00:00:00.000Z",
    });
    expect(second).toMatchObject({
      status: "deferred",
      generationJobId: "deferred-job-1",
    });
    expect(fixtures.generationJob.upsert).toHaveBeenCalledTimes(2);
    expect(fixtures.generationJob.upsert.mock.calls[0][0]).toMatchObject({
      where: {
        userId_idempotencyKey: {
          userId: "user-1",
          idempotencyKey: `${GenerationJobKind.CHOICE_EXERCISE_GENERATION}:skill-1:deferred-quota:2026-06-23T00:00:00.000Z`,
        },
      },
      create: {
        checkpoint: "deferred-quota",
        failureCategory: "COST_LIMIT",
        status: "FAILED",
        stage: "FAILED",
      },
    });
    expect(sender.sendChoiceRefillRequested).not.toHaveBeenCalled();
  });
});
