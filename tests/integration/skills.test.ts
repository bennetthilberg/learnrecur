import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AnswerKind,
  ExerciseRetirementReason,
  ExerciseType,
  ExerciseVerificationStatus,
  GenerationJobKind,
  GenerationJobStatus,
  Prisma,
  SkillFsrsState,
  SkillStatus,
  SourceFileKind,
  SourceFileStatus,
} from "@/generated/prisma/client";
import { getNextChoicePracticeItemForUser } from "@/app/practice/queries";
import { getDashboardHome } from "@/lib/dashboard";
import { getPrisma } from "@/lib/prisma";
import {
  activateSkillDraft,
  createSkillDraft,
  createSkillDraftFromSource,
  DEFAULT_READY_EXACT_INPUT_TARGET,
  DEFAULT_READY_EXERCISE_TARGET,
  EXACT_INPUT_UNLOCK_REPETITIONS,
  refillExactInputExercisesForSkill,
  refillChoiceExercisesForSkill,
  updateSkillDraft,
  type ChoiceExerciseGenerator,
  type ChoiceExerciseVerifier,
  type ExactInputExerciseGenerator,
  type ExactInputExerciseVerifier,
  type SkillDraftGenerator,
} from "@/lib/skills";
import { createInitialSkillSchedule } from "@/lib/scheduling";

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

const generatedExactInputExercise = (id: number) => ({
  prompt: `Type the answer for exact item ${id}.`,
  answerKind: AnswerKind.TEXT,
  answerSpec: {
    kind: "text",
    accepted: [`exact answer ${id}`],
    normalizeCase: true,
    normalizeWhitespace: true,
    normalizeDiacritics: true,
  },
  correctAnswerDisplay: `exact answer ${id}`,
  explanation: `Exact item ${id} checks direct recall.`,
  difficulty: 2,
  expectedSeconds: 35,
});

const successfulGenerator: ChoiceExerciseGenerator = async () => ({
  exercises: [generatedExercise(1), generatedExercise(2), generatedExercise(3)],
});

const acceptAllVerifier: ChoiceExerciseVerifier = async (input) => ({
  verifications: input.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    verdict: "verified",
  })),
});

const acceptAllExactInputVerifier: ExactInputExerciseVerifier = async (input) => ({
  verifications: input.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    verdict: "verified",
  })),
});

const generatedSkillDraft = {
  title: "Ser vs. estar in classroom sentences",
  objective: "Choose ser or estar in beginner Spanish sentences about identity and location.",
  rules: ["Use ser for identity.", "Use estar for location and temporary states."],
  examples: ["Soy estudiante.", "Estoy en casa."],
  exerciseConstraints: "Use short multiple-choice prompts with one clear verb choice.",
  tags: ["Spanish", "grammar"],
};

