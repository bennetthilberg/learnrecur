import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ExerciseAttemptResult,
  ExerciseFlagReason,
  FsrsRating,
  GenerationJobKind,
  GenerationJobStage,
  GenerationJobStatus,
} from "@/generated/prisma/client";
import {
  type AgentAccessScope,
  type AgentAuthContext,
} from "@/lib/agent-access/auth";
import {
  getAgentProgressSummary,
  getAgentReadiness,
} from "@/lib/agent-access/progress";
import {
  EXACT_TEXT_POLICY,
  NATURAL_TEXT_POLICY,
  textAnswerContract,
} from "@/lib/practice/policies";
import { getPrisma } from "@/lib/prisma";

import {
  createChoiceExercise,
  createSkillFixture,
  createTextExercise,
} from "./test-helpers";

const suite = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;

suite("agent progress read model", () => {
  const prisma = getPrisma();
  const userIds: string[] = [];
  const now = new Date("2026-09-08T18:00:00.000Z");

  async function createAuth(): Promise<AgentAuthContext> {
    const userId = `agent_progress_${randomUUID()}`;
    userIds.push(userId);
    await prisma.user.create({ data: { id: userId } });
    const identity = await prisma.workosIdentity.create({
      data: {
        userId,
        workosUserId: `workos_${userId}`,
        externalId: userId,
      },
    });
    const connection = await prisma.agentConnection.create({
      data: {
        userId,
        workosIdentityId: identity.id,
        workosSubject: userId,
        workosSessionId: `session_${userId}`,
        workosApplicationId: `app_${userId}`,
        clientId: "https://agent.example/client.json",
        clientName: "Progress test agent",
        clientDomain: "agent.example",
        resourceUrl: "https://learnrecur.com/mcp",
        scopes: ["progress:read"] satisfies AgentAccessScope[],
      },
    });
    return {
      userId,
      connectionId: connection.id,
      subject: userId,
      sessionId: connection.workosSessionId,
      clientId: connection.clientId,
      clientName: connection.clientName,
      clientDomain: connection.clientDomain,
      resourceUrl: connection.resourceUrl,
      expiresAt: Math.floor(Date.now() / 1_000) + 3_600,
      scopes: ["progress:read"],
    };
  }

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("uses alreadyStudied and effective text policy in readiness and due totals", async () => {
    const auth = await createAuth();
    const locked = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Locked exact input",
      dueAt: new Date("2026-09-07T09:00:00.000Z"),
      repetitions: 0,
    });
    await createTextExercise(prisma, auth.userId, locked.id, {
      answerSpec: textAnswerContract(["right"], NATURAL_TEXT_POLICY),
    });

    const introduced = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Introduced exact input",
      dueAt: new Date("2026-09-07T09:00:00.000Z"),
      repetitions: 0,
    });
    await prisma.skill.update({
      where: { id: introduced.id },
      data: { alreadyStudied: true },
    });
    await createTextExercise(prisma, auth.userId, introduced.id, {
      answerSpec: textAnswerContract(["right"], NATURAL_TEXT_POLICY),
    });

    const exactCollection = await prisma.collection.create({
      data: {
        userId: auth.userId,
        name: "Exact policy",
        textPolicy: EXACT_TEXT_POLICY,
      },
    });
    const incompatible = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Incompatible text inventory",
      collectionId: exactCollection.id,
      dueAt: new Date("2026-09-07T09:00:00.000Z"),
      repetitions: 3,
    });
    await createTextExercise(prisma, auth.userId, incompatible.id, {
      answerSpec: textAnswerContract(["right"], NATURAL_TEXT_POLICY),
    });

    await expect(
      getAgentReadiness(auth, { skill_id: locked.id }),
    ).resolves.toMatchObject({
      skills: [
        {
          skill_id: locked.id,
          ready_exercise_count: 0,
          status_reason: "needs_preparation",
        },
      ],
    });
    await expect(
      getAgentReadiness(auth, { skill_id: introduced.id }),
    ).resolves.toMatchObject({
      skills: [
        {
          skill_id: introduced.id,
          ready_exercise_count: 1,
          status_reason: "ready",
        },
      ],
    });
    await expect(
      getAgentReadiness(auth, { skill_id: incompatible.id }),
    ).resolves.toMatchObject({
      skills: [
        {
          skill_id: incompatible.id,
          ready_exercise_count: 0,
          status_reason: "needs_preparation",
        },
      ],
    });

    await expect(
      getAgentProgressSummary(auth, { collection_id: exactCollection.id }),
    ).resolves.toMatchObject({
      due: {
        skill_count: 1,
        ready_skill_count: 0,
        waiting_for_preparation_count: 1,
      },
      totals: { active_skill_count: 1 },
    });
  });

  it("derives trouble spots from independent scheduled evidence and scopes quality work to a collection", async () => {
    const auth = await createAuth();
    const includedCollection = await prisma.collection.create({
      data: { userId: auth.userId, name: "Included progress collection" },
    });
    const excludedCollection = await prisma.collection.create({
      data: { userId: auth.userId, name: "Excluded progress collection" },
    });
    const practiceOnlyNoise = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Practice only noise",
      collectionId: includedCollection.id,
      dueAt: new Date("2026-09-07T09:00:00.000Z"),
      repetitions: 5,
    });
    const invalidatedNoise = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Invalidated noise",
      collectionId: includedCollection.id,
      dueAt: new Date("2026-09-07T09:00:00.000Z"),
      repetitions: 5,
    });
    const excluded = await createSkillFixture(prisma, {
      userId: auth.userId,
      title: "Excluded quality work",
      collectionId: excludedCollection.id,
      dueAt: new Date("2026-09-07T09:00:00.000Z"),
      repetitions: 5,
    });

    await createReviewHistory(prisma, auth.userId, practiceOnlyNoise.id, now, [
      {},
      {},
      { practiceOnly: true },
    ]);
    const invalidatedReviews = await createReviewHistory(
      prisma,
      auth.userId,
      invalidatedNoise.id,
      now,
      [{}, {}, {}],
    );
    await prisma.exerciseFlag.create({
      data: {
        userId: auth.userId,
        exerciseId: invalidatedReviews.at(-1)!.exerciseId,
        reason: ExerciseFlagReason.UNCLEAR_PROMPT,
        practiceEvidenceNeedsCorrection: true,
        evidenceCorrectionStatus: "PENDING",
      },
    });
    const excludedExercise = await createChoiceExercise({
      prisma,
      userId: auth.userId,
      skillId: excluded.id,
    });
    await prisma.exerciseFlag.create({
      data: {
        userId: auth.userId,
        exerciseId: excludedExercise.id,
        reason: ExerciseFlagReason.UNCLEAR_PROMPT,
      },
    });
    await prisma.generationJob.create({
      data: {
        userId: auth.userId,
        skillId: excluded.id,
        kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
        status: GenerationJobStatus.FAILED,
        stage: GenerationJobStage.FAILED,
        provider: "test",
        model: "fixture",
        promptVersion: "fixture-v1",
        requestedCount: 1,
      },
    });
    const includedExercise = await createChoiceExercise({
      prisma,
      userId: auth.userId,
      skillId: practiceOnlyNoise.id,
    });
    await prisma.exerciseFlag.create({
      data: {
        userId: auth.userId,
        exerciseId: includedExercise.id,
        reason: ExerciseFlagReason.UNCLEAR_PROMPT,
      },
    });
    await prisma.generationJob.create({
      data: {
        userId: auth.userId,
        skillId: practiceOnlyNoise.id,
        kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
        status: GenerationJobStatus.FAILED,
        stage: GenerationJobStage.FAILED,
        provider: "test",
        model: "fixture",
        promptVersion: "fixture-v1",
        requestedCount: 1,
      },
    });

    const summary = await getAgentProgressSummary(auth, {
      collection_id: includedCollection.id,
      recent_limit: 20,
    });
    expect(summary.quality).toEqual({ open_flag_count: 2 });
    expect(summary.preparation).toEqual({
      pending_job_count: 0,
      failed_job_count: 1,
    });
    expect(summary.trouble_spots).toEqual([]);
  });
});

