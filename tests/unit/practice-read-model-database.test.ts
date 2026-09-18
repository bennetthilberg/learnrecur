import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exerciseFindMany: vi.fn(),
  exerciseFindFirst: vi.fn(),
  attemptFindMany: vi.fn(),
  attemptQueryRaw: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  getPrisma: () => ({
    $queryRaw: mocks.attemptQueryRaw,
    exercise: {
      findMany: mocks.exerciseFindMany,
      findFirst: mocks.exerciseFindFirst,
    },
    exerciseAttempt: {
      findMany: mocks.attemptFindMany,
    },
  }),
}));

import { mapExerciseAuditRecord } from "@/lib/practice/exercise-audit";
import { getCompletedPracticeHistoryPage } from "@/lib/practice/history-read-model";

const now = new Date("2026-06-07T14:00:00.000Z");

function auditRow(id: string) {
  return {
    id,
    skillId: "skill-1",
    type: "EXACT_INPUT",
    answerKind: "TEXT",
    prompt: "Type the answer.",
    choices: null,
    answerSpec: {
      kind: "text",
      policyVersion: 2,
      accepted: ["actual"],
      normalizeCase: true,
      normalizeWhitespace: true,
      normalizeDiacritics: false,
    },
    correctAnswerDisplay: "actual",
    explanation: "The answer is actual.",
    difficulty: 2,
    expectedSeconds: 20,
    verificationStatus: "VERIFIED",
    retiredAt: null,
    retirementReason: null,
    skillSpecVersion: "skill-spec-v1",
    skillSpecFingerprint: null,
    exerciseSpecVersion: "exercise-spec-v1",
    blueprintVersion: null,
    blueprintSlot: null,
    exerciseFamily: "formation",
    qualityVersion: "quality-v1",
    provenance: null,
    sourceRefs: null,
    acceptanceDecision: "PUBLISHED",
    generationMetadata: null,
    createdAt: new Date("2026-06-01T12:00:00.000Z"),
    updatedAt: new Date("2026-06-02T12:00:00.000Z"),
    skill: {
      id: "skill-1",
      title: "Spanish answer",
      status: "ACTIVE",
      sourceRefs: [],
    },
  };
}

function historyRow() {
  return {
    id: "attempt-1",
    skillId: "skill-1",
    exerciseId: "exercise-1",
    ratingPolicyVersion: "practice-only-v1",
    practiceContext: {
      version: 1,
      answerMode: "CHOICE",
      mixedReview: true,
      reducedRuleCues: true,
      assistance: "none",
      sessionMode: "PRACTICE_ONLY",
      exposure: "PRACTICE_ONLY",
    },
    answerPolicySnapshot: null,
    answer: { raw: "right" },
    normalizedAnswer: "right",
    isCorrect: true,
    result: "CORRECT",
    responseMs: 1200,
    proposedRating: null,
    finalRating: null,
    feedbackShownAt: new Date("2026-06-06T12:00:01.000Z"),
    createdAt: new Date("2026-06-06T12:00:00.000Z"),
    reviewLog: null,
    exercise: {
      id: "exercise-1",
      type: "MULTIPLE_CHOICE",
      answerKind: "CHOICE",
      prompt: "Choose the answer.",
      choices: [
        { id: "right", label: "Right" },
        { id: "wrong", label: "Wrong" },
      ],
      answerSpec: { kind: "choice", correctChoiceId: "right" },
      correctAnswerDisplay: "Right",
      explanation: "Right is correct.",
      generationMetadata: null,
      flags: [],
    },
    skill: {
      id: "skill-1",
      title: "Spanish choices",
      status: "ACTIVE",
      collectionId: null,
      collection: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("practice read model database projections", () => {
  it("maps audit rows without returning generation metadata", () => {
    const record = mapExerciseAuditRecord(auditRow("exercise-1") as never);

    expect(record).toMatchObject({
      id: "exercise-1",
      answerContract: {
        answerSpec: {
          accepted: ["actual"],
        },
      },
      acceptedVariants: [{ kind: "text", value: "actual" }],
      verificationSummary: {
        status: "VERIFIED",
        acceptanceDecision: "PUBLISHED",
      },
    });
    expect(JSON.stringify(record)).not.toContain("generationMetadata");
  });

  it("evaluates audit lifecycle against the requested snapshot cutoff", () => {
    const record = mapExerciseAuditRecord(
      {
        ...auditRow("exercise-retired-after-snapshot"),
        retiredAt: new Date("2026-06-08T12:00:00.000Z"),
        retirementReason: "quality issue",
      } as never,
      new Date("2026-06-07T12:00:00.000Z"),
    );

    expect(record).toMatchObject({
      lifecycle: "active",
      retirement: { isRetired: false },
    });
  });

  it("maps immutable practice-only answers and applies the requested read filter", async () => {
    mocks.attemptQueryRaw.mockResolvedValue([{ id: "attempt-1" }]);
    mocks.attemptFindMany.mockResolvedValue([historyRow()]);

    const page = await getCompletedPracticeHistoryPage({
      userId: "user-1",
      mode: "practice_only",
      result: "CORRECT",
      limit: 20,
      now,
    });

    expect(page.attempts[0]).toMatchObject({
      id: "attempt-1",
      mode: "PRACTICE_ONLY",
      answerMode: "CHOICE",
      answerModeSource: "recorded",
      submittedAnswer: "right",
      submittedAnswerStorage: { raw: "right" },
      submittedAnswerDisplay: "Right",
      answerContractSource: "exercise-fallback",
      answerContractFallbackReason: "missing",
      mixedReview: true,
      reducedRuleCues: true,
    });
    expect(mocks.attemptQueryRaw).toHaveBeenCalledTimes(1);
    expect(mocks.attemptFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          id: { in: ["attempt-1"] },
        },
      }),
    );
  });

  it("accepts equivalent mode aliases without treating them as conflicting", async () => {
    mocks.attemptQueryRaw.mockResolvedValue([]);

    await expect(
      getCompletedPracticeHistoryPage({
        userId: "user-1",
        mode: "practice-only",
        submissionType: "practice_only",
        now,
      }),
    ).resolves.toMatchObject({ attempts: [], nextCursor: null });
    expect(mocks.attemptQueryRaw).toHaveBeenCalledTimes(1);
  });
});
