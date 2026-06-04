import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AnswerKind,
  ExerciseType,
  ExerciseVerificationStatus,
  GenerationJobKind,
  GenerationJobStatus,
  SkillFsrsState,
  SkillStatus,
} from "@/generated/prisma/client";
import { getNextChoicePracticeItemForUser } from "@/app/practice/queries";
import { getDashboardHome } from "@/lib/dashboard";
import { getPrisma } from "@/lib/prisma";
import {
  activateSkillDraft,
  createSkillDraft,
  updateSkillDraft,
  type ChoiceExerciseGenerator,
} from "@/lib/skills";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `skills_${randomUUID()}`;
const now = new Date("2026-06-04T16:00:00.000Z");

const generatedExercise = (id: number) => ({
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
});

const successfulGenerator: ChoiceExerciseGenerator = async () => ({
  exercises: [generatedExercise(1), generatedExercise(2), generatedExercise(3)],
});

describeDatabase("skill drafts and Gemini activation", () => {
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

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    for (const userId of ownedUserIds.reverse()) {
      await cleanupUser(userId);
    }

    await prisma.$disconnect();
  });

  it("creates and updates user-owned skill drafts with collection resolution", async () => {
    const userId = await createUser("drafts");
    const otherUserId = await createUser("drafts_other");

    const created = await createSkillDraft({
      userId,
      input: {
        title: " Ser vs estar ",
        objective: "Choose between ser and estar in simple identity and location cases.",
        collectionName: " Spanish grammar ",
        rules: "Use ser for identity.",
        examples: "Soy estudiante.",
        exerciseConstraints: "Avoid trick options.",
        tags: "spanish, grammar, spanish",
      },
    });

    expect(created.status).toBe("created");

    if (created.status !== "created") {
      throw new Error("Expected draft creation to succeed.");
    }

    const skill = await prisma.skill.findUniqueOrThrow({
      where: { id: created.skill.id },
      include: { collection: true },
    });

    expect(skill).toMatchObject({
      userId,
      title: "Ser vs estar",
      objective: "Choose between ser and estar in simple identity and location cases.",
      status: SkillStatus.DRAFT,
      tags: ["spanish", "grammar"],
    });
    expect(skill.collection?.name).toBe("Spanish grammar");

    const denied = await updateSkillDraft({
      userId: otherUserId,
      skillId: skill.id,
      input: {
        title: "Cross-user edit",
        objective: "This should not be allowed to alter another user draft.",
      },
    });

    expect(denied).toMatchObject({
      status: "not-found",
      reason: "skill-not-found",
    });

    const updated = await updateSkillDraft({
      userId,
      skillId: skill.id,
      input: {
        title: "Ser and estar in context",
        objective: "Choose ser or estar for identity, location, and temporary state.",
        collectionName: "Spanish grammar",
        rules: "Use estar for temporary state.",
        examples: "Estoy cansado.",
        exerciseConstraints: "Prefer concrete classroom examples.",
        tags: ["spanish", "verbs", "grammar"],
      },
    });

    expect(updated.status).toBe("updated");
    await expect(prisma.collection.count({ where: { userId, name: "Spanish grammar" } })).resolves.toBe(1);

    const afterUpdate = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(afterUpdate).toMatchObject({
      title: "Ser and estar in context",
      status: SkillStatus.DRAFT,
      tags: ["spanish", "verbs", "grammar"],
    });
  });

  it("activates a draft with verified choice exercises, FSRS fields, and audit metadata", async () => {
    const userId = await createUser("activate");
    const draft = await createSkillDraft({
      userId,
      input: {
        title: "Spanish classroom phrases",
        objective: "Choose the correct meaning for common Spanish classroom phrases.",
        collectionName: "Spanish",
        tags: "spanish, classroom",
      },
    });

    if (draft.status !== "created") {
      throw new Error("Expected draft creation to succeed.");
    }

    const activated = await activateSkillDraft({
      userId,
      skillId: draft.skill.id,
      now,
      generateChoiceExercises: successfulGenerator,
      model: "test-gemini",
    });

    expect(activated).toMatchObject({
      status: "activated",
      exerciseCount: 3,
    });

    const skill = await prisma.skill.findUniqueOrThrow({
      where: { id: draft.skill.id },
      include: {
        exercises: true,
        generationJobs: true,
      },
    });

    expect(skill).toMatchObject({
      status: SkillStatus.ACTIVE,
      dueAt: now,
      stability: 0,
      difficulty: 0,
      fsrsState: SkillFsrsState.NEW,
      repetitions: 0,
      lapses: 0,
    });
    expect(skill.exercises).toHaveLength(3);
    expect(skill.exercises.every((exercise) => exercise.userId === userId)).toBe(true);
    expect(skill.exercises.every((exercise) => exercise.type === ExerciseType.MULTIPLE_CHOICE)).toBe(true);
    expect(skill.exercises.every((exercise) => exercise.answerKind === AnswerKind.CHOICE)).toBe(true);
    expect(
      skill.exercises.every(
        (exercise) => exercise.verificationStatus === ExerciseVerificationStatus.VERIFIED,
      ),
    ).toBe(true);

    expect(skill.generationJobs).toHaveLength(1);
    expect(skill.generationJobs[0]).toMatchObject({
      userId,
      kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
      status: GenerationJobStatus.SUCCEEDED,
      provider: "google",
      model: "test-gemini",
      promptVersion: "skill-mcq-v0",
      requestedCount: 5,
      acceptedCount: 3,
      rejectedCount: 0,
      errorMessage: null,
    });

    const dashboard = await getDashboardHome({ userId, now });
    expect(dashboard.readyNowCount).toBe(1);
    expect(dashboard.activeSkillCount).toBe(1);

    const nextPracticeItem = await getNextChoicePracticeItemForUser(userId, now);
    expect(nextPracticeItem.status).toBe("ready");

    if (nextPracticeItem.status === "ready") {
      expect(nextPracticeItem.skill.id).toBe(skill.id);
      expect(skill.exercises.map((exercise) => exercise.id)).toContain(nextPracticeItem.exercise.id);
    }
  });

  it("keeps a skill draft inactive when generation validation fails", async () => {
    const userId = await createUser("failed_generation");
    const draft = await createSkillDraft({
      userId,
      input: {
        title: "French greetings",
        objective: "Choose the correct meaning for short French greeting phrases.",
      },
    });

    if (draft.status !== "created") {
      throw new Error("Expected draft creation to succeed.");
    }

    const result = await activateSkillDraft({
      userId,
      skillId: draft.skill.id,
      now,
      generateChoiceExercises: async () => ({
        exercises: [generatedExercise(1), generatedExercise(2)],
      }),
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "not-activated",
      reason: "invalid-generation",
    });

    const skill = await prisma.skill.findUniqueOrThrow({
      where: { id: draft.skill.id },
      include: {
        exercises: true,
        generationJobs: true,
      },
    });

    expect(skill.status).toBe(SkillStatus.DRAFT);
    expect(skill.dueAt).toBeNull();
    expect(skill.exercises).toHaveLength(0);
    expect(skill.generationJobs).toHaveLength(1);
    expect(skill.generationJobs[0]).toMatchObject({
      status: GenerationJobStatus.FAILED,
      acceptedCount: 2,
      rejectedCount: 0,
    });
  });

  it("returns a typed setup error without creating practiceable exercises when Gemini env is missing", async () => {
    const originalGeminiApiKey = process.env.GEMINI_API_KEY;
    const originalGeminiModel = process.env.GEMINI_MODEL;

    try {
      delete process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_MODEL;

      const userId = await createUser("missing_env");
      const draft = await createSkillDraft({
        userId,
        input: {
          title: "German articles",
          objective: "Choose the correct German article for common beginner nouns.",
        },
      });

      if (draft.status !== "created") {
        throw new Error("Expected draft creation to succeed.");
      }

      const result = await activateSkillDraft({
        userId,
        skillId: draft.skill.id,
        now,
      });

      expect(result).toMatchObject({
        status: "not-activated",
        reason: "missing-gemini-env",
      });

      const [skill, exerciseCount, job] = await Promise.all([
        prisma.skill.findUniqueOrThrow({ where: { id: draft.skill.id } }),
        prisma.exercise.count({ where: { userId, skillId: draft.skill.id } }),
        prisma.generationJob.findFirstOrThrow({ where: { userId, skillId: draft.skill.id } }),
      ]);

      expect(skill.status).toBe(SkillStatus.DRAFT);
      expect(exerciseCount).toBe(0);
      expect(job).toMatchObject({
        status: GenerationJobStatus.FAILED,
        provider: "google",
        model: "gemini-3.5-flash",
        acceptedCount: 0,
        rejectedCount: 0,
      });
    } finally {
      if (originalGeminiApiKey === undefined) {
        delete process.env.GEMINI_API_KEY;
      } else {
        process.env.GEMINI_API_KEY = originalGeminiApiKey;
      }

      if (originalGeminiModel === undefined) {
        delete process.env.GEMINI_MODEL;
      } else {
        process.env.GEMINI_MODEL = originalGeminiModel;
      }
    }
  });
});
