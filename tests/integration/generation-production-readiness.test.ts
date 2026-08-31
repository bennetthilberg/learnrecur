import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  ExerciseFlagAdjudicationStatus,
  ExerciseFlagReason,
  GenerationAuditDecision,
  GenerationJobKind,
  GenerationJobStage,
  GenerationJobStatus,
  ModelReleaseState,
  Prisma,
} from "@/generated/prisma/client";
import {
  adjudicateExerciseQualityIncident,
  commitPracticeReview,
  flagPracticeExercise,
} from "@/lib/practice";
import { getPrisma } from "@/lib/prisma";
import { advanceSkillSchedule } from "@/lib/scheduling";
import { createChoiceExercise, createSkillFixture } from "./test-helpers";

const describeDatabase = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
const runId = `generation_readiness_${randomUUID()}`;

describeDatabase("generation production-readiness persistence", () => {
  const prisma = getPrisma();
  const userIds: string[] = [];
  const releaseIds: string[] = [];

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.modelRelease.deleteMany({ where: { id: { in: releaseIds } } });
    await prisma.$disconnect();
  });

  async function createUser(label: string) {
    const id = `${runId}_${label}`;
    userIds.push(id);
    return prisma.user.create({ data: { id, email: `${id}@example.com` } });
  }

  it("scopes generation idempotency to the owner and cascades append-only audit rows", async () => {
    const [firstUser, secondUser] = await Promise.all([createUser("owner"), createUser("other")]);
    const [firstSkill, secondSkill] = await Promise.all([
      createSkillFixture(prisma, { userId: firstUser.id, title: "Owner skill" }),
      createSkillFixture(prisma, { userId: secondUser.id, title: "Other skill" }),
    ]);
    const releaseTuple = {
      provider: "google",
      model: "gemini-3.7-flash",
      promptVersion: "skill-mcq-v1",
    };
    const release = await prisma.modelRelease.create({
      data: {
        provider: "google",
        model: "gemini-3.7-flash",
        releaseFingerprint: `${runId}-release`,
        state: ModelReleaseState.CANARY,
        releaseTuple,
        canaryPercent: 5,
      },
    });
    releaseIds.push(release.id);
    const createJob = (userId: string, skillId: string) => prisma.generationJob.create({
      data: {
        userId,
        skillId,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        status: GenerationJobStatus.RUNNING,
        stage: GenerationJobStage.VERIFYING,
        provider: "google",
        model: "gemini-3.7-flash",
        promptVersion: "skill-mcq-v1",
        idempotencyKey: "same-logical-job",
        requestedCount: 5,
        attemptCount: 1,
        generationReleaseId: release.id,
      },
    });
    const [firstJob, secondJob] = await Promise.all([
      createJob(firstUser.id, firstSkill.id),
      createJob(secondUser.id, secondSkill.id),
    ]);

    await expect(createJob(firstUser.id, firstSkill.id)).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );

    await prisma.generationAuditRecord.create({
      data: {
        userId: firstUser.id,
        jobId: firstJob.id,
        skillId: firstSkill.id,
        idempotencyKey: "same-logical-job",
        eventKey: "verification-complete",
        stage: GenerationJobStage.VERIFYING,
        attempt: 1,
        releaseTuple,
        decision: GenerationAuditDecision.ACCEPTED,
        generationReleaseId: release.id,
      },
    });
    expect(secondJob.userId).toBe(secondUser.id);

    await prisma.generationJob.delete({ where: { id: firstJob.id } });
    await expect(prisma.generationAuditRecord.count({ where: { jobId: firstJob.id } })).resolves.toBe(0);
  });

  it("rejects cross-owner exercise links in audit records", async () => {
    const [owner, other] = await Promise.all([createUser("audit_owner"), createUser("audit_other")]);
    const [ownerSkill, otherSkill] = await Promise.all([
      createSkillFixture(prisma, { userId: owner.id, title: "Audit owner" }),
      createSkillFixture(prisma, { userId: other.id, title: "Audit other" }),
    ]);
    const otherExercise = await createChoiceExercise({
      prisma,
      userId: other.id,
      skillId: otherSkill.id,
    });
    const job = await prisma.generationJob.create({
      data: {
        userId: owner.id,
        skillId: ownerSkill.id,
        kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
        provider: "google",
        model: "gemini-3.7-flash",
        promptVersion: "skill-mcq-v1",
        requestedCount: 1,
      },
    });

    await expect(prisma.generationAuditRecord.create({
      data: {
        userId: owner.id,
        jobId: job.id,
        skillId: ownerSkill.id,
        exerciseId: otherExercise.id,
        idempotencyKey: "cross-owner-audit",
        eventKey: "bad-link",
        stage: GenerationJobStage.QUEUED,
        attempt: 0,
        releaseTuple: { provider: "google", model: "gemini-3.7-flash" },
      },
    })).rejects.toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
  });

  it("invalidates a confirmed bad exercise without deleting history and replays valid reviews", async () => {
    const user = await createUser("incident");
    const initialDueAt = new Date("2026-08-01T12:00:00.000Z");
    const skill = await createSkillFixture(prisma, {
      userId: user.id,
      title: "Incident replay skill",
      dueAt: initialDueAt,
    });
    const badExercise = await createChoiceExercise({
      prisma,
      userId: user.id,
      skillId: skill.id,
      prompt: "Bad keyed prompt",
    });
    const validExercise = await createChoiceExercise({
      prisma,
      userId: user.id,
      skillId: skill.id,
      prompt: "Valid prompt",
    });
    const firstAt = new Date("2026-08-02T12:00:00.000Z");
    const secondAt = new Date("2026-08-05T12:00:00.000Z");
    const first = await commitPracticeReview({
      userId: user.id,
      exerciseId: badExercise.id,
      attemptId: `${runId}-bad-attempt`,
      submittedAnswer: "right",
      reviewedAt: firstAt,
    });
    const second = await commitPracticeReview({
      userId: user.id,
      exerciseId: validExercise.id,
      attemptId: `${runId}-valid-attempt`,
      submittedAnswer: "right",
      reviewedAt: secondAt,
    });
    expect(first.status).toBe("committed");
    expect(second.status).toBe("committed");

    const firstLog = await prisma.reviewLog.findUniqueOrThrow({
      where: { exerciseAttemptId: `${runId}-bad-attempt` },
    });
    const expected = advanceSkillSchedule({
      current: {
        dueAt: firstLog.previousDueAt!,
        stability: firstLog.previousStability!,
        difficulty: firstLog.previousDifficulty!,
        elapsedDays: firstLog.previousElapsedDays!,
        scheduledDays: firstLog.previousScheduledDays!,
        learningSteps: firstLog.previousLearningSteps!,
        repetitions: firstLog.previousRepetitions!,
        lapses: firstLog.previousLapses!,
        fsrsState: firstLog.previousState!,
        lastReviewedAt: null,
      },
      rating: second.status === "committed" ? second.finalRating : firstLog.finalRating,
      reviewedAt: secondAt,
    }).skillUpdate;

    await flagPracticeExercise({
      userId: user.id,
      exerciseId: badExercise.id,
      reasons: [ExerciseFlagReason.INCORRECT_ANSWER],
      flaggedAt: new Date("2026-08-06T12:00:00.000Z"),
    });
    const result = await adjudicateExerciseQualityIncident({
      userId: user.id,
      exerciseId: badExercise.id,
      adjudication: "confirmed",
      adjudicationCode: "incorrect-answer-key",
      now: new Date("2026-08-06T13:00:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "adjudicated",
      affectedReviewCount: 1,
      replayedReviewCount: 1,
    });
    await expect(prisma.exerciseAttempt.count({ where: { skillId: skill.id } })).resolves.toBe(2);
    await expect(prisma.reviewLog.count({ where: { skillId: skill.id } })).resolves.toBe(2);
    await expect(prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).resolves.toMatchObject({
      dueAt: expected.dueAt,
      repetitions: expected.repetitions,
      lapses: expected.lapses,
      fsrsState: expected.fsrsState,
    });
    await expect(prisma.exerciseFlag.findFirstOrThrow({
      where: { exerciseId: badExercise.id },
    })).resolves.toMatchObject({
      adjudicationStatus: ExerciseFlagAdjudicationStatus.CONFIRMED,
      affectedReviewCount: 1,
      practiceEvidenceNeedsCorrection: false,
    });
    await expect(adjudicateExerciseQualityIncident({
      userId: user.id,
      exerciseId: badExercise.id,
      adjudication: "rejected",
      adjudicationCode: "attempted-reversal",
      now: new Date("2026-08-06T14:00:00.000Z"),
    })).rejects.toThrow(/cannot be reversed/i);

    await expect(flagPracticeExercise({
      userId: user.id,
      exerciseId: badExercise.id,
      reasons: [ExerciseFlagReason.INCORRECT_ANSWER],
      flaggedAt: new Date("2026-08-06T15:00:00.000Z"),
    })).resolves.toMatchObject({
      status: "not-flagged",
      reason: "invalid-flag",
    });
    await expect(prisma.exerciseFlag.findFirstOrThrow({
      where: { exerciseId: badExercise.id },
    })).resolves.toMatchObject({
      adjudicationStatus: ExerciseFlagAdjudicationStatus.CONFIRMED,
      adjudicationCode: "incorrect-answer-key",
      affectedReviewCount: 1,
      practiceEvidenceNeedsCorrection: false,
    });
  });

  it("serializes parallel confirmed incidents that replay one skill schedule", async () => {
    const user = await createUser("parallel_incidents");
    const skill = await createSkillFixture(prisma, {
      userId: user.id,
      title: "Parallel incident skill",
    });
    const exercises = await Promise.all([
      createChoiceExercise({
        prisma,
        userId: user.id,
        skillId: skill.id,
        prompt: "First suspect prompt",
      }),
      createChoiceExercise({
        prisma,
        userId: user.id,
        skillId: skill.id,
        prompt: "Second suspect prompt",
      }),
    ]);
    await prisma.exercise.updateMany({
      where: { id: { in: exercises.map((exercise) => exercise.id) } },
      data: { exerciseFamily: "parallel-family", qualityVersion: "quality-v1" },
    });
    await prisma.exerciseFlag.createMany({
      data: exercises.map((exercise) => ({
        userId: user.id,
        exerciseId: exercise.id,
        reason: ExerciseFlagReason.INCORRECT_ANSWER,
        practiceEvidenceNeedsCorrection: true,
      })),
    });

    const results = await Promise.all(
      exercises.map((exercise, index) =>
        adjudicateExerciseQualityIncident({
          userId: user.id,
          exerciseId: exercise.id,
          adjudication: "confirmed",
          adjudicationCode: `parallel-incident-${index + 1}`,
          now: new Date("2026-08-07T12:00:00.000Z"),
          quarantineRelated: true,
        }),
      ),
    );

    expect(results).toEqual([
      expect.objectContaining({ status: "adjudicated", adjudication: "confirmed" }),
      expect.objectContaining({ status: "adjudicated", adjudication: "confirmed" }),
    ]);
    await expect(prisma.exerciseFlag.count({
      where: {
        exerciseId: { in: exercises.map((exercise) => exercise.id) },
        adjudicationStatus: ExerciseFlagAdjudicationStatus.CONFIRMED,
      },
    })).resolves.toBe(2);
  });
});
