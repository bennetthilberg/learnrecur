import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  ExerciseEvidenceCorrectionStatus,
  ExerciseFlagAdjudicationStatus,
  ExerciseFlagReason,
} from "@/generated/prisma/client";
import {
  adjudicateExerciseQualityIncident,
  commitPracticeOnlyAttemptInTransaction,
  commitPracticeReview,
  flagPracticeExercise,
} from "@/lib/practice";
import { getPrisma } from "@/lib/prisma";
import { getExerciseQualityIssues } from "@/lib/practice/quality-issues";
import { advanceSkillSchedule, createInitialSkillSchedule } from "@/lib/scheduling";

import { createChoiceExercise, createSkillFixture } from "./test-helpers";

const describeDatabase = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
const runId = `quality_incidents_${randomUUID()}`;

describeDatabase("quality incident adjudication and schedule replay", () => {
  const prisma = getPrisma();
  const userIds: string[] = [];

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  async function createUser(label: string) {
    const id = `${runId}_${label}`;
    userIds.push(id);
    return prisma.user.create({ data: { id, email: `${id}@example.com` } });
  }

  async function commitScheduled(input: {
    userId: string;
    skillId: string;
    exerciseId: string;
    label: string;
    reviewedAt: Date;
  }) {
    const result = await commitPracticeReview({
      userId: input.userId,
      exerciseId: input.exerciseId,
      expectedSkillId: input.skillId,
      attemptId: `${runId}_${input.label}`,
      submittedAnswer: "right",
      reviewedAt: input.reviewedAt,
      allowNotDue: true,
    });
    expect(result.status).toBe("committed");
    if (result.status !== "committed") throw new Error("expected scheduled review");
    return result;
  }

  async function currentIssueVersion(exerciseId: string) {
    const flag = await prisma.exerciseFlag.findFirstOrThrow({
      where: { exerciseId },
      orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
      select: { updatedAt: true },
    });
    return flag.updatedAt;
  }

  it("replays the union of confirmed defects once, keeps history annotated, and remains idempotent", async () => {
    const user = await createUser("union");
    const firstAt = new Date("2026-09-01T12:00:00.000Z");
    const secondAt = new Date("2026-09-02T12:00:00.000Z");
    const validAt = new Date("2026-09-03T12:00:00.000Z");
    const firstResolutionAt = new Date("2026-09-04T12:00:00.000Z");
    const secondResolutionAt = new Date("2026-09-05T12:00:00.000Z");
    const skill = await createSkillFixture(prisma, {
      userId: user.id,
      title: "Spanish union replay",
      dueAt: new Date("2026-08-31T12:00:00.000Z"),
    });
    const [firstBad, secondBad, valid] = await Promise.all([
      createChoiceExercise({ prisma, userId: user.id, skillId: skill.id, prompt: "First bad prompt" }),
      createChoiceExercise({ prisma, userId: user.id, skillId: skill.id, prompt: "Second bad prompt" }),
      createChoiceExercise({ prisma, userId: user.id, skillId: skill.id, prompt: "Valid prompt" }),
    ]);
    await prisma.exercise.updateMany({
      where: { id: { in: [firstBad.id, secondBad.id, valid.id] } },
      data: { exerciseFamily: "same-family", qualityVersion: "quality-v1" },
    });
    const initial = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    const firstReview = await commitScheduled({
      userId: user.id,
      skillId: skill.id,
      exerciseId: firstBad.id,
      label: "union_first",
      reviewedAt: firstAt,
    });
    await commitScheduled({
      userId: user.id,
      skillId: skill.id,
      exerciseId: secondBad.id,
      label: "union_second",
      reviewedAt: secondAt,
    });
    await commitScheduled({
      userId: user.id,
      skillId: skill.id,
      exerciseId: valid.id,
      label: "union_valid",
      reviewedAt: validAt,
    });

    await expect(flagPracticeExercise({
      userId: user.id,
      exerciseId: firstBad.id,
      reasons: [ExerciseFlagReason.INCORRECT_ANSWER, ExerciseFlagReason.UNCLEAR_PROMPT],
      flaggedAt: new Date("2026-09-03T13:00:00.000Z"),
    })).resolves.toMatchObject({ status: "flagged", flagCount: 2 });
    const pendingIssues = await getExerciseQualityIssues({ userId: user.id });
    expect(pendingIssues).toHaveLength(1);
    expect(pendingIssues[0]).toMatchObject({
      exerciseId: firstBad.id,
      skillTitle: "Spanish union replay",
      prompt: "First bad prompt",
      correctAnswerDisplay: "right",
      flags: expect.arrayContaining([
        expect.objectContaining({ reason: ExerciseFlagReason.INCORRECT_ANSWER }),
        expect.objectContaining({ reason: ExerciseFlagReason.UNCLEAR_PROMPT }),
      ]),
    });
    const firstDecision = await adjudicateExerciseQualityIncident({
      userId: user.id,
      exerciseId: firstBad.id,
      adjudication: "confirmed",
      adjudicationCode: "verified first answer defect",
      now: firstResolutionAt,
      expectedUpdatedAt: await currentIssueVersion(firstBad.id),
      idempotencyKey: `${runId}_resolve_first`,
    });
    expect(firstDecision).toMatchObject({
      status: "adjudicated",
      affectedAttemptCount: 1,
      affectedReviewCount: 1,
      replayedReviewCount: 2,
      idempotent: false,
      quarantinedExerciseCount: 0,
    });

    const secondFlag = await flagPracticeExercise({
      userId: user.id,
      exerciseId: secondBad.id,
      reasons: [ExerciseFlagReason.INCORRECT_ANSWER],
      flaggedAt: new Date("2026-09-04T13:00:00.000Z"),
    });
    expect(secondFlag.status).toBe("flagged");
    const secondDecision = await adjudicateExerciseQualityIncident({
      userId: user.id,
      exerciseId: secondBad.id,
      adjudication: "confirmed",
      adjudicationCode: "verified second answer defect",
      now: secondResolutionAt,
      expectedUpdatedAt: await currentIssueVersion(secondBad.id),
      idempotencyKey: `${runId}_resolve_second`,
    });
    expect(secondDecision).toMatchObject({
      status: "adjudicated",
      affectedAttemptCount: 2,
      affectedReviewCount: 2,
      replayedReviewCount: 1,
      idempotent: false,
      quarantinedExerciseCount: 0,
    });

    const validLog = await prisma.reviewLog.findUniqueOrThrow({
      where: { exerciseAttemptId: `${runId}_union_valid` },
    });
    const expected = advanceSkillSchedule({
      current: {
        dueAt: initial.dueAt!,
        stability: initial.stability!,
        difficulty: initial.difficulty!,
        elapsedDays: initial.elapsedDays,
        scheduledDays: initial.scheduledDays,
        learningSteps: initial.learningSteps,
        repetitions: initial.repetitions,
        lapses: initial.lapses,
        fsrsState: initial.fsrsState,
        lastReviewedAt: initial.lastReviewedAt,
      },
      rating: validLog.finalRating,
      reviewedAt: validAt,
      desiredRetention: validLog.desiredRetention,
    }).skillUpdate;
    const finalSkill = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(finalSkill).toMatchObject(expected);
    expect(finalSkill.firstIntroducedAt).toEqual(firstAt);

    const attempts = await prisma.exerciseAttempt.findMany({
      where: { skillId: skill.id },
      orderBy: { createdAt: "asc" },
      select: { exerciseId: true, evidenceCorrectionStatus: true, evidenceCorrectionNote: true },
    });
    expect(attempts.filter((attempt) => attempt.exerciseId === valid.id)).toEqual([
      expect.objectContaining({
        evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus.NOT_REQUIRED,
        evidenceCorrectionNote: null,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.exerciseId !== valid.id)).toHaveLength(2);
    expect(attempts.filter((attempt) => attempt.exerciseId !== valid.id).every((attempt) =>
      attempt.evidenceCorrectionStatus === ExerciseEvidenceCorrectionStatus.COMPLETE &&
      attempt.evidenceCorrectionNote?.includes("Retained historical evidence"),
    )).toBe(true);

    const logs = await prisma.reviewLog.findMany({
      where: { skillId: skill.id },
      select: { exerciseAttemptId: true, evidenceCorrectionStatus: true, evidenceCorrectionNote: true },
    });
    expect(logs.filter((log) => log.exerciseAttemptId === firstReview.attempt.id)[0]).toMatchObject({
      evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus.COMPLETE,
    });
    expect(logs.filter((log) => log.exerciseAttemptId === `${runId}_union_valid`)[0]).toMatchObject({
      evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus.NOT_REQUIRED,
      evidenceCorrectionNote: null,
    });

    const firstFlags = await prisma.exerciseFlag.findMany({ where: { exerciseId: firstBad.id } });
    expect(firstFlags).toHaveLength(2);
    expect(firstFlags.every((flag) => flag.adjudicationStatus === ExerciseFlagAdjudicationStatus.CONFIRMED)).toBe(true);
    expect(firstFlags.every((flag) => flag.affectedReviewCount === 1)).toBe(true);
    expect((await prisma.exercise.findUniqueOrThrow({ where: { id: valid.id } })).retiredAt).toBeNull();

    const idempotent = await adjudicateExerciseQualityIncident({
      userId: user.id,
      exerciseId: secondBad.id,
      adjudication: "confirmed",
      adjudicationCode: "verified second answer defect",
      now: new Date("2026-09-06T12:00:00.000Z"),
      expectedUpdatedAt: await currentIssueVersion(secondBad.id),
      idempotencyKey: `${runId}_resolve_second`,
    });
    expect(idempotent).toMatchObject({ idempotent: true, affectedReviewCount: 2, replayedReviewCount: 1 });
    await expect(adjudicateExerciseQualityIncident({
      userId: user.id,
      exerciseId: secondBad.id,
      adjudication: "confirmed",
      adjudicationCode: "different decision with same key",
      now: new Date("2026-09-06T13:00:00.000Z"),
      idempotencyKey: `${runId}_resolve_second`,
    })).rejects.toMatchObject({ code: "idempotency-conflict" });
    await expect(adjudicateExerciseQualityIncident({
      userId: user.id,
      exerciseId: secondBad.id,
      adjudication: "inconclusive",
      adjudicationCode: "attempted reversal",
      now: new Date("2026-09-06T14:00:00.000Z"),
    })).rejects.toMatchObject({ code: "already-confirmed" });
  });

  it("keeps first introduction and resets a zero-valid-review skill while excluding practice-only attempts", async () => {
    const user = await createUser("zero_valid");
    const firstAt = new Date("2026-09-07T12:00:00.000Z");
    const practiceAt = new Date("2026-09-07T13:00:00.000Z");
    const resolutionAt = new Date("2026-09-08T12:00:00.000Z");
    const skill = await createSkillFixture(prisma, {
      userId: user.id,
      title: "Spanish practice-only replay",
      dueAt: new Date("2026-09-06T12:00:00.000Z"),
    });
    const exercise = await createChoiceExercise({ prisma, userId: user.id, skillId: skill.id });
    await commitScheduled({
      userId: user.id,
      skillId: skill.id,
      exerciseId: exercise.id,
      label: "zero_valid_scheduled",
      reviewedAt: firstAt,
    });
    const practice = await prisma.$transaction((tx) => commitPracticeOnlyAttemptInTransaction(tx, {
      userId: user.id,
      exerciseId: exercise.id,
      expectedSkillId: skill.id,
      attemptId: `${runId}_zero_valid_practice`,
      submittedAnswer: "right",
      now: practiceAt,
      mixedReview: true,
      reducedRuleCues: false,
      sessionContext: {
        sessionId: `${runId}_session`,
        sessionMode: "PRACTICE_ONLY",
        exposure: "PRACTICE_ONLY",
      },
    }));
    expect(practice.status).toBe("committed");
    if (practice.status !== "committed") throw new Error("expected practice-only attempt");
    const beforeResolution = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    const originalIntroduction = beforeResolution.firstIntroducedAt;

    await flagPracticeExercise({
      userId: user.id,
      exerciseId: exercise.id,
      reasons: [ExerciseFlagReason.INCORRECT_ANSWER],
      flaggedAt: new Date("2026-09-07T14:00:00.000Z"),
    });
    const result = await adjudicateExerciseQualityIncident({
      userId: user.id,
      exerciseId: exercise.id,
      adjudication: "confirmed",
      adjudicationCode: "verified source mismatch",
      now: resolutionAt,
    });
    expect(result).toMatchObject({
      affectedAttemptCount: 2,
      affectedReviewCount: 1,
      practiceOnlyAttemptCount: 1,
      replayedReviewCount: 0,
    });

    const rebuilt = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(rebuilt.firstIntroducedAt).toEqual(originalIntroduction);
    expect(rebuilt.firstIntroducedAt).toEqual(firstAt);
    expect(rebuilt.fsrsState).toBe("NEW");
    expect(rebuilt.repetitions).toBe(0);
    expect(rebuilt.lastReviewedAt).toBeNull();
    expect(rebuilt.dueAt).toEqual(createInitialSkillSchedule(resolutionAt).dueAt);
    await expect(prisma.reviewLog.count({ where: { exerciseAttemptId: `${runId}_zero_valid_practice` } })).resolves.toBe(0);
    await expect(prisma.exerciseAttempt.findUniqueOrThrow({ where: { id: `${runId}_zero_valid_practice` } })).resolves.toMatchObject({
      finalRating: null,
      evidenceCorrectionStatus: ExerciseEvidenceCorrectionStatus.COMPLETE,
      evidenceCorrectionNote: expect.stringContaining("Retained historical evidence"),
    });
  });

  it("rejects a stale decision without changing a newer report", async () => {
    const user = await createUser("stale");
    const skill = await createSkillFixture(prisma, { userId: user.id, title: "Spanish stale report" });
    const exercise = await createChoiceExercise({ prisma, userId: user.id, skillId: skill.id });
    await flagPracticeExercise({
      userId: user.id,
      exerciseId: exercise.id,
      reasons: [ExerciseFlagReason.INCORRECT_ANSWER],
      flaggedAt: new Date("2026-09-09T12:00:00.000Z"),
    });
    const staleVersion = await currentIssueVersion(exercise.id);
    await flagPracticeExercise({
      userId: user.id,
      exerciseId: exercise.id,
      reasons: [ExerciseFlagReason.OTHER],
      otherNote: "A newer report arrived.",
      flaggedAt: new Date("2026-09-09T13:00:00.000Z"),
    });

    await expect(adjudicateExerciseQualityIncident({
      userId: user.id,
      exerciseId: exercise.id,
      adjudication: "confirmed",
      adjudicationCode: "stale decision",
      now: new Date("2026-09-09T14:00:00.000Z"),
      expectedUpdatedAt: staleVersion,
      idempotencyKey: `${runId}_stale`,
    })).rejects.toMatchObject({ code: "stale" });
    await expect(prisma.exerciseFlag.count({
      where: { exerciseId: exercise.id, adjudicationStatus: ExerciseFlagAdjudicationStatus.CONFIRMED },
    })).resolves.toBe(0);
  });
});