type ReviewHistoryInput = { practiceOnly?: boolean };

async function createReviewHistory(
  prisma: ReturnType<typeof getPrisma>,
  userId: string,
  skillId: string,
  now: Date,
  reviews: readonly ReviewHistoryInput[],
) {
  const created: Array<{ exerciseId: string }> = [];
  for (const [index, input] of reviews.entries()) {
    const exercise = await createChoiceExercise({ prisma, userId, skillId });
    const reviewedAt = new Date(
      now.getTime() - (reviews.length - index) * 86_400_000,
    );
    const attemptId = randomUUID();
    await prisma.exerciseAttempt.create({
      data: {
        id: attemptId,
        userId,
        skillId,
        exerciseId: exercise.id,
        answer: { choiceId: "wrong" },
        isCorrect: false,
        result: ExerciseAttemptResult.INCORRECT,
        finalRating: FsrsRating.AGAIN,
        proposedRating: FsrsRating.AGAIN,
        practiceContext: {
          version: 1,
          answerMode: "CHOICE",
          mixedReview: false,
          reducedRuleCues: false,
          assistance: "none",
          exposure: input.practiceOnly ? "PRACTICE_ONLY" : "SCHEDULED",
          sessionMode: input.practiceOnly ? "PRACTICE_ONLY" : "SCHEDULED",
        },
        answerPolicySnapshot: { kind: "choice", correctChoiceId: "right" },
        feedbackShownAt: reviewedAt,
        createdAt: reviewedAt,
      },
    });
    await prisma.reviewLog.create({
      data: {
        id: randomUUID(),
        userId,
        skillId,
        exerciseAttemptId: attemptId,
        finalRating: FsrsRating.AGAIN,
        reviewedAt,
        previousDueAt: new Date(reviewedAt.getTime() - 3_600_000),
        nextDueAt: new Date(reviewedAt.getTime() + 86_400_000),
        schedulerName: "test",
        schedulerVersion: "test",
        desiredRetention: 0.9,
        schedulerParameters: {},
        createdAt: reviewedAt,
      },
    });
    created.push({ exerciseId: exercise.id });
  }
  return created;
}
