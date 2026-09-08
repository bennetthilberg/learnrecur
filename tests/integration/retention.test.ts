import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/prisma";
import {
  commitPracticeReview,
  getNextPracticeItem,
  previewPracticeAnswer,
} from "@/lib/practice";
import {
  saveSkillPracticePreferences,
  saveCollectionPracticePreferences,
  saveUserPracticePreferences,
} from "@/lib/practice/preferences";
import {
  NATURAL_TEXT_POLICY,
  EXACT_TEXT_POLICY,
  textAnswerContract,
} from "@/lib/practice/policies";
import {
  createChoiceExercise,
  createSkillFixture,
  createTextExercise,
} from "./test-helpers";
import { loadGenerationRecentEvidence } from "@/lib/skills/generation-history";
import { buildGenerationQualityContext } from "@/lib/skills/quality-pipeline";

const suite = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
suite("retention preferences through persisted practice", () => {
  const prisma = getPrisma();
  const userId = `retention_${randomUUID()}`;
  const otherId = `${userId}_other`;
  const now = new Date();
  beforeAll(async () => {
    await prisma.user.createMany({ data: [{ id: userId }, { id: otherId }] });
  });
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherId] } } });
    await prisma.$disconnect();
  });

  it("bounds collection invalidation by inheriting skills without blocking preference-only saves", async () => {
    const collection = await prisma.collection.create({
      data: { userId, name: "Large reference collection" },
    });
    await prisma.skill.createMany({
      data: Array.from({ length: 501 }, (_, index) => ({
        userId,
        collectionId: collection.id,
        title: `Explicit ${index}`,
        textPolicy: EXACT_TEXT_POLICY,
      })),
    });
    const inheriting = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "Inherited comparison",
    });
    expect(
      await saveCollectionPracticePreferences({
        userId,
        collectionId: collection.id,
        now,
        input: { practicePreference: "RECALL_FIRST", textPolicy: null },
      }),
    ).toMatchObject({ status: "saved", policyChanged: false });
    expect(
      await saveCollectionPracticePreferences({
        userId,
        collectionId: collection.id,
        now,
        input: {
          practicePreference: "BALANCED",
          textPolicy: EXACT_TEXT_POLICY,
        },
      }),
    ).toMatchObject({ status: "saved", policyChanged: true });
    expect(
      await prisma.skill.findUniqueOrThrow({ where: { id: inheriting.id } }),
    ).toMatchObject({ textPolicyRevision: 1 });
    expect(
      await prisma.skill.count({
        where: { collectionId: collection.id, textPolicyRevision: 1 },
      }),
    ).toBe(1);
    const { Prisma } = await import("@/generated/prisma/client");
    await prisma.skill.updateMany({
      where: { collectionId: collection.id },
      data: { textPolicy: Prisma.DbNull },
    });
    await expect(
      saveCollectionPracticePreferences({
        userId,
        collectionId: collection.id,
        now,
        input: { practicePreference: null, textPolicy: NATURAL_TEXT_POLICY },
      }),
    ).resolves.toMatchObject({ status: "too-large" });
    expect(
      await prisma.collection.findUniqueOrThrow({
        where: { id: collection.id },
      }),
    ).toMatchObject({
      textPolicy: EXACT_TEXT_POLICY,
      practicePreference: "BALANCED",
    });
  });

  it("returns familiarity in active and recovery read models", async () => {
    const { getDashboardHome } = await import("@/lib/dashboard");
    const { getSkillsLibrary } = await import("@/lib/skills/library");
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Read model familiarity",
      dueAt: now,
    });
    await prisma.skill.update({
      where: { id: skill.id },
      data: { alreadyStudied: true },
    });
    expect(
      (await getDashboardHome({ userId, now })).skills.find(
        (s) => s.id === skill.id,
      ),
    ).toMatchObject({ alreadyStudied: true });
    expect(
      (await getSkillsLibrary({ userId, now })).activeSkills.find(
        (s) => s.id === skill.id,
      ),
    ).toMatchObject({ alreadyStudied: true });
    await prisma.skill.update({
      where: { id: skill.id },
      data: { status: "PAUSED" },
    });
    expect(
      (await getSkillsLibrary({ userId, now })).recoverySkills.find(
        (s) => s.id === skill.id,
      ),
    ).toMatchObject({ alreadyStudied: true });
  });

  it("repairs malformed stored policies while rejecting malformed new submissions", async () => {
    const { Prisma } = await import("@/generated/prisma/client");
    const collection = await prisma.collection.create({
      data: { userId, name: "Policy repair", textPolicy: { version: 3 } },
    });
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Policy repair",
      collectionId: collection.id,
      dueAt: now,
    });
    await prisma.skill.update({
      where: { id: skill.id },
      data: { textPolicy: { profile: "BROKEN" } },
    });
    const old = await createTextExercise(prisma, userId, skill.id, {
      answerSpec: textAnswerContract(["GET /v1"], EXACT_TEXT_POLICY),
    });
    expect(
      await saveSkillPracticePreferences({
        userId,
        skillId: skill.id,
        now,
        input: {
          practicePreference: null,
          alreadyStudied: true,
          textPolicy: EXACT_TEXT_POLICY,
        },
      }),
    ).toMatchObject({ status: "saved", policyChanged: true });
    expect(
      await prisma.exercise.findUniqueOrThrow({ where: { id: old.id } }),
    ).toMatchObject({ retiredAt: now, retirementReason: "REPLACED" });
    await prisma.skill.update({
      where: { id: skill.id },
      data: { textPolicy: Prisma.DbNull },
    });
    expect(
      await saveSkillPracticePreferences({
        userId,
        skillId: skill.id,
        now,
        input: {
          practicePreference: "RECALL_FIRST",
          alreadyStudied: true,
          textPolicy: null,
        },
      }),
    ).toMatchObject({ status: "saved", policyChanged: true });
    expect(
      await saveCollectionPracticePreferences({
        userId,
        collectionId: collection.id,
        now,
        input: { practicePreference: null, textPolicy: NATURAL_TEXT_POLICY },
      }),
    ).toMatchObject({ status: "saved", policyChanged: true });
    expect(
      await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } }),
    ).toMatchObject({
      textPolicyRevision: 3,
      repetitions: 0,
      lastReviewedAt: null,
    });
    await expect(
      saveSkillPracticePreferences({
        userId,
        skillId: skill.id,
        now,
        input: {
          practicePreference: null,
          alreadyStudied: true,
          textPolicy: { version: 3 },
        },
      }),
    ).rejects.toThrow();
    await expect(
      saveCollectionPracticePreferences({
        userId,
        collectionId: collection.id,
        now,
        input: { practicePreference: null, textPolicy: { version: 3 } },
      }),
    ).rejects.toThrow();
    expect(
      await prisma.collection.findUniqueOrThrow({
        where: { id: collection.id },
      }),
    ).toMatchObject({ textPolicy: NATURAL_TEXT_POLICY });
  });

  it("defaults to Balanced without familiarity or mixed-review claims", async () => {
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: userId } }),
    ).toMatchObject({ practicePreference: "BALANCED", mixedReview: false });
  });
  it("uses persisted inheritance and already-studied input without fabricating reviews", async () => {
    const collection = await prisma.collection.create({
      data: { userId, name: "Spanish" },
    });
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Spanish accents",
      collectionId: collection.id,
      dueAt: now,
    });
    await createChoiceExercise({ prisma, userId, skillId: skill.id });
    const text = await createTextExercise(prisma, userId, skill.id, {
      answerSpec: textAnswerContract(["año"], NATURAL_TEXT_POLICY),
    });
    await saveCollectionPracticePreferences({
      userId,
      collectionId: collection.id,
      now,
      input: { practicePreference: "RECALL_FIRST", textPolicy: null },
    });
    await saveSkillPracticePreferences({
      userId,
      skillId: skill.id,
      now,
      input: {
        practicePreference: null,
        alreadyStudied: true,
        textPolicy: null,
      },
    });
    expect(
      await getNextPracticeItem({ userId, collectionId: collection.id, now }),
    ).toMatchObject({
      status: "ready",
      exercise: { id: text.id },
      skill: { repetitions: 0 },
    });
    expect(await prisma.reviewLog.count({ where: { skillId: skill.id } })).toBe(
      0,
    );
    expect(
      await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } }),
    ).toMatchObject({ stability: 0, repetitions: 0, lastReviewedAt: null });
    // Explicit Balanced overrides the collection; clearing it restores inheritance.
    await saveSkillPracticePreferences({
      userId,
      skillId: skill.id,
      now,
      input: {
        practicePreference: "BALANCED",
        alreadyStudied: true,
        textPolicy: null,
      },
    });
    expect(
      (await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } }))
        .practicePreference,
    ).toBe("BALANCED");
    await saveUserPracticePreferences(userId, {
      practicePreference: "BALANCED",
      mixedReview: true,
    });
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
        .mixedReview,
    ).toBe(true);
  });
  it("grades and commits Good once, preserving mode, policy and mixed-presentation facts", async () => {
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "French terminology",
      dueAt: now,
      repetitions: 3,
    });
    const exercise = await createTextExercise(prisma, userId, skill.id, {
      answerSpec: textAnswerContract(["côte"], NATURAL_TEXT_POLICY),
    });
    const input = {
      userId,
      exerciseId: exercise.id,
      submittedAnswer: "côte",
      responseMs: 1,
      now,
    };
    expect(await previewPracticeAnswer(input)).toMatchObject({
      status: "checked",
      proposedRating: "GOOD",
    });
    const commit = {
      ...input,
      attemptId: randomUUID(),
      reviewedAt: now,
      mixedReview: true,
      reducedRuleCues: true,
    };
    expect(await commitPracticeReview(commit)).toMatchObject({
      status: "committed",
      finalRating: "GOOD",
      idempotent: false,
    });
    expect(
      await commitPracticeReview({ ...commit, manualRating: "EASY" }),
    ).toMatchObject({
      status: "committed",
      finalRating: "GOOD",
      idempotent: true,
    });
    expect(
      await prisma.exerciseAttempt.findUniqueOrThrow({
        where: { id: commit.attemptId },
      }),
    ).toMatchObject({
      ratingPolicyVersion: "correct-good-v2",
      answerPolicySnapshot: { policyVersion: 2 },
      practiceContext: {
        answerMode: "TEXT",
        mixedReview: true,
        reducedRuleCues: true,
      },
    });
    const evidence = await loadGenerationRecentEvidence({
      userId,
      skillId: skill.id,
      now,
    });
    expect(evidence.reviews).toHaveLength(1);
    expect(evidence.reviews[0]).toMatchObject({
      answerKind: "TEXT",
      isCorrect: true,
      assisted: false,
      scheduled: true,
    });
    expect(JSON.stringify(evidence)).not.toContain("côte");
    const context = buildGenerationQualityContext({
      skill: await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } }),
      sourceContext: null,
      requestedCount: 2,
      now,
      recentEvidence: evidence,
    });
    expect(context.blueprint.slots).toHaveLength(2);
    expect(
      (
        await loadGenerationRecentEvidence({
          userId: otherId,
          skillId: skill.id,
          now,
        })
      ).reviews,
    ).toHaveLength(0);
  });
  it("renews inherited text inventory without touching historical contracts or schedules; denies cross-user writes", async () => {
    const collection = await prisma.collection.create({
      data: { userId, name: "Technical targets" },
    });
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "HTTP fields",
      collectionId: collection.id,
      dueAt: now,
      repetitions: 3,
    });
    const exercise = await createTextExercise(prisma, userId, skill.id);
    expect(
      await saveSkillPracticePreferences({
        userId: otherId,
        skillId: skill.id,
        now,
        input: {
          practicePreference: "RECALL_FIRST",
          alreadyStudied: true,
          textPolicy: EXACT_TEXT_POLICY,
        },
      }),
    ).toEqual({ status: "not-found" });
    expect(
      await saveCollectionPracticePreferences({
        userId: otherId,
        collectionId: collection.id,
        now,
        input: { practicePreference: null, textPolicy: EXACT_TEXT_POLICY },
      }),
    ).toEqual({ status: "not-found" });
    const result = await saveCollectionPracticePreferences({
      userId,
      collectionId: collection.id,
      now,
      input: { practicePreference: null, textPolicy: EXACT_TEXT_POLICY },
    });
    expect(result).toMatchObject({ status: "saved", policyChanged: true });
    expect(
      await prisma.exercise.findUniqueOrThrow({ where: { id: exercise.id } }),
    ).toMatchObject({
      retiredAt: now,
      retirementReason: "REPLACED",
      answerSpec: { kind: "text", accepted: ["right"] },
    });
    expect(
      await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } }),
    ).toMatchObject({
      dueAt: now,
      repetitions: 3,
      stability: 0,
      textPolicyRevision: 1,
    });
  });
  it("fences obsolete native input jobs and prepares replacement inventory", async () => {
    const { refillExactInputExercisesForSkill } = await import("@/lib/skills");
    const { retentionTextFixtures, retentionGeneratedText } = await import(
      "../fixtures/ai-generation/retention-fixtures"
    );
    const fixture = retentionTextFixtures[0];
    const collection = await prisma.collection.create({
      data: { userId, name: "Stale policy fixture" },
    });
    const skill = await createSkillFixture(prisma, {
      userId,
      title: fixture.title,
      collectionId: collection.id,
      tags: [...fixture.tags],
      dueAt: now,
    });
    await saveSkillPracticePreferences({
      userId,
      skillId: skill.id,
      now,
      input: {
        alreadyStudied: true,
        practicePreference: "RECALL_FIRST",
        textPolicy: null,
      },
    });
    const stale = await refillExactInputExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      model: "test-gemini",
      generateExactInputExercises: async () => {
        await saveSkillPracticePreferences({
          userId,
          skillId: skill.id,
          now,
          input: {
            alreadyStudied: true,
            practicePreference: "RECALL_FIRST",
            textPolicy: EXACT_TEXT_POLICY,
          },
        });
        return { exercises: [retentionGeneratedText(fixture)] };
      },
      verifyExactInputExercises: async ({ candidates }) => ({
        verifications: candidates.map((c) => ({
          candidateId: c.candidateId,
          verdict: "verified",
        })),
      }),
    });
    expect(stale.status).toBe("not-refilled");
    expect(await prisma.exercise.count({ where: { skillId: skill.id } })).toBe(
      0,
    );
    expect(
      await getNextPracticeItem({ userId, collectionId: collection.id, now }),
    ).toMatchObject({ status: "none-due", preparing: true });
    const prepared = await refillExactInputExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      model: "test-gemini",
      generateExactInputExercises: async () => ({
        exercises: [
          {
            ...retentionGeneratedText(fixture),
            answerSpec: textAnswerContract([fixture.answer], EXACT_TEXT_POLICY),
          },
        ],
      }),
      verifyExactInputExercises: async ({ candidates }) => ({
        verifications: candidates.map((c) => ({
          candidateId: c.candidateId,
          verdict: "verified",
        })),
      }),
    });
    expect(prepared).toMatchObject({ status: "refilled", exerciseCount: 1 });
    expect(
      await prisma.exercise.findFirstOrThrow({ where: { skillId: skill.id } }),
    ).toMatchObject({
      answerSpec: { policyVersion: 2, normalizeCase: false },
      exerciseFamily: expect.any(String),
      skillSpecFingerprint: expect.any(String),
    });
    expect(
      await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } }),
    ).toMatchObject({ repetitions: 0, lastReviewedAt: null });
  });

  it.each(["TEXT", "MATH"] as const)(
    "keeps %s planning slots through validation, duplicate removal and verification",
    async (answerKind) => {
      const { refillExactInputExercisesForSkill, refillMathExercisesForSkill } =
        await import("@/lib/skills");
      const {
        retentionGeneratedText,
        retentionTextFixtures,
        retentionMathFixtures,
      } = await import("../fixtures/ai-generation/retention-fixtures");
      const skill = await createSkillFixture(prisma, {
        userId,
        title:
          answerKind === "MATH"
            ? "Solving linear equations"
            : "French terminology",
        repetitions: 3,
      });
      const base =
        answerKind === "TEXT"
          ? retentionGeneratedText(retentionTextFixtures[1])
          : {
              prompt: "Simplify x+x+x.",
              answerKind: "MATH" as const,
              answerSpec: retentionMathFixtures[1].answerSpec,
              correctAnswerDisplay: "3*x",
              explanation: "Combine the three equal terms.",
              difficulty: 3,
              expectedSeconds: 30,
            };
      await prisma.exercise.create({
        data: {
          userId,
          skillId: skill.id,
          type: "EXACT_INPUT",
          verificationStatus: "VERIFIED",
          ...base,
        },
      });
      let expectedSlot: string | undefined;
      const generate = async (input: {
        qualityContext?: ReturnType<typeof buildGenerationQualityContext>;
      }) => {
        expectedSlot = input.qualityContext?.blueprint.slots[3]?.slotId;
        return {
          exercises: [
            { ...base, answerSpec: { kind: "invalid" } },
            base,
            { ...base, prompt: "Rejected fresh prompt." },
            { ...base, prompt: "Accepted fresh prompt." },
          ],
        };
      };
      const verify = async ({
        candidates,
      }: {
        candidates: Array<{ candidateId: string }>;
      }) => ({
        verifications: candidates.map((c, index) => ({
          candidateId: c.candidateId,
          verdict: index === 0 ? "rejected" : "verified",
          reason: index === 0 ? "unclear_prompt" : null,
        })),
      });
      const common = {
        userId,
        skillId: skill.id,
        now,
        targetReadyCount: 5,
        model: "test-gemini",
      };
      const result =
        answerKind === "TEXT"
          ? await refillExactInputExercisesForSkill({
              ...common,
              generateExactInputExercises: generate,
              verifyExactInputExercises: verify,
            })
          : await refillMathExercisesForSkill({
              ...common,
              generateMathExercises: generate,
              verifyMathExercises: verify,
            });
      expect(result).toMatchObject({ status: "refilled", exerciseCount: 1 });
      expect(expectedSlot).toEqual(expect.any(String));
      expect(
        await prisma.exercise.findFirstOrThrow({
          where: { skillId: skill.id, prompt: "Accepted fresh prompt." },
        }),
      ).toMatchObject({ blueprintSlot: expectedSlot });
    },
  );

  it("feeds persisted recovery and valid exercise history into the actual input generator", async () => {
    const { refillExactInputExercisesForSkill } = await import("@/lib/skills");
    const { retentionTextFixtures, retentionGeneratedText } = await import(
      "../fixtures/ai-generation/retention-fixtures"
    );
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "French terminology history",
      repetitions: 5,
      dueAt: now,
    });
    const bad = await createChoiceExercise({
      prisma,
      userId,
      skillId: skill.id,
      prompt: "Defective historical prompt.",
    });
    const good = await createChoiceExercise({
      prisma,
      userId,
      skillId: skill.id,
      prompt: "Valid historical terminology prompt.",
    });
    const start = new Date(now.getTime() - 4 * 86400000);
    await prisma.exercise.updateMany({
      where: { skillId: skill.id },
      data: { createdAt: start, exerciseFamily: "recognition-choice" },
    });
    // Exercise the real commit path on three scheduled dates, retaining a lapse.
    for (const [day, correct] of [
      [0, false],
      [1, true],
      [2, true],
    ] as const) {
      const reviewedAt = new Date(start.getTime() + day * 86400000);
      await prisma.skill.update({
        where: { id: skill.id },
        data: { dueAt: reviewedAt },
      });
      expect(
        await commitPracticeReview({
          userId,
          exerciseId: good.id,
          attemptId: randomUUID(),
          submittedAnswer: correct ? "right" : "wrong",
          responseMs: 1000,
          reviewedAt,
        }),
      ).toMatchObject({ status: "committed" });
    }
    const invalidDate = new Date(start.getTime() + 3 * 86400000);
    await prisma.skill.update({
      where: { id: skill.id },
      data: { dueAt: invalidDate },
    });
    await commitPracticeReview({
      userId,
      exerciseId: bad.id,
      attemptId: randomUUID(),
      submittedAnswer: "wrong",
      responseMs: 1000,
      reviewedAt: invalidDate,
    });
    await prisma.exerciseFlag.create({
      data: {
        userId,
        exerciseId: bad.id,
        reason: "INCORRECT_ANSWER",
        adjudicationStatus: "CONFIRMED",
      },
    });
    const evidence = await loadGenerationRecentEvidence({
      userId,
      skillId: skill.id,
      now,
    });
    expect(evidence.reviews).toHaveLength(3);
    expect(evidence.exercises.map((e) => e.id)).toEqual([good.id]);
    expect(evidence.reviews.map((e) => e.isCorrect)).toEqual([
      false,
      true,
      true,
    ]);
    const sourceSkill = await prisma.skill.findUniqueOrThrow({
      where: { id: skill.id },
    });
    expect(sourceSkill.lapses).toBeGreaterThan(0);
    let captured: unknown;
    const result = await refillExactInputExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      model: "test-gemini",
      generateExactInputExercises: async (input) => {
        captured = input.qualityContext;
        return {
          exercises: [
            retentionGeneratedText(retentionTextFixtures[1]),
            {
              ...retentionGeneratedText(retentionTextFixtures[1]),
              prompt: "Complete the familiar phrase: la ___ française. (coast)",
            },
          ],
        };
      },
      verifyExactInputExercises: async ({ candidates }) => ({
        verifications: candidates.map((c, index) => ({
          candidateId: c.candidateId,
          verdict: index === 0 ? "rejected" : "verified",
          reason: index === 0 ? "unclear_prompt" : null,
        })),
      }),
    });
    expect(result.status).toBe("refilled");
    expect(captured).toEqual(
      buildGenerationQualityContext({
        skill: sourceSkill,
        sourceContext: null,
        requestedCount: 2,
        answerModes: ["text", "numeric"],
        now,
        recentEvidence: evidence,
      }),
    );
    const published = await prisma.exercise.findFirstOrThrow({
      where: { skillId: skill.id, answerKind: "TEXT" },
    });
    expect(published.blueprintSlot).toBe(
      buildGenerationQualityContext({
        skill: sourceSkill,
        sourceContext: null,
        requestedCount: 2,
        answerModes: ["text", "numeric"],
        now,
        recentEvidence: evidence,
      }).blueprint.slots[1].slotId,
    );
    expect(captured).toMatchObject({
      skillSpec: { difficultyPolicy: { target: 3 } },
    });
  });

  it("updates inherited policy when a draft moves, and rejects an obsolete agent candidate", async () => {
    const {
      createSkillDraft,
      updateSkillDraft,
      verifyUntrustedAgentExerciseCandidates,
    } = await import("@/lib/skills");
    const collection = await prisma.collection.create({
      data: {
        userId,
        name: `Exact ${randomUUID()}`,
        textPolicy: EXACT_TEXT_POLICY,
      },
    });
    const input = {
      title: "Protocol command",
      objective: "Recall the exact toy protocol command.",
      rules: "Use GET /v1",
      examples: "GET /v1",
      exerciseConstraints: "Preserve case",
      tags: "programming",
      collectionName: "",
    };
    const draft = await createSkillDraft({ userId, input });
    if (draft.status !== "created") throw Error("Draft creation failed");
    expect(
      await updateSkillDraft({
        userId,
        skillId: draft.skill.id,
        input: { ...input, collectionName: collection.name },
      }),
    ).toMatchObject({
      status: "updated",
      skill: { collectionId: collection.id, textPolicyRevision: 1 },
    });
    // The generator-facing candidate verifier must reject a natural policy when Exact is inherited.
    const { agentCandidateExerciseSchema, normalizeAgentCandidateExercise } =
      await import("@/lib/agent-access/contracts");
    const payload = normalizeAgentCandidateExercise(
      agentCandidateExerciseSchema.parse({
        kind: "text",
        prompt: "Write the toy protocol command.",
        acceptedAnswers: ["GET /v1"],
      }),
      0,
    );
    expect(
      await verifyUntrustedAgentExerciseCandidates({
        userId,
        skillId: draft.skill.id,
        now,
        candidates: [
          { candidateId: payload.candidateId, normalizedPayload: payload },
        ],
      }),
    ).toMatchObject({
      status: "not-verified",
      reason: "verification-failed",
      message: expect.stringContaining("policy"),
    });
  });

  it.each([false, true])(
    "activates current familiarity with real verified inventory (initially studied: %s)",
    async (initiallyStudied) => {
      const { createSkillDraft, activateSkillDraft } = await import(
        "@/lib/skills"
      );
      const events: string[] = [];
      const sender = {
        sendChoiceRefillRequested: async () => {
          events.push("choice");
        },
        sendExactInputRefillRequested: async () => {
          events.push("text");
        },
        sendMathRefillRequested: async () => {
          events.push("math");
        },
      };
      const draft = await createSkillDraft({
        userId,
        input: {
          title: "Spanish accents activation",
          objective:
            "Select the required accent for the approved Spanish word.",
          rules: "Preserve accents",
          examples: "año",
          exerciseConstraints: "Use familiar words",
          tags: "Spanish",
          collectionName: "",
          alreadyStudied: initiallyStudied,
          practicePreference: "RECALL_FIRST",
        },
      });
      if (draft.status !== "created") throw Error("Draft creation failed");
      const result = await activateSkillDraft({
        userId,
        skillId: draft.skill.id,
        now,
        model: "test-gemini",
        refillSender: sender,
        generateChoiceExercises: async () => {
          if (!initiallyStudied)
            await saveSkillPracticePreferences({
              userId,
              skillId: draft.skill.id,
              now,
              input: {
                alreadyStudied: true,
                practicePreference: "RECALL_FIRST",
                textPolicy: null,
              },
            });
          return {
            exercises: [1, 2, 3].map((id) => ({
              prompt: `What is the best translation for item ${id}?`,
              choices: [
                { id: "correct", label: `Correct answer ${id}` },
                { id: "close", label: `Close distractor ${id}` },
                { id: "wrong", label: `Wrong answer ${id}` },
              ],
              correctChoiceId: "correct",
              explanation: `Item ${id} checks the defined skill.`,
              difficulty: 2,
              expectedSeconds: 30,
            })),
          };
        },
        verifyChoiceExercises: async ({ candidates }) => ({
          verifications: candidates.map((c) => ({
            candidateId: c.candidateId,
            verdict: "verified",
          })),
        }),
      });
      expect(result.status).toBe("activated");
      expect(events).toContain("text");
      expect(
        await prisma.skill.findUniqueOrThrow({ where: { id: draft.skill.id } }),
      ).toMatchObject({
        status: "ACTIVE",
        repetitions: 0,
        alreadyStudied: true,
        lastReviewedAt: null,
      });
      expect(
        await prisma.exercise.count({
          where: { skillId: draft.skill.id, verificationStatus: "VERIFIED" },
        }),
      ).toBeGreaterThanOrEqual(3);
      expect(
        await prisma.reviewLog.count({ where: { skillId: draft.skill.id } }),
      ).toBe(0);
    },
  );

  it("uses a choice fallback and bounded preparation, then reports missing stock as preparation needed", async () => {
    const { queueRetentionPreparation } = await import(
      "@/lib/skills/retention-preparation"
    );
    const collection = await prisma.collection.create({
      data: { userId, name: `Fallback ${randomUUID()}` },
    });
    const skill = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "French terminology fallback",
      dueAt: now,
    });
    await saveSkillPracticePreferences({
      userId,
      skillId: skill.id,
      now,
      input: {
        practicePreference: "RECALL_FIRST",
        alreadyStudied: true,
        textPolicy: null,
      },
    });
    const choice = await createChoiceExercise({
      prisma,
      userId,
      skillId: skill.id,
    });
    expect(
      await getNextPracticeItem({ userId, collectionId: collection.id, now }),
    ).toMatchObject({
      status: "ready",
      exercise: { id: choice.id, answerKind: "CHOICE" },
    });
    const events: string[] = [];
    const sender = {
      sendChoiceRefillRequested: async () => {
        events.push("choice");
      },
      sendExactInputRefillRequested: async () => {
        events.push("text");
      },
      sendMathRefillRequested: async () => {
        events.push("math");
      },
    };
    await queueRetentionPreparation({ userId, skillId: skill.id, now, sender });
    await queueRetentionPreparation({ userId, skillId: skill.id, now, sender });
    expect(events).toEqual(["choice", "text"]);
    await prisma.exercise.update({
      where: { id: choice.id },
      data: { retiredAt: now, retirementReason: "MANUAL" },
    });
    expect(
      await getNextPracticeItem({ userId, collectionId: collection.id, now }),
    ).toMatchObject({ status: "none-due", preparing: true });
  });

  it("mixes only compatible due skills in scope and preserves older overdue work", async () => {
    const collection = await prisma.collection.create({
      data: { userId, name: `Mixed ${randomUUID()}` },
    });
    const a = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "Biology osmosis",
      tags: ["biology"],
      dueAt: now,
    });
    const b = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "Biology diffusion",
      tags: ["biology"],
      dueAt: now,
    });
    const future = await createSkillFixture(prisma, {
      userId,
      collectionId: collection.id,
      title: "Biology future",
      tags: ["biology"],
      dueAt: new Date(now.getTime() + 86400000),
    });
    for (const skill of [a, b, future])
      await createChoiceExercise({ prisma, userId, skillId: skill.id });
    expect(
      await getNextPracticeItem({
        userId,
        collectionId: collection.id,
        now,
        mixedReview: true,
        previousSkillId: a.id,
      }),
    ).toMatchObject({ status: "ready", skill: { id: b.id } });
    await prisma.skill.update({
      where: { id: a.id },
      data: { dueAt: new Date(now.getTime() - 86400000) },
    });
    expect(
      await getNextPracticeItem({
        userId,
        collectionId: collection.id,
        now,
        mixedReview: true,
        previousSkillId: a.id,
      }),
    ).toMatchObject({ status: "ready", skill: { id: a.id } });
    expect(
      await getNextPracticeItem({
        userId: otherId,
        collectionId: collection.id,
        now,
        mixedReview: true,
        previousSkillId: a.id,
      }),
    ).toMatchObject({ status: "none-due" });
  });

  it("exports new policies and presentation history within the existing ownership boundary", async () => {
    const { getUserDataExport } = await import("@/lib/settings/data-export");
    await saveUserPracticePreferences(userId, {
      practicePreference: "BALANCED",
      mixedReview: true,
    });
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Independent export fixture",
      dueAt: now,
    });
    await saveSkillPracticePreferences({
      userId,
      skillId: skill.id,
      now,
      input: {
        practicePreference: "RECALL_FIRST",
        alreadyStudied: true,
        textPolicy: null,
      },
    });
    const exercise = await createChoiceExercise({
      prisma,
      userId,
      skillId: skill.id,
    });
    await commitPracticeReview({
      userId,
      exerciseId: exercise.id,
      attemptId: randomUUID(),
      submittedAnswer: "right",
      responseMs: 1000,
      reviewedAt: now,
    });
    const result = await getUserDataExport({ userId, generatedAt: now });
    expect(result).toMatchObject({
      status: "ready",
      export: { exportVersion: 5 },
    });
    if (result.status !== "ready") throw Error("Missing export");
    expect(result.export.user).toMatchObject({
      practicePreference: "BALANCED",
      mixedReview: true,
    });
    expect(
      result.export.skills.some(
        (skill) =>
          skill.alreadyStudied && skill.practicePreference === "RECALL_FIRST",
      ),
    ).toBe(true);
    expect(
      result.export.exerciseAttempts.some(
        (attempt) =>
          attempt.ratingPolicyVersion === "correct-good-v2" &&
          attempt.practiceContext !== null &&
          attempt.answerPolicySnapshot !== null,
      ),
    ).toBe(true);
    expect(result.export.user.id).toBe(userId);
  });
  it("bounds and deterministically orders persisted evidence, excluding future records", async () => {
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "History bounds",
      dueAt: now,
    });
    const exercise = await createChoiceExercise({
      prisma,
      userId,
      skillId: skill.id,
    });
    const attemptId = randomUUID();
    await commitPracticeReview({
      userId,
      exerciseId: exercise.id,
      attemptId,
      submittedAnswer: "right",
      responseMs: 1000,
      reviewedAt: now,
    });
    const attempt = await prisma.exerciseAttempt.findUniqueOrThrow({
      where: { id: attemptId },
    });
    const review = await prisma.reviewLog.findUniqueOrThrow({
      where: {
        exerciseAttemptId_skillId_userId: {
          exerciseAttemptId: attemptId,
          skillId: skill.id,
          userId,
        },
      },
    });
    const rows = Array.from({ length: 23 }, (_, index) => ({
      id: randomUUID(),
      at: new Date(now.getTime() + (index - 21) * 1000),
    }));
    await prisma.exerciseAttempt.createMany({
      data: rows.map((row) => ({ ...attempt, id: row.id })),
    });
    await prisma.reviewLog.createMany({
      data: rows.map((row) => ({
        ...review,
        id: row.id,
        exerciseAttemptId: row.id,
        reviewedAt: row.at,
        previousDueAt: row.at,
      })),
    });
    const evidence = await loadGenerationRecentEvidence({
      userId,
      skillId: skill.id,
      now,
    });
    const expected = [{ id: review.id, at: now }, ...rows]
      .filter((row) => row.at <= now)
      .sort(
        (a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id),
      )
      .slice(-20);
    expect(evidence.reviews.map((row) => row.id)).toEqual(
      expected.map((row) => row.id),
    );
    expect(evidence.reviews).toHaveLength(20);
    expect(evidence.reviews.every((row) => row.reviewedAt <= now)).toBe(true);
  });
});
