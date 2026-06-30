import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authProtect: vi.fn(),
  currentUser: vi.fn(),
  ensureDatabaseUser: vi.fn(),
  previewPracticeAnswer: vi.fn(),
  commitPracticeReview: vi.fn(),
  flagPracticeExerciseAndQueueRefill: vi.fn(),
  ensureDevPracticeSampleData: vi.fn(),
  getNextChoicePracticeItemForUser: vi.fn(),
  getNextPracticeItemForUser: vi.fn(),
  resolvePracticeScopeForUser: vi.fn(),
}));

vi.mock("@clerk/nextjs/server", () => ({
  auth: {
    protect: mocks.authProtect,
  },
  currentUser: mocks.currentUser,
}));

vi.mock("@/lib/users", () => ({
  ensureDatabaseUser: mocks.ensureDatabaseUser,
}));

vi.mock("@/lib/practice", () => ({
  previewPracticeAnswer: mocks.previewPracticeAnswer,
  commitPracticeReview: mocks.commitPracticeReview,
  flagPracticeExerciseAndQueueRefill: mocks.flagPracticeExerciseAndQueueRefill,
}));

vi.mock("@/lib/practice/sample-data", () => ({
  ensureDevPracticeSampleData: mocks.ensureDevPracticeSampleData,
}));

vi.mock("@/app/practice/queries", () => ({
  getNextChoicePracticeItemForUser: mocks.getNextChoicePracticeItemForUser,
  getNextPracticeItemForUser: mocks.getNextPracticeItemForUser,
  resolvePracticeScopeForUser: mocks.resolvePracticeScopeForUser,
}));

describe("practice server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authProtect.mockResolvedValue({ userId: "user_alpha" });
    mocks.currentUser.mockResolvedValue({
      id: "user_alpha",
      primaryEmailAddress: {
        emailAddress: "blocked@example.com",
      },
    });
    mocks.ensureDatabaseUser.mockResolvedValue({
      status: "missing-env",
      message: "Add DATABASE_URL to .env.local, then run Prisma migration and reload this page.",
    });
  });

  it("stops practice mutations when account setup is not ready", async () => {
    const {
      commitPracticeReviewAction,
      flagPracticeExerciseAction,
      previewPracticeAnswerAction,
    } = await import("@/app/practice/actions");

    await expect(
      previewPracticeAnswerAction({
        exerciseId: "exercise_1",
        submittedAnswer: "answer",
        responseMs: 1000,
      }),
    ).resolves.toEqual({
      status: "not-found",
      message: "Add DATABASE_URL to .env.local, then run Prisma migration and reload this page.",
    });

    await expect(
      commitPracticeReviewAction({
        exerciseId: "exercise_1",
        submittedAnswer: "answer",
        responseMs: 1000,
        attemptId: "attempt_1",
      }),
    ).resolves.toEqual({
      status: "not-found",
      message: "Add DATABASE_URL to .env.local, then run Prisma migration and reload this page.",
    });

    await expect(
      flagPracticeExerciseAction({
        exerciseId: "exercise_1",
        reasons: ["WRONG_ANSWER"],
      }),
    ).resolves.toEqual({
      status: "not-found",
      message: "Add DATABASE_URL to .env.local, then run Prisma migration and reload this page.",
    });

    expect(mocks.previewPracticeAnswer).not.toHaveBeenCalled();
    expect(mocks.commitPracticeReview).not.toHaveBeenCalled();
    expect(mocks.flagPracticeExerciseAndQueueRefill).not.toHaveBeenCalled();
  });
});