const successfulSkillDraftGenerator: SkillDraftGenerator = async () => generatedSkillDraft;

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

  async function createActiveSkillFixture({
    userId,
    title = "Active refill skill",
    status = SkillStatus.ACTIVE,
    repetitions = 0,
  }: {
    userId: string;
    title?: string;
    status?: SkillStatus;
    repetitions?: number;
  }) {
    return prisma.skill.create({
      data: {
        userId,
        title,
        objective: "Choose the correct answer for short generated practice items.",
        status,
        tags: ["refill"],
        ...createInitialSkillSchedule(now),
        repetitions,
      },
    });
  }

  async function createChoiceExerciseFixture({
    userId,
    skillId,
    id = 1,
    verificationStatus = ExerciseVerificationStatus.VERIFIED,
    choices = [
      { id: "correct", label: `Correct answer ${id}` },
      { id: "wrong", label: `Wrong answer ${id}` },
      { id: "close", label: `Close distractor ${id}` },
    ],
    retiredAt = null,
  }: {
    userId: string;
    skillId: string;
    id?: number;
    verificationStatus?: ExerciseVerificationStatus;
    choices?: Prisma.InputJsonValue;
    retiredAt?: Date | null;
  }) {
    return prisma.exercise.create({
      data: {
        userId,
        skillId,
        type: ExerciseType.MULTIPLE_CHOICE,
        answerKind: AnswerKind.CHOICE,
        prompt: `Existing refill prompt ${id}?`,
        choices,
        answerSpec: {
          kind: "choice",
          correctChoiceId: "correct",
        },
        correctAnswerDisplay: `Correct answer ${id}`,
        explanation: `Existing explanation ${id}.`,
        verificationStatus,
        retiredAt,
        retirementReason: retiredAt ? ExerciseRetirementReason.MANUAL : null,
      },
    });
  }

  async function createTextExerciseFixture({
    userId,
    skillId,
    id = 1,
    verificationStatus = ExerciseVerificationStatus.VERIFIED,
    retiredAt = null,
  }: {
    userId: string;
    skillId: string;
    id?: number;
    verificationStatus?: ExerciseVerificationStatus;
    retiredAt?: Date | null;
  }) {
    return prisma.exercise.create({
      data: {
        userId,
        skillId,
        type: ExerciseType.EXACT_INPUT,
        answerKind: AnswerKind.TEXT,
        prompt: `Type the exact answer ${id}.`,
        answerSpec: {
          kind: "text",
          accepted: [`answer ${id}`],
        },
        correctAnswerDisplay: `answer ${id}`,
        verificationStatus,
        retiredAt,
        retirementReason: retiredAt ? ExerciseRetirementReason.MANUAL : null,
      },
    });
  }

  async function createNumericExerciseFixture({
    userId,
    skillId,
    id = 1,
  }: {
    userId: string;
    skillId: string;
    id?: number;
  }) {
    return prisma.exercise.create({
      data: {
        userId,
        skillId,
        type: ExerciseType.EXACT_INPUT,
        answerKind: AnswerKind.NUMERIC,
        prompt: `Enter the numeric answer ${id}.`,
        answerSpec: {
          kind: "numeric",
          accepted: [id],
          tolerance: 0,
        },
        correctAnswerDisplay: String(id),
        verificationStatus: ExerciseVerificationStatus.VERIFIED,
      },
    });
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
      verifyChoiceExercises: acceptAllVerifier,
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

  it("persists only verifier-approved exercises and counts rejected candidates", async () => {
    const userId = await createUser("verified_subset");
    const draft = await createSkillDraft({
      userId,
      input: {
        title: "Spanish prepositions",
        objective: "Choose the correct meaning for common Spanish prepositions.",
      },
    });

    if (draft.status !== "created") {
      throw new Error("Expected draft creation to succeed.");
    }

    const selectiveGenerator: ChoiceExerciseGenerator = async () => ({
      exercises: Array.from({ length: 5 }, (_, index) => generatedExercise(index + 1)),
    });
    const selectiveVerifier: ChoiceExerciseVerifier = async (input) => ({
      verifications: input.candidates.map((candidate) =>
        candidate.candidateId === "candidate-2" || candidate.candidateId === "candidate-4"
          ? {
              candidateId: candidate.candidateId,
              verdict: "rejected",
              reason: "ambiguous",
              note: "The distractors are not clearly wrong.",
            }
          : {
              candidateId: candidate.candidateId,
              verdict: "verified",
            },
      ),
    });

    const activated = await activateSkillDraft({
      userId,
      skillId: draft.skill.id,
      now,
      generateChoiceExercises: selectiveGenerator,
      verifyChoiceExercises: selectiveVerifier,
      model: "test-gemini",
    });

    expect(activated).toMatchObject({
      status: "activated",
      exerciseCount: 3,
    });

    const [skill, exercises, generationJob] = await Promise.all([
      prisma.skill.findUniqueOrThrow({ where: { id: draft.skill.id } }),
      prisma.exercise.findMany({
        where: { userId, skillId: draft.skill.id },
        orderBy: { prompt: "asc" },
        select: { prompt: true, verificationStatus: true },
      }),
      prisma.generationJob.findFirstOrThrow({ where: { userId, skillId: draft.skill.id } }),
    ]);

    expect(skill.status).toBe(SkillStatus.ACTIVE);
    expect(exercises.map((exercise) => exercise.prompt)).toEqual([
      "What is the best translation for item 1?",
      "What is the best translation for item 3?",
      "What is the best translation for item 5?",
    ]);
    expect(
      exercises.every(
        (exercise) => exercise.verificationStatus === ExerciseVerificationStatus.VERIFIED,
      ),
    ).toBe(true);
    expect(generationJob).toMatchObject({
      status: GenerationJobStatus.SUCCEEDED,
      acceptedCount: 3,
      rejectedCount: 2,
    });
  });

  it("keeps a skill draft inactive when verification approves too few exercises", async () => {
    const userId = await createUser("failed_verification");
    const draft = await createSkillDraft({
      userId,
      input: {
        title: "French classroom verbs",
        objective: "Choose the correct meaning for common French classroom verbs.",
      },
    });

    if (draft.status !== "created") {
      throw new Error("Expected draft creation to succeed.");
    }

    const sparseVerifier: ChoiceExerciseVerifier = async (input) => ({
      verifications: input.candidates.map((candidate) =>
        candidate.candidateId === "candidate-1"
          ? {
              candidateId: candidate.candidateId,
              verdict: "verified",
            }
          : {
              candidateId: candidate.candidateId,
              verdict: "rejected",
              reason: "source_mismatch",
            },
      ),
    });

    const result = await activateSkillDraft({
      userId,
      skillId: draft.skill.id,
      now,
      generateChoiceExercises: successfulGenerator,
      verifyChoiceExercises: sparseVerifier,
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "not-activated",
      reason: "invalid-verification",
    });

    const [skill, exerciseCount, generationJob, dashboard, nextPracticeItem] = await Promise.all([
      prisma.skill.findUniqueOrThrow({ where: { id: draft.skill.id } }),
      prisma.exercise.count({ where: { userId, skillId: draft.skill.id } }),
      prisma.generationJob.findFirstOrThrow({ where: { userId, skillId: draft.skill.id } }),
      getDashboardHome({ userId, now }),
      getNextChoicePracticeItemForUser(userId, now),
    ]);

    expect(skill.status).toBe(SkillStatus.DRAFT);
    expect(skill.dueAt).toBeNull();
    expect(exerciseCount).toBe(0);
    expect(generationJob).toMatchObject({
      status: GenerationJobStatus.FAILED,
      acceptedCount: 1,
      rejectedCount: 2,
    });
    expect(dashboard.readyNowCount).toBe(0);
    expect(nextPracticeItem.status).toBe("none-due");
  });

  it("keeps a skill draft inactive when verification fails after structural validation", async () => {
    const userId = await createUser("verification_error");
    const draft = await createSkillDraft({
      userId,
      input: {
        title: "German classroom nouns",
        objective: "Choose the correct meaning for common German classroom nouns.",
      },
    });

    if (draft.status !== "created") {
      throw new Error("Expected draft creation to succeed.");
    }

    const partiallyValidGenerator: ChoiceExerciseGenerator = async () => ({
      exercises: [
        generatedExercise(1),
        generatedExercise(2),
        generatedExercise(3),
        {
          ...generatedExercise(4),
          correctChoiceId: "missing",
        },
      ],
    });
    const failingVerifier: ChoiceExerciseVerifier = async () => {
      throw new Error("verifier unavailable");
    };

    const result = await activateSkillDraft({
      userId,
      skillId: draft.skill.id,
      now,
      generateChoiceExercises: partiallyValidGenerator,
      verifyChoiceExercises: failingVerifier,
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "not-activated",
      reason: "verification-failed",
    });

    const [skill, exerciseCount, generationJob] = await Promise.all([
      prisma.skill.findUniqueOrThrow({ where: { id: draft.skill.id } }),
      prisma.exercise.count({ where: { userId, skillId: draft.skill.id } }),
      prisma.generationJob.findFirstOrThrow({ where: { userId, skillId: draft.skill.id } }),
    ]);

    expect(skill.status).toBe(SkillStatus.DRAFT);
    expect(exerciseCount).toBe(0);
    expect(generationJob).toMatchObject({
      status: GenerationJobStatus.FAILED,
      acceptedCount: 0,
      rejectedCount: 4,
    });
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

  it("creates a source-backed draft with a ready text source and ownership link", async () => {
    const userId = await createUser("source_draft");
    const result = await createSkillDraftFromSource({
      userId,
      now,
      model: "test-gemini",
      generateSkillDraft: successfulSkillDraftGenerator,
      input: {
        sourceText:
          "Use ser for identity and long-term traits. Use estar for location and temporary states. Classroom practice should use short sentences with one obvious choice.",
        sourceLabel: "Spanish chapter notes",
        focusNote: "Keep this at a beginner grammar level.",
        collectionName: "Spanish grammar",
        tags: "Spanish, verbs",
      },
    });

    expect(result.status).toBe("created");

    if (result.status !== "created") {
      throw new Error("Expected source draft creation to succeed.");
    }

    const skill = await prisma.skill.findUniqueOrThrow({
      where: { id: result.skill.id },
      include: {
        collection: true,
        sourceRefs: {
          include: {
            sourceFile: true,
          },
        },
      },
    });

    expect(skill).toMatchObject({
      userId,
      title: generatedSkillDraft.title,
      objective: generatedSkillDraft.objective,
      status: SkillStatus.DRAFT,
      tags: ["spanish", "verbs", "grammar"],
    });
    expect(skill.collection?.name).toBe("Spanish grammar");
    expect(skill.sourceRefs).toHaveLength(1);
    expect(skill.sourceRefs[0]).toMatchObject({
      userId,
      note: "Keep this at a beginner grammar level.",
    });
    expect(skill.sourceRefs[0].sourceFile).toMatchObject({
      userId,
      collectionId: skill.collectionId,
      kind: SourceFileKind.TEXT,
      status: SourceFileStatus.READY,
      originalName: "Spanish chapter notes",
      mimeType: "text/plain",
    });
    expect(skill.sourceRefs[0].sourceFile.extractedText).toContain("Use ser for identity");
  });

  it("does not persist a source, skill, or link when generated draft validation fails", async () => {
    const userId = await createUser("source_invalid_generation");
    const result = await createSkillDraftFromSource({
      userId,
      now,
      model: "test-gemini",
      generateSkillDraft: async () => ({
        title: "Incomplete draft",
        objective: "too short",
        rules: [],
        examples: [],
        exerciseConstraints: "",
        tags: [],
      }),
      input: {
        sourceText:
          "Use ser for identity and long-term traits. Use estar for location and temporary states. Classroom practice should use short sentences with one obvious choice.",
      },
    });

    expect(result).toMatchObject({
      status: "not-created",
      reason: "invalid-generation",
    });

    await expect(prisma.skill.count({ where: { userId } })).resolves.toBe(0);
    await expect(prisma.sourceFile.count({ where: { userId } })).resolves.toBe(0);
    await expect(prisma.skillSourceRef.count({ where: { userId } })).resolves.toBe(0);
  });

  it("keeps source-backed drafts isolated by user ownership", async () => {
    const userId = await createUser("source_owner");
    const otherUserId = await createUser("source_other");
    const result = await createSkillDraftFromSource({
      userId,
      now,
      model: "test-gemini",
      generateSkillDraft: successfulSkillDraftGenerator,
      input: {
        sourceText:
          "Use ser for identity and long-term traits. Use estar for location and temporary states. Classroom practice should use short sentences with one obvious choice.",
      },
    });

    if (result.status !== "created") {
      throw new Error("Expected source draft creation to succeed.");
    }

    const denied = await activateSkillDraft({
      userId: otherUserId,
      skillId: result.skill.id,
      now,
      generateChoiceExercises: successfulGenerator,
      verifyChoiceExercises: acceptAllVerifier,
      model: "test-gemini",
    });

    expect(denied).toMatchObject({
      status: "not-found",
      reason: "skill-not-found",
    });

    await expect(prisma.generationJob.count({ where: { userId: otherUserId } })).resolves.toBe(0);
  });

  it("passes linked source context into activation generation and verification", async () => {
    const userId = await createUser("source_activation");
    const result = await createSkillDraftFromSource({
      userId,
      now,
      model: "test-gemini",
      generateSkillDraft: successfulSkillDraftGenerator,
      input: {
        sourceText:
          "Use ser for identity and long-term traits. Use estar for location and temporary states. Classroom practice should use short sentences with one obvious choice.",
        sourceLabel: "Activation source",
      },
    });

    if (result.status !== "created") {
      throw new Error("Expected source draft creation to succeed.");
    }

    let capturedSourceContext: string | null | undefined;
    let capturedVerifierSourceContext: string | null | undefined;
    const activationGenerator: ChoiceExerciseGenerator = async (input) => {
      capturedSourceContext = input.sourceContext;
      return {
        exercises: [generatedExercise(1), generatedExercise(2), generatedExercise(3)],
      };
    };
    const activationVerifier: ChoiceExerciseVerifier = async (input) => {
      capturedVerifierSourceContext = input.sourceContext;
      return acceptAllVerifier(input);
    };

    const activated = await activateSkillDraft({
      userId,
      skillId: result.skill.id,
      now,
      generateChoiceExercises: activationGenerator,
      verifyChoiceExercises: activationVerifier,
      model: "test-gemini",
    });

    expect(activated.status).toBe("activated");
    expect(capturedSourceContext).toContain("Use ser for identity");
    expect(capturedSourceContext).toContain("Use estar for location");
    expect(capturedVerifierSourceContext).toContain("Use ser for identity");
    expect(capturedVerifierSourceContext).toContain("Use estar for location");
  });

  it("does not refill an active skill that already has target ready choice exercises", async () => {
    const userId = await createUser("refill_noop");
    const skill = await createActiveSkillFixture({
      userId,
      title: "No-op refill skill",
    });

    for (let index = 1; index <= DEFAULT_READY_EXERCISE_TARGET; index += 1) {
      await createChoiceExerciseFixture({ userId, skillId: skill.id, id: index });
    }

    const result = await refillChoiceExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      generateChoiceExercises: async () => {
        throw new Error("Generator should not be called for a full queue.");
      },
      verifyChoiceExercises: acceptAllVerifier,
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "not-refilled",
      reason: "already-at-target",
      readyExerciseCount: DEFAULT_READY_EXERCISE_TARGET,
      targetReadyCount: DEFAULT_READY_EXERCISE_TARGET,
    });

    await expect(
      Promise.all([
        prisma.exercise.count({ where: { userId, skillId: skill.id } }),
        prisma.generationJob.count({ where: { userId, skillId: skill.id } }),
      ]),
    ).resolves.toEqual([DEFAULT_READY_EXERCISE_TARGET, 0]);
  });

  it("refills an active skill below target while preserving schedule state", async () => {
    const userId = await createUser("refill_success");
    const skill = await createActiveSkillFixture({
      userId,
      title: "Source-backed refill skill",
    });
    const sourceFile = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.READY,
        originalName: "Refill source",
        mimeType: "text/plain",
        extractedText:
          "Use source-backed classroom examples with short prompts and clear choices.",
      },
    });
    await prisma.skillSourceRef.create({
      data: {
        userId,
        skillId: skill.id,
        sourceFileId: sourceFile.id,
      },
    });
    await createChoiceExerciseFixture({ userId, skillId: skill.id, id: 1 });
    await createChoiceExerciseFixture({ userId, skillId: skill.id, id: 2 });

    const originalSchedule = await prisma.skill.findUniqueOrThrow({
      where: { id: skill.id },
      select: {
        status: true,
        dueAt: true,
        stability: true,
        difficulty: true,
        elapsedDays: true,
        scheduledDays: true,
        learningSteps: true,
        repetitions: true,
        lapses: true,
        fsrsState: true,
        lastReviewedAt: true,
      },
    });
    let capturedRequestedCount: number | undefined;
    let capturedSourceContext: string | null | undefined;
    let capturedExistingExerciseContext: string | null | undefined;
    let capturedVerifierExistingExerciseContext: string | null | undefined;

    const refillGenerator: ChoiceExerciseGenerator = async (input) => {
      capturedRequestedCount = input.requestedCount;
      capturedSourceContext = input.sourceContext;
      capturedExistingExerciseContext = input.existingExerciseContext;
      return {
        exercises: [generatedExercise(101), generatedExercise(102), generatedExercise(103)],
      };
    };
    const refillVerifier: ChoiceExerciseVerifier = async (input) => {
      capturedVerifierExistingExerciseContext = input.existingExerciseContext;
      return acceptAllVerifier(input);
    };

    const result = await refillChoiceExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      generateChoiceExercises: refillGenerator,
      verifyChoiceExercises: refillVerifier,
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "refilled",
      exerciseCount: 3,
      readyExerciseCount: DEFAULT_READY_EXERCISE_TARGET,
      targetReadyCount: DEFAULT_READY_EXERCISE_TARGET,
    });
    expect(capturedRequestedCount).toBe(3);
    expect(capturedSourceContext).toContain("Use source-backed classroom examples");
    expect(capturedExistingExerciseContext).toContain("Existing refill prompt 1?");
    expect(capturedExistingExerciseContext).toContain("Correct answer 1");
    expect(capturedVerifierExistingExerciseContext).toContain("Existing refill prompt 2?");

    const [afterSchedule, exercises, generationJob, nextPracticeItem] = await Promise.all([
      prisma.skill.findUniqueOrThrow({
        where: { id: skill.id },
        select: {
          status: true,
          dueAt: true,
          stability: true,
          difficulty: true,
          elapsedDays: true,
          scheduledDays: true,
          learningSteps: true,
          repetitions: true,
          lapses: true,
          fsrsState: true,
          lastReviewedAt: true,
        },
      }),
      prisma.exercise.findMany({
        where: { userId, skillId: skill.id },
        orderBy: { createdAt: "asc" },
      }),
      prisma.generationJob.findFirstOrThrow({
        where: { userId, skillId: skill.id },
      }),
      getNextChoicePracticeItemForUser(userId, now),
    ]);

    expect(afterSchedule).toEqual(originalSchedule);
    expect(exercises).toHaveLength(DEFAULT_READY_EXERCISE_TARGET);
    expect(
      exercises.filter((exercise) =>
        /^What is the best translation for item 10[1-3]\?$/.test(exercise.prompt),
      ),
    ).toHaveLength(3);
    expect(generationJob).toMatchObject({
      status: GenerationJobStatus.SUCCEEDED,
      kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
      provider: "google",
      model: "test-gemini",
      promptVersion: "skill-mcq-v0",
      requestedCount: 3,
      acceptedCount: 3,
      rejectedCount: 0,
      errorMessage: null,
    });
    expect(nextPracticeItem.status).toBe("ready");
  });

  it("filters duplicate generated exercises during refill", async () => {
    const userId = await createUser("refill_duplicates");
    const skill = await createActiveSkillFixture({ userId });
    await createChoiceExerciseFixture({ userId, skillId: skill.id, id: 1 });

    const result = await refillChoiceExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      targetReadyCount: 3,
      generateChoiceExercises: async () => ({
        exercises: [
          {
            ...generatedExercise(100),
            prompt: "Existing refill prompt 1?",
            choices: [
              { id: "correct", label: "Correct answer 1" },
              { id: "wrong", label: "Wrong answer 1" },
              { id: "close", label: "Close distractor 1" },
            ],
          },
          generatedExercise(201),
        ],
      }),
      verifyChoiceExercises: acceptAllVerifier,
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "refilled",
      exerciseCount: 1,
      readyExerciseCount: 2,
      targetReadyCount: 3,
    });

    const [prompts, job] = await Promise.all([
      prisma.exercise.findMany({
        where: { userId, skillId: skill.id },
        orderBy: { createdAt: "asc" },
        select: { prompt: true },
      }),
      prisma.generationJob.findFirstOrThrow({ where: { userId, skillId: skill.id } }),
    ]);

    expect(prompts.map((exercise) => exercise.prompt)).toEqual([
      "Existing refill prompt 1?",
      "What is the best translation for item 201?",
    ]);
    expect(job).toMatchObject({
      status: GenerationJobStatus.SUCCEEDED,
      requestedCount: 2,
      acceptedCount: 1,
      rejectedCount: 1,
    });
  });

  it("creates failed generation jobs without writing exercises when refill generation fails", async () => {
    const userId = await createUser("refill_generation_fail");
    const skill = await createActiveSkillFixture({ userId });

    const result = await refillChoiceExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      targetReadyCount: 2,
      generateChoiceExercises: async () => {
        throw new Error("generator unavailable");
      },
      verifyChoiceExercises: acceptAllVerifier,
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "not-refilled",
      reason: "generation-failed",
    });

    await expect(
      Promise.all([
        prisma.exercise.count({ where: { userId, skillId: skill.id } }),
        prisma.generationJob.findFirstOrThrow({ where: { userId, skillId: skill.id } }),
      ]),
    ).resolves.toEqual([
      0,
      expect.objectContaining({
        status: GenerationJobStatus.FAILED,
        requestedCount: 2,
        acceptedCount: 0,
        rejectedCount: 0,
      }),
    ]);
  });

  it("creates failed generation jobs without writing exercises when refill verification fails", async () => {
    const userId = await createUser("refill_verification_fail");
    const skill = await createActiveSkillFixture({ userId });

    const result = await refillChoiceExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      targetReadyCount: 2,
      generateChoiceExercises: async () => ({
        exercises: [generatedExercise(1), generatedExercise(2)],
      }),
      verifyChoiceExercises: async () => {
        throw new Error("verifier unavailable");
      },
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "not-refilled",
      reason: "verification-failed",
    });

    await expect(
      Promise.all([
        prisma.exercise.count({ where: { userId, skillId: skill.id } }),
        prisma.generationJob.findFirstOrThrow({ where: { userId, skillId: skill.id } }),
      ]),
    ).resolves.toEqual([
      0,
      expect.objectContaining({
        status: GenerationJobStatus.FAILED,
        requestedCount: 2,
        acceptedCount: 0,
        rejectedCount: 2,
      }),
    ]);
  });

  it("rejects draft, archived, missing, and cross-user refill requests without jobs", async () => {
    const userId = await createUser("refill_reject");
    const otherUserId = await createUser("refill_reject_other");
    const draftSkill = await createActiveSkillFixture({
      userId,
      title: "Draft refill skill",
      status: SkillStatus.DRAFT,
    });
    const archivedSkill = await createActiveSkillFixture({
      userId,
      title: "Archived refill skill",
      status: SkillStatus.ARCHIVED,
    });
    const otherSkill = await createActiveSkillFixture({
      userId: otherUserId,
      title: "Other refill skill",
    });

    await expect(
      refillChoiceExercisesForSkill({
        userId,
        skillId: draftSkill.id,
        now,
        generateChoiceExercises: successfulGenerator,
        model: "test-gemini",
      }),
    ).resolves.toMatchObject({
      status: "not-refilled",
      reason: "skill-not-active",
    });
    await expect(
      refillChoiceExercisesForSkill({
        userId,
        skillId: archivedSkill.id,
        now,
        generateChoiceExercises: successfulGenerator,
        model: "test-gemini",
      }),
    ).resolves.toMatchObject({
      status: "not-refilled",
      reason: "skill-not-active",
    });
    await expect(
      refillChoiceExercisesForSkill({
        userId,
        skillId: otherSkill.id,
        now,
        generateChoiceExercises: successfulGenerator,
        model: "test-gemini",
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "skill-not-found",
    });
    await expect(
      refillChoiceExercisesForSkill({
        userId,
        skillId: "missing-skill",
        now,
        generateChoiceExercises: successfulGenerator,
        model: "test-gemini",
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "skill-not-found",
    });

    await expect(prisma.generationJob.count({ where: { userId } })).resolves.toBe(0);
  });

  it("counts only ready choice exercises when deciding refill size", async () => {
    const userId = await createUser("refill_ready_count");
    const skill = await createActiveSkillFixture({ userId });
    await createChoiceExerciseFixture({ userId, skillId: skill.id, id: 1 });
    await createChoiceExerciseFixture({
      userId,
      skillId: skill.id,
      id: 2,
      retiredAt: new Date("2026-06-04T16:05:00.000Z"),
    });
    await createChoiceExerciseFixture({
      userId,
      skillId: skill.id,
      id: 3,
      verificationStatus: ExerciseVerificationStatus.UNVERIFIED,
    });
    await createChoiceExerciseFixture({
      userId,
      skillId: skill.id,
      id: 4,
      choices: [{ id: "correct" }],
    });
    await createTextExerciseFixture({ userId, skillId: skill.id });
    let capturedRequestedCount: number | undefined;

    const result = await refillChoiceExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      targetReadyCount: 2,
      generateChoiceExercises: async (input) => {
        capturedRequestedCount = input.requestedCount;
        return {
          exercises: [generatedExercise(301)],
        };
      },
      verifyChoiceExercises: acceptAllVerifier,
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "refilled",
      exerciseCount: 1,
      readyExerciseCount: 2,
      targetReadyCount: 2,
    });
    expect(capturedRequestedCount).toBe(1);
  });

  it("refills exact-input exercises for an unlocked active skill while preserving schedule state", async () => {
    const userId = await createUser("exact_refill_success");
    const skill = await createActiveSkillFixture({
      userId,
      title: "Unlocked exact refill skill",
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    const originalSchedule = await prisma.skill.findUniqueOrThrow({
      where: { id: skill.id },
      select: {
        status: true,
        dueAt: true,
        stability: true,
        difficulty: true,
        elapsedDays: true,
        scheduledDays: true,
        learningSteps: true,
        repetitions: true,
        lapses: true,
        fsrsState: true,
        lastReviewedAt: true,
      },
    });
    let capturedRequestedCount: number | undefined;
    let capturedExistingExerciseContext: string | null | undefined;

    const generator: ExactInputExerciseGenerator = async (input) => {
      capturedRequestedCount = input.requestedCount;
      capturedExistingExerciseContext = input.existingExerciseContext;
      return {
        exercises: [
          generatedExactInputExercise(1),
          {
            prompt: "Enter the decimal equivalent of one half.",
            answerKind: AnswerKind.NUMERIC,
            answerSpec: {
              kind: "numeric",
              accepted: ["1/2", 0.5],
              tolerance: 0,
            },
            correctAnswerDisplay: "0.5",
            explanation: "One half is 0.5.",
            difficulty: 2,
            expectedSeconds: 30,
          },
        ],
      };
    };

    const result = await refillExactInputExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      generateExactInputExercises: generator,
      verifyExactInputExercises: acceptAllExactInputVerifier,
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "refilled",
      exerciseCount: DEFAULT_READY_EXACT_INPUT_TARGET,
      readyExerciseCount: DEFAULT_READY_EXACT_INPUT_TARGET,
      targetReadyCount: DEFAULT_READY_EXACT_INPUT_TARGET,
    });
    expect(capturedRequestedCount).toBe(DEFAULT_READY_EXACT_INPUT_TARGET);
    expect(capturedExistingExerciseContext).toBeNull();

    const [afterSchedule, exercises, generationJob, choicePracticeItem] = await Promise.all([
      prisma.skill.findUniqueOrThrow({
        where: { id: skill.id },
        select: {
          status: true,
          dueAt: true,
          stability: true,
          difficulty: true,
          elapsedDays: true,
          scheduledDays: true,
          learningSteps: true,
          repetitions: true,
          lapses: true,
          fsrsState: true,
          lastReviewedAt: true,
        },
      }),
      prisma.exercise.findMany({
        where: { userId, skillId: skill.id },
        orderBy: { createdAt: "asc" },
      }),
      prisma.generationJob.findFirstOrThrow({ where: { userId, skillId: skill.id } }),
      getNextChoicePracticeItemForUser(userId, now),
    ]);

    expect(afterSchedule).toEqual(originalSchedule);
    expect(exercises).toHaveLength(DEFAULT_READY_EXACT_INPUT_TARGET);
    expect(exercises.map((exercise) => exercise.answerKind).toSorted()).toEqual([
      AnswerKind.NUMERIC,
      AnswerKind.TEXT,
    ]);
    expect(generationJob).toMatchObject({
      status: GenerationJobStatus.SUCCEEDED,
      kind: GenerationJobKind.EXACT_INPUT_EXERCISE_GENERATION,
      acceptedCount: DEFAULT_READY_EXACT_INPUT_TARGET,
      rejectedCount: 0,
    });
    expect(choicePracticeItem.status).toBe("none-due");
  });

  it("does not refill exact-input exercises before the review threshold", async () => {
    const userId = await createUser("exact_refill_locked");
    const skill = await createActiveSkillFixture({
      userId,
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS - 1,
    });

    const result = await refillExactInputExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      generateExactInputExercises: async () => {
        throw new Error("Generator should not run before exact input unlocks.");
      },
      verifyExactInputExercises: acceptAllExactInputVerifier,
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "not-refilled",
      reason: "exact-input-locked",
    });

    await expect(
      Promise.all([
        prisma.exercise.count({ where: { userId, skillId: skill.id } }),
        prisma.generationJob.count({ where: { userId, skillId: skill.id } }),
      ]),
    ).resolves.toEqual([0, 0]);
  });

  it("does not refill exact-input exercises that are already at target", async () => {
    const userId = await createUser("exact_refill_noop");
    const skill = await createActiveSkillFixture({
      userId,
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    await createTextExerciseFixture({ userId, skillId: skill.id, id: 1 });
    await createNumericExerciseFixture({ userId, skillId: skill.id, id: 2 });

    const result = await refillExactInputExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      generateExactInputExercises: async () => {
        throw new Error("Generator should not run for a full exact-input queue.");
      },
      verifyExactInputExercises: acceptAllExactInputVerifier,
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "not-refilled",
      reason: "already-at-target",
      readyExerciseCount: DEFAULT_READY_EXACT_INPUT_TARGET,
    });
    await expect(
      prisma.generationJob.count({ where: { userId, skillId: skill.id } }),
    ).resolves.toBe(0);
  });

  it("creates a failed exact-input generation job without writing exercises when verification fails", async () => {
    const userId = await createUser("exact_refill_verification_fail");
    const skill = await createActiveSkillFixture({
      userId,
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });

    const result = await refillExactInputExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      generateExactInputExercises: async () => ({
        exercises: [generatedExactInputExercise(1)],
      }),
      verifyExactInputExercises: async (input) => ({
        verifications: input.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          verdict: "rejected",
          reason: "answer_mismatch",
        })),
      }),
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "not-refilled",
      reason: "invalid-verification",
    });

    const [exerciseCount, generationJob] = await Promise.all([
      prisma.exercise.count({ where: { userId, skillId: skill.id } }),
      prisma.generationJob.findFirstOrThrow({ where: { userId, skillId: skill.id } }),
    ]);

    expect(exerciseCount).toBe(0);
    expect(generationJob).toMatchObject({
      status: GenerationJobStatus.FAILED,
      kind: GenerationJobKind.EXACT_INPUT_EXERCISE_GENERATION,
      acceptedCount: 0,
      rejectedCount: 1,
    });
  });

  it("rejects non-active, missing, and cross-user exact-input refills without jobs", async () => {
    const userId = await createUser("exact_refill_rejects");
    const otherUserId = await createUser("exact_refill_rejects_other");
    const draftSkill = await createActiveSkillFixture({
      userId,
      status: SkillStatus.DRAFT,
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    const archivedSkill = await createActiveSkillFixture({
      userId,
      status: SkillStatus.ARCHIVED,
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    const otherSkill = await createActiveSkillFixture({
      userId: otherUserId,
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });

    for (const skillId of [draftSkill.id, archivedSkill.id]) {
      await expect(
        refillExactInputExercisesForSkill({
          userId,
          skillId,
          now,
          generateExactInputExercises: async () => ({
            exercises: [generatedExactInputExercise(1)],
          }),
          verifyExactInputExercises: acceptAllExactInputVerifier,
          model: "test-gemini",
        }),
      ).resolves.toMatchObject({
        status: "not-refilled",
        reason: "skill-not-active",
      });
    }

    await expect(
      refillExactInputExercisesForSkill({
        userId,
        skillId: otherSkill.id,
        now,
        generateExactInputExercises: async () => ({
          exercises: [generatedExactInputExercise(1)],
        }),
        verifyExactInputExercises: acceptAllExactInputVerifier,
        model: "test-gemini",
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "skill-not-found",
    });

    await expect(
      refillExactInputExercisesForSkill({
        userId,
        skillId: "missing-skill",
        now,
        generateExactInputExercises: async () => ({
          exercises: [generatedExactInputExercise(1)],
        }),
        verifyExactInputExercises: acceptAllExactInputVerifier,
        model: "test-gemini",
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "skill-not-found",
    });

    await expect(
      prisma.generationJob.count({
        where: { userId, kind: GenerationJobKind.EXACT_INPUT_EXERCISE_GENERATION },
      }),
    ).resolves.toBe(0);
  });

  it("returns a typed exact-input setup error when Gemini env is missing", async () => {
    const originalGeminiApiKey = process.env.GEMINI_API_KEY;
    const originalGeminiModel = process.env.GEMINI_MODEL;

    try {
      delete process.env.GEMINI_API_KEY;
      delete process.env.GEMINI_MODEL;

      const userId = await createUser("exact_refill_missing_env");
      const skill = await createActiveSkillFixture({
        userId,
        repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
      });

      const result = await refillExactInputExercisesForSkill({
        userId,
        skillId: skill.id,
        now,
      });

      expect(result).toMatchObject({
        status: "not-refilled",
        reason: "missing-gemini-env",
      });

      await expect(
        prisma.generationJob.findFirstOrThrow({
          where: { userId, skillId: skill.id },
        }),
      ).resolves.toMatchObject({
        status: GenerationJobStatus.FAILED,
        kind: GenerationJobKind.EXACT_INPUT_EXERCISE_GENERATION,
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
