import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ExerciseAttemptResult,
  ExerciseFlagAdjudicationStatus,
  ExerciseFlagReason,
  ExerciseEvidenceCorrectionStatus,
  FsrsRating,
  Prisma,
  SkillFsrsState,
} from "@/generated/prisma/client";
import { getCompletedPracticeHistoryPage } from "@/lib/practice/history-read-model";
import { getPrisma } from "@/lib/prisma";

import { createSkillFixture, createTextExercise } from "./test-helpers";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `practice_history_read_model_${randomUUID()}`;
const now = new Date("2026-06-07T14:00:00.000Z");

describeDatabase("completed practice history read model", () => {
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
      },
    });
    return userId;
  }

  async function createHistoryFixture(userId: string, label: string) {
    const skill = await createSkillFixture(prisma, {
      userId,
      title: `Spanish history ${label}`,
    });
    const exercise = await createTextExercise(prisma, userId, skill.id);
    await prisma.exercise.update({
      where: { id: exercise.id },
      data: {
        answerSpec: {
          kind: "text",
          policyVersion: 2,
          accepted: ["actual"],
          normalizeCase: true,
          normalizeWhitespace: true,
          normalizeDiacritics: false,
        },
        correctAnswerDisplay: "actual",
        explanation: "The current exercise explanation.",
      },
    });
    return { skill, exercise };
  }

  async function createAttempt({
    userId,
    skillId,
    exerciseId,
    id,
    result,
    createdAt,
    answer,
    answerPolicySnapshot = Prisma.DbNull,
    practiceContext = Prisma.DbNull,
    scheduled = false,
    reviewedAt = createdAt,
    finalRating = FsrsRating.GOOD,
  }: {
    userId: string;
    skillId: string;
    exerciseId: string;
    id?: string;
    result: ExerciseAttemptResult;
    createdAt: Date;
    answer: Prisma.InputJsonValue;
    answerPolicySnapshot?: Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue;
    practiceContext?: Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue;
    scheduled?: boolean;
    reviewedAt?: Date;
    finalRating?: FsrsRating;
  }) {
    const attempt = await prisma.exerciseAttempt.create({
      data: {
        ...(id ? { id } : {}),
        userId,
        skillId,
        exerciseId,
        answer,
        normalizedAnswer: result === ExerciseAttemptResult.CORRECT ? "actual" : "other",
        isCorrect: result === ExerciseAttemptResult.CORRECT,
        result,
        responseMs: 3400,
        proposedRating: scheduled ? finalRating : null,
        finalRating: scheduled ? finalRating : null,
        answerPolicySnapshot,
        practiceContext,
        createdAt,
      },
    });

    if (scheduled) {
      await prisma.reviewLog.create({
        data: {
          userId,
          skillId,
          exerciseAttemptId: attempt.id,
          finalRating,
          reviewedAt,
          previousDueAt: new Date("2026-06-04T10:00:00.000Z"),
          nextDueAt: new Date("2026-06-08T10:00:00.000Z"),
          previousState: SkillFsrsState.LEARNING,
          nextState: SkillFsrsState.REVIEW,
          schedulerName: "ts-fsrs",
          schedulerVersion: "test",
          desiredRetention: 0.9,
          schedulerParameters: {},
        },
      });
    }

    return attempt;
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

  it("returns scheduled and practice-only completions with immutable evidence context", async () => {
    const userId = await createUser("completed");
    const otherUserId = await createUser("other");
    const { skill, exercise } = await createHistoryFixture(userId, "contract");
    const scheduled = await createAttempt({
      userId,
      skillId: skill.id,
      exerciseId: exercise.id,
      result: ExerciseAttemptResult.CORRECT,
      createdAt: new Date("2026-06-05T12:00:00.000Z"),
      answer: { raw: "saved answer" },
      answerPolicySnapshot: {
        kind: "text",
        policyVersion: 2,
        accepted: ["saved"],
        normalizeCase: false,
        normalizeWhitespace: true,
        normalizeDiacritics: false,
      },
      practiceContext: {
        version: 1,
        answerMode: "TEXT",
        mixedReview: false,
        reducedRuleCues: false,
        assistance: "none",
        sessionId: "scheduled-session",
        sessionMode: "SCHEDULED",
        exposure: "SCHEDULED",
      },
      scheduled: true,
    });
    const practiceOnly = await createAttempt({
      userId,
      skillId: skill.id,
      exerciseId: exercise.id,
      result: ExerciseAttemptResult.INCORRECT,
      createdAt: new Date("2026-06-06T12:00:00.000Z"),
      answer: { raw: { response: "practice answer" } },
      practiceContext: {
        version: 1,
        answerMode: "TEXT",
        mixedReview: true,
        reducedRuleCues: true,
        assistance: "observed",
        sessionId: "practice-session",
        sessionMode: "PRACTICE_ONLY",
        exposure: "PRACTICE_ONLY",
      },
    });
    await createAttempt({
      userId,
      skillId: skill.id,
      exerciseId: exercise.id,
      result: ExerciseAttemptResult.SKIPPED,
      createdAt: new Date("2026-06-06T13:00:00.000Z"),
      answer: { raw: "skipped" },
    });

    const all = await getCompletedPracticeHistoryPage({
      userId,
      skillId: skill.id,
      now,
    });
    const scheduledPage = await getCompletedPracticeHistoryPage({
      userId,
      skillId: skill.id,
      mode: "scheduled",
      now,
    });
    const practiceOnlyPage = await getCompletedPracticeHistoryPage({
      userId,
      skillId: skill.id,
      mode: "practice-only",
      result: "incorrect",
      now,
    });
    const crossUser = await getCompletedPracticeHistoryPage({
      userId: otherUserId,
      skillId: skill.id,
      now,
    });

    expect(all.attempts.map((attempt) => attempt.id)).toEqual([
      practiceOnly.id,
      scheduled.id,
    ]);
    expect(scheduledPage.attempts).toHaveLength(1);
    expect(practiceOnlyPage.attempts).toHaveLength(1);
    expect(crossUser.attempts).toEqual([]);

    expect(scheduledPage.attempts[0]).toMatchObject({
      id: scheduled.id,
      mode: "SCHEDULED",
      submissionType: "scheduled",
      scheduled: true,
      practiceOnly: false,
      reviewLogId: expect.any(String),
      finalRating: FsrsRating.GOOD,
      original: {
        result: ExerciseAttemptResult.CORRECT,
        isCorrect: true,
        finalRating: FsrsRating.GOOD,
      },
      submittedAnswer: "saved answer",
      submittedAnswerStorage: { raw: "saved answer" },
      answerContractSource: "attempt",
      answerContractFallback: false,
      answerContract: {
        answerSpec: {
          accepted: ["saved"],
          normalizeCase: false,
        },
        comparisonPolicy: {
          policyVersion: 2,
          normalizeCase: false,
          normalizeWhitespace: true,
          normalizeDiacritics: false,
        },
      },
      practiceContext: {
        source: "recorded",
        answerMode: "TEXT",
        mixedReview: false,
        reducedRuleCues: false,
        sessionMode: "SCHEDULED",
        exposure: "SCHEDULED",
      },
    });
    expect(practiceOnlyPage.attempts[0]).toMatchObject({
      id: practiceOnly.id,
      mode: "PRACTICE_ONLY",
      submissionType: "practice-only",
      scheduled: false,
      practiceOnly: true,
      reviewLogId: null,
      finalRating: null,
      result: ExerciseAttemptResult.INCORRECT,
      original: {
        result: ExerciseAttemptResult.INCORRECT,
        isCorrect: false,
        finalRating: null,
      },
      submittedAnswer: { response: "practice answer" },
      submittedAnswerStorage: { raw: { response: "practice answer" } },
      answerContractSource: "exercise-fallback",
      answerContractFallback: true,
      answerContractFallbackReason: "missing",
      answerContract: {
        answerSpec: {
          accepted: ["actual"],
        },
      },
      practiceContext: {
        source: "recorded",
        answerMode: "TEXT",
        mixedReview: true,
        reducedRuleCues: true,
        assistance: "observed",
        sessionMode: "PRACTICE_ONLY",
        exposure: "PRACTICE_ONLY",
      },
    });
    expect(all.attempts).toHaveLength(2);
  });

  it("reports correction state without rewriting original history", async () => {
    const userId = await createUser("correction");
    const { skill, exercise } = await createHistoryFixture(userId, "correction");
    const attempt = await createAttempt({
      userId,
      skillId: skill.id,
      exerciseId: exercise.id,
      result: ExerciseAttemptResult.INCORRECT,
      createdAt: new Date("2026-06-05T12:00:00.000Z"),
      answer: { raw: "old answer" },
      scheduled: true,
    });
    const flag = await prisma.exerciseFlag.create({
      data: {
        userId,
        exerciseId: exercise.id,
        reason: ExerciseFlagReason.INCORRECT_ANSWER,
        adjudicationStatus: ExerciseFlagAdjudicationStatus.PENDING,
        evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus.PENDING,
        practiceEvidenceNeedsCorrection: true,
        affectedReviewCount: 5,
      },
    });

    const pending = await getCompletedPracticeHistoryPage({ userId, now });
    expect(pending.attempts[0]).toMatchObject({
      id: attempt.id,
      correction: {
        status: "PENDING",
        adjudicationStatus: "PENDING",
        evidenceCorrectionStatus: "PENDING",
        evidenceExcluded: false,
        affectedReviewCount: 5,
      },
      original: {
        result: ExerciseAttemptResult.INCORRECT,
        isCorrect: false,
      },
    });

    await prisma.exerciseFlag.update({
      where: { id: flag.id },
      data: {
        adjudicationStatus: ExerciseFlagAdjudicationStatus.CONFIRMED,
        evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus.COMPLETE,
        practiceEvidenceNeedsCorrection: false,
      },
    });
    const confirmed = await getCompletedPracticeHistoryPage({ userId, now });
    expect(confirmed.attempts[0]).toMatchObject({
      id: attempt.id,
      correction: {
        status: "COMPLETE",
        adjudicationStatus: "CONFIRMED",
        evidenceCorrectionStatus: "COMPLETE",
        evidenceExcluded: true,
      },
      original: {
        result: ExerciseAttemptResult.INCORRECT,
        isCorrect: false,
      },
    });
    expect(confirmed.attempts[0]?.correction).toEqual(confirmed.attempts[0]?.qualityCorrection);
  });

  it("paginates practice-only attempts by created-at and id within one snapshot", async () => {
    const userId = await createUser("pages");
    const { skill, exercise } = await createHistoryFixture(userId, "pages");
    const createdAt = new Date("2026-06-04T12:00:00.000Z");
    const attempts = [];
    for (const ordinal of ["a", "b", "c"]) {
      attempts.push(
        await createAttempt({
          userId,
          skillId: skill.id,
          exerciseId: exercise.id,
          id: `${runId}_attempt_${ordinal}`,
          result: ExerciseAttemptResult.CORRECT,
          createdAt,
          answer: { raw: ordinal },
          practiceContext: Prisma.DbNull,
        }),
      );
    }

    const first = await getCompletedPracticeHistoryPage({
      userId,
      skillId: skill.id,
      mode: "practice-only",
      limit: 2,
      now,
    });
    expect(first.attempts).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    await createAttempt({
      userId,
      skillId: skill.id,
      exerciseId: exercise.id,
      id: `${runId}_attempt_future`,
      result: ExerciseAttemptResult.CORRECT,
      createdAt: new Date("2026-06-07T15:00:00.000Z"),
      answer: { raw: "future" },
      practiceContext: Prisma.DbNull,
    });

    const second = await getCompletedPracticeHistoryPage({
      userId,
      skillId: skill.id,
      mode: "practice-only",
      limit: 2,
      now: new Date("2026-06-07T16:00:00.000Z"),
      cursor: first.nextCursor ?? undefined,
    });
    const pagedIds = [...first.attempts, ...second.attempts].map((attempt) => attempt.id);

    expect(second.attempts).toHaveLength(1);
    expect(new Set(pagedIds).size).toBe(3);
    expect(pagedIds.toSorted()).toEqual(attempts.map((attempt) => attempt.id).toSorted());
    expect(second.snapshotCutoff).toEqual(first.snapshotCutoff);
    expect(second.nextCursor).toBeNull();
  });
});
