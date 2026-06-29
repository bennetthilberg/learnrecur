import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

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
import {
  getNextChoicePracticeItemForUser,
  getNextPracticeItemForUser,
} from "@/app/practice/queries";
import { getDashboardHome } from "@/lib/dashboard";
import { getPrisma } from "@/lib/prisma";
import {
  activateSkillDraft,
  createSkillDraft,
  createSkillDraftFromSource,
  DEFAULT_READY_EXACT_INPUT_TARGET,
  DEFAULT_READY_EXERCISE_TARGET,
  DEFAULT_READY_MATH_TARGET,
  EXACT_INPUT_UNLOCK_REPETITIONS,
  refillMathExercisesForSkill,
  refillExactInputExercisesForSkill,
  refillChoiceExercisesForSkill,
  updateSkillDraft,
  updateSkillPracticeGuidance,
  type ChoiceExerciseGenerator,
  type ChoiceExerciseVerifier,
  type ExactInputExerciseGenerator,
  type ExactInputExerciseVerifier,
  type MathExerciseVerifier,
  type SkillDraftGenerator,
} from "@/lib/skills";
import {
  MAX_SOURCE_UPLOAD_BYTES,
  SOURCE_PROCESSING_STALE_AFTER_MS,
  dismissFailedSourceUpload,
  prepareSourceUpload,
  queueSourceUploadDrafts,
  requeueSourceUploadDraft,
  runQueuedSourceUploadDraftJob,
  type SourceTextExtractor,
  type SourceUploadStorage,
} from "@/lib/skills/uploads";
import { SourceObjectSizeLimitError } from "@/lib/storage/s3";
import {
  queueExactInputExerciseRefillForSkill,
  queueChoiceExerciseRefillForSkill,
  queueMathExerciseRefillForSkill,
  runChoiceExerciseRefillJob,
  runExactInputExerciseRefillJob,
  runMathExerciseRefillJob,
  type RefillQueueResult,
} from "@/lib/skills/refill-jobs";
import type {
  ExerciseRefillEventPayload,
  ExerciseRefillEventSender,
  SourceUploadDraftEventPayload,
  SourceUploadDraftEventSender,
} from "@/lib/inngest/events";
import { getSkillsLibrary } from "@/lib/skills/library";
import { getSkillCreationSourceRecoveryItems } from "@/lib/skills/source-recovery";
import { removeSkillSource } from "@/lib/skills/sources";
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

const generatedMathExercise = (id: number) => ({
  prompt: `Simplify math item ${id}: x + ${id}x.`,
  answerKind: AnswerKind.MATH,
  answerSpec: {
    kind: "math",
    acceptedExpressions: [`${id + 1}x`],
    equivalence: "basic-symbolic",
  },
  correctAnswerDisplay: `${id + 1}x`,
  explanation: `Combine like terms to get ${id + 1}x.`,
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

const acceptAllMathVerifier: MathExerciseVerifier = async (input) => ({
  verifications: input.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    verdict: "verified",
  })),
});

function createFakeRefillSender() {
  const choiceEvents: ExerciseRefillEventPayload[] = [];
  const exactInputEvents: ExerciseRefillEventPayload[] = [];
  const mathEvents: ExerciseRefillEventPayload[] = [];
  const sender: ExerciseRefillEventSender = {
    async sendChoiceRefillRequested(payload) {
      choiceEvents.push(payload);
    },
    async sendExactInputRefillRequested(payload) {
      exactInputEvents.push(payload);
    },
    async sendMathRefillRequested(payload) {
      mathEvents.push(payload);
    },
  };

  return {
    sender,
    choiceEvents,
    exactInputEvents,
    mathEvents,
  };
}

function createFakeSourceUploadSender() {
  const events: SourceUploadDraftEventPayload[] = [];
  const sender: SourceUploadDraftEventSender = {
    async sendSourceUploadDraftRequested(payload) {
      events.push(payload);
    },
  };

  return {
    sender,
    events,
  };
}

function expectQueued(result: RefillQueueResult): Extract<RefillQueueResult, { status: "queued" }> {
  expect(result.status).toBe("queued");

  if (result.status !== "queued") {
    throw new Error(`Expected refill queueing to succeed: ${result.message}`);
  }

  return result;
}

const generatedSkillDraft = {
  title: "Ser vs. estar in classroom sentences",
  objective: "Choose ser or estar in beginner Spanish sentences about identity and location.",
  rules: ["Use ser for identity.", "Use estar for location and temporary states."],
  examples: ["Soy estudiante.", "Estoy en casa."],
  exerciseConstraints: "Use short multiple-choice prompts with one clear verb choice.",
  tags: ["Spanish", "grammar"],
};

const splitGeneratedSkillDrafts = [
  generatedSkillDraft,
  {
    title: "Spanish preterite regular endings",
    objective: "Choose the correct regular preterite verb ending for short Spanish sentences.",
    rules: ["Use -e, -aste, -o, -amos, -aron for regular -ar verbs."],
    examples: ["Ayer hable con mi profesor.", "Nosotros estudiamos anoche."],
    exerciseConstraints: "Use one regular verb and one clear subject in each prompt.",
    tags: ["Spanish", "preterite"],
  },
  {
    title: "Spanish imperfect background actions",
    objective: "Identify when a Spanish sentence should use imperfect for background action.",
    rules: ["Use imperfect for ongoing background actions and repeated past habits."],
    examples: ["Cuando era nino, caminaba a la escuela."],
    exerciseConstraints: "Avoid mixing preterite and imperfect in the same prompt for this draft.",
    tags: ["Spanish", "imperfect"],
  },
];

const successfulSkillDraftGenerator: SkillDraftGenerator = async () => ({
  drafts: [generatedSkillDraft],
});

function createFakeUploadStorage({
  bytes = Buffer.from(
    "Use ser for identity. Use estar for location. Practice each idea with short classroom examples.",
  ),
  mimeType = "image/png",
  byteSize = bytes.byteLength,
  headError = null,
}: {
  bytes?: Buffer;
  mimeType?: string;
  byteSize?: number;
  headError?: Error | null;
} = {}) {
  const deletedKeys: string[] = [];
  const presignedUploadInputs: Parameters<SourceUploadStorage["createPresignedUploadUrl"]>[0][] = [];
  const getObjectByteInputs: Parameters<SourceUploadStorage["getObjectBytes"]>[0][] = [];
  const storage: SourceUploadStorage = {
    bucketName: "learnrecur-dev",
    async createPresignedUploadUrl(input) {
      presignedUploadInputs.push(input);

      if (input.byteSize > input.maxBytes) {
        throw new SourceObjectSizeLimitError(
          `Upload exceeds maximum size of ${input.maxBytes} bytes.`,
        );
      }

      return "https://s3.example.test/presigned-upload";
    },
    async headObject() {
      if (headError) {
        throw headError;
      }

      return {
        byteSize,
        mimeType,
      };
    },
    async getObjectBytes(input) {
      getObjectByteInputs.push(input);

      if (input.maxBytes !== undefined && bytes.byteLength > input.maxBytes) {
        throw new SourceObjectSizeLimitError(
          `S3 object exceeded maximum read size of ${input.maxBytes} bytes.`,
        );
      }

      return bytes;
    },
    async deleteObject(input) {
      deletedKeys.push(input.key);
    },
  };

  return {
    storage,
    deletedKeys,
    presignedUploadInputs,
    getObjectByteInputs,
  };
}

const successfulSourceExtractor: SourceTextExtractor = async () => ({
  extractedText:
    "Use ser for identity and long-term traits. Use estar for location and temporary states. Classroom practice should use short sentences with one obvious choice.",
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

  async function createMathExerciseFixture({
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
        answerKind: AnswerKind.MATH,
        prompt: `Simplify the math answer ${id}.`,
        answerSpec: {
          kind: "math",
          acceptedExpressions: [`${id + 1}x`],
          equivalence: "basic-symbolic",
        },
        correctAnswerDisplay: `${id + 1}x`,
        verificationStatus,
        retiredAt,
        retirementReason: retiredAt ? ExerciseRetirementReason.MANUAL : null,
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

  it("updates practice guidance for active skills owned by the user", async () => {
    const userId = await createUser("guidance");
    const otherUserId = await createUser("guidance_other");
    const skill = await prisma.skill.create({
      data: {
        userId,
        title: "Spanish articles",
        objective: "Choose the correct Spanish definite article for short noun phrases.",
        status: SkillStatus.ACTIVE,
        tags: ["spanish"],
        rules: { items: ["Use el before masculine singular nouns."] },
        examples: { items: ["el libro"] },
        exerciseConstraints: {
          notes: "Use short noun phrases.",
          answerKind: "choice",
          requestedCount: 5,
        },
        ...createInitialSkillSchedule(now),
      },
    });

    const denied = await updateSkillPracticeGuidance({
      userId: otherUserId,
      skillId: skill.id,
      input: {
        rules: "Use la for every noun.",
        examples: "la libro",
        exerciseConstraints: "This should not save.",
      },
    });

    expect(denied).toMatchObject({
      status: "not-found",
      reason: "skill-not-found",
    });

    const unchanged = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(unchanged.rules).toEqual({ items: ["Use el before masculine singular nouns."] });

    const updated = await updateSkillPracticeGuidance({
      userId,
      skillId: skill.id,
      input: {
        rules: "Prefer singular examples.\nKeep articles explicit.",
        examples: "el mapa\nla clase",
        exerciseConstraints: "Avoid ambiguous nouns with multiple accepted articles.",
      },
    });

    expect(updated).toEqual({
      status: "updated",
      skillId: skill.id,
    });

    const afterUpdate = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(afterUpdate.rules).toEqual({
      items: ["Prefer singular examples.", "Keep articles explicit."],
    });
    expect(afterUpdate.examples).toEqual({ items: ["el mapa", "la clase"] });
    expect(afterUpdate.exerciseConstraints).toEqual({
      notes: "Avoid ambiguous nouns with multiple accepted articles.",
      answerKind: "choice",
      requestedCount: 5,
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
      kind: GenerationJobKind.SKILL_ACTIVATION,
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

  it("retries draft activation by reusing a stale running activation job", async () => {
    const userId = await createUser("activate_stale_job");
    const draft = await createSkillDraft({
      userId,
      input: {
        title: "Spanish cardinal numbers",
        objective: "Choose the correct Spanish cardinal number for simple quantities.",
      },
    });

    if (draft.status !== "created") {
      throw new Error("Expected draft creation to succeed.");
    }

    const staleJob = await prisma.generationJob.create({
      data: {
        userId,
        skillId: draft.skill.id,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        status: GenerationJobStatus.RUNNING,
        provider: "google",
        model: "stale-test-gemini",
        promptVersion: "skill-mcq-v0",
        requestedCount: 5,
        startedAt: new Date(now.getTime() - 120_000),
      },
    });

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
      generationJobId: staleJob.id,
      exerciseCount: 3,
    });

    const [skill, generationJobs] = await Promise.all([
      prisma.skill.findUniqueOrThrow({ where: { id: draft.skill.id } }),
      prisma.generationJob.findMany({ where: { userId, skillId: draft.skill.id } }),
    ]);

    expect(skill.status).toBe(SkillStatus.ACTIVE);
    expect(generationJobs).toHaveLength(1);
    expect(generationJobs[0]).toMatchObject({
      id: staleJob.id,
      status: GenerationJobStatus.SUCCEEDED,
      model: "test-gemini",
      acceptedCount: 3,
      rejectedCount: 0,
      errorMessage: null,
      startedAt: now,
      completedAt: now,
    });
  });

  it("does not start a second activation while one is already running", async () => {
    const userId = await createUser("activate_running_job");
    const draft = await createSkillDraft({
      userId,
      input: {
        title: "Spanish ordinal numbers",
        objective: "Choose the correct Spanish ordinal number for simple rankings.",
      },
    });

    if (draft.status !== "created") {
      throw new Error("Expected draft creation to succeed.");
    }

    const runningJob = await prisma.generationJob.create({
      data: {
        userId,
        skillId: draft.skill.id,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        status: GenerationJobStatus.RUNNING,
        provider: "google",
        model: "test-gemini",
        promptVersion: "skill-mcq-v0",
        requestedCount: 5,
        startedAt: now,
      },
    });
    const generator = vi.fn(successfulGenerator);

    const result = await activateSkillDraft({
      userId,
      skillId: draft.skill.id,
      now,
      generateChoiceExercises: generator,
      verifyChoiceExercises: acceptAllVerifier,
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "not-activated",
      reason: "activation-in-progress",
      generationJobId: runningJob.id,
    });
    expect(generator).not.toHaveBeenCalled();

    const [skill, exerciseCount, generationJob] = await Promise.all([
      prisma.skill.findUniqueOrThrow({ where: { id: draft.skill.id } }),
      prisma.exercise.count({ where: { userId, skillId: draft.skill.id } }),
      prisma.generationJob.findUniqueOrThrow({ where: { id: runningJob.id } }),
    ]);

    expect(skill.status).toBe(SkillStatus.DRAFT);
    expect(exerciseCount).toBe(0);
    expect(generationJob.status).toBe(GenerationJobStatus.RUNNING);
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

    expect(result.skills).toHaveLength(1);
    expect(result.skillSourceRefIds).toHaveLength(1);

    const skill = await prisma.skill.findUniqueOrThrow({
      where: { id: result.skills[0].id },
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

  it("saves pasted source material when skill preparation fails", async () => {
    const userId = await createUser("source_draft_failed_saved");
    const sourceText =
      "Use ser for identity and long-term traits. Use estar for location and temporary states. Classroom practice should use short sentences with one obvious choice.";
    const result = await createSkillDraftFromSource({
      userId,
      now,
      model: "test-gemini",
      generateSkillDraft: async () => ({
        drafts: [
          {
            title: "Bad draft",
            objective: "too short",
            rules: [],
            examples: [],
            exerciseConstraints: "",
            tags: [],
          },
        ],
      }),
      input: {
        sourceText,
        sourceLabel: "Pasted ser estar notes",
      },
      persistFailedSource: true,
      skipUsageLimitCheck: true,
    });

    expect(result).toMatchObject({
      status: "not-created",
      reason: "invalid-generation",
    });

    const sourceFile = await prisma.sourceFile.findFirstOrThrow({
      where: {
        userId,
        kind: SourceFileKind.TEXT,
      },
    });
    expect(sourceFile).toMatchObject({
      status: SourceFileStatus.FAILED,
      originalName: "Pasted ser estar notes",
      mimeType: "text/plain",
      extractedText: sourceText,
    });
    expect(sourceFile.metadata).toMatchObject({
      failureReason: "invalid-generation",
    });
  });

  it("hides in-flight and linked pasted sources from skill creation recovery", async () => {
    const userId = await createUser("source_recovery_processing_text_hidden");
    const failedSource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.FAILED,
        originalName: "failed pasted source",
        mimeType: "text/plain",
        byteSize: 120,
        extractedText:
          "Use ser for identity and long-term traits. Use estar for location and temporary states.",
      },
    });
    const processingSource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.PROCESSING,
        originalName: "processing pasted source",
        mimeType: "text/plain",
        byteSize: 120,
        extractedText:
          "Use preterite for completed past actions and imperfect for background descriptions.",
      },
    });
    const linkedSource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.FAILED,
        originalName: "linked pasted source",
        mimeType: "text/plain",
        byteSize: 120,
        extractedText:
          "Linked material should stay attached to its existing draft instead of appearing as reusable saved text.",
      },
    });
    const linkedSkill = await prisma.skill.create({
      data: {
        userId,
        title: "Linked saved text",
        objective: "Keep linked failed text out of source recovery.",
        rules: [],
        examples: [],
        exerciseConstraints: null,
        tags: [],
        status: SkillStatus.DRAFT,
      },
    });
    await prisma.skillSourceRef.create({
      data: {
        userId,
        skillId: linkedSkill.id,
        sourceFileId: linkedSource.id,
      },
    });

    const recoveryItems = await getSkillCreationSourceRecoveryItems({ userId, now });

    expect(recoveryItems.map((item) => item.id)).toContain(failedSource.id);
    expect(recoveryItems.map((item) => item.id)).not.toContain(processingSource.id);
    expect(recoveryItems.map((item) => item.id)).not.toContain(linkedSource.id);
  });

  it("consumes a recovered pasted source and creates a fresh counted retry source", async () => {
    const userId = await createUser("source_recovery_consumed");
    const sourceText =
      "Use ser for identity and long-term traits. Use estar for location and temporary states. Classroom practice should use short sentences with one obvious choice.";
    const failedSource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.FAILED,
        originalName: "failed pasted source",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(sourceText, "utf8"),
        extractedText: sourceText,
      },
    });

    const result = await createSkillDraftFromSource({
      userId,
      now,
      model: "test-gemini",
      generateSkillDraft: successfulSkillDraftGenerator,
      input: {
        sourceText,
        sourceLabel: "Recovered pasted source",
      },
      recoveredSourceFileId: failedSource.id,
      skipUsageLimitCheck: true,
    });

    expect(result).toMatchObject({
      status: "created",
    });

    if (result.status !== "created") {
      throw new Error("Expected source recovery draft creation to succeed.");
    }

    expect(result.sourceFileId).not.toBe(failedSource.id);

    const consumedSource = await prisma.sourceFile.findUniqueOrThrow({
      where: { id: failedSource.id },
    });
    expect(consumedSource.status).toBe(SourceFileStatus.READY);
    expect(consumedSource.metadata).toMatchObject({
      recoveredIntoSourceFileId: result.sourceFileId,
    });

    const retrySource = await prisma.sourceFile.findUniqueOrThrow({
      where: { id: result.sourceFileId },
      include: {
        skillRefs: true,
      },
    });
    expect(retrySource.status).toBe(SourceFileStatus.READY);
    expect(retrySource.originalName).toBe("Recovered pasted source");
    expect(retrySource.metadata).toMatchObject({
      recoveredFromSourceFileId: failedSource.id,
    });
    expect(retrySource.skillRefs).toHaveLength(1);

    const pastedSourceCount = await prisma.sourceFile.count({
      where: {
        userId,
        kind: SourceFileKind.TEXT,
      },
    });
    expect(pastedSourceCount).toBe(2);

    const recoveryItems = await getSkillCreationSourceRecoveryItems({ userId, now });
    expect(recoveryItems.map((item) => item.id)).not.toContain(failedSource.id);
    expect(recoveryItems.map((item) => item.id)).not.toContain(result.sourceFileId);
  });

  it("creates a fresh recoverable retry source when recovered pasted text fails again", async () => {
    const userId = await createUser("source_recovery_failed_retry");
    const sourceText =
      "Use ser for identity and long-term traits. Use estar for location and temporary states. Classroom practice should use short sentences with one obvious choice.";
    const failedSource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.FAILED,
        originalName: "failed pasted source",
        mimeType: "text/plain",
        byteSize: Buffer.byteLength(sourceText, "utf8"),
        extractedText: sourceText,
      },
    });

    const result = await createSkillDraftFromSource({
      userId,
      now,
      model: "test-gemini",
      generateSkillDraft: async () => {
        throw new Error("Model unavailable.");
      },
      input: {
        sourceText,
        sourceLabel: "Recovered pasted source",
      },
      recoveredSourceFileId: failedSource.id,
      skipUsageLimitCheck: true,
    });

    expect(result).toMatchObject({
      status: "not-created",
      reason: "generation-failed",
    });

    const sourceFiles = await prisma.sourceFile.findMany({
      where: {
        userId,
        kind: SourceFileKind.TEXT,
      },
      orderBy: {
        createdAt: "asc",
      },
    });
    expect(sourceFiles).toHaveLength(2);
    expect(sourceFiles[0]).toMatchObject({
      id: failedSource.id,
      status: SourceFileStatus.READY,
    });
    expect(sourceFiles[1]).toMatchObject({
      status: SourceFileStatus.FAILED,
      originalName: "Recovered pasted source",
    });
    expect(sourceFiles[1].metadata).toMatchObject({
      recoveredFromSourceFileId: failedSource.id,
      failureReason: "generation-failed",
    });

    const recoveryItems = await getSkillCreationSourceRecoveryItems({ userId, now });
    expect(recoveryItems.map((item) => item.id)).not.toContain(failedSource.id);
    expect(recoveryItems.map((item) => item.id)).toContain(sourceFiles[1].id);
  });

  it("splits broad source material into multiple draft skills linked to one source", async () => {
    const userId = await createUser("source_split");
    const result = await createSkillDraftFromSource({
      userId,
      now,
      model: "test-gemini",
      generateSkillDraft: async () => ({
        drafts: splitGeneratedSkillDrafts,
      }),
      input: {
        sourceText:
          "This broad Spanish review page covers ser and estar, regular preterite endings, and imperfect background actions with classroom examples for each topic.",
        sourceLabel: "Spanish unit review",
        focusNote: "Split into small grammar skills when the page covers multiple topics.",
        collectionName: "Spanish grammar",
        tags: "Spanish, review",
      },
    });

    expect(result.status).toBe("created");

    if (result.status !== "created") {
      throw new Error("Expected source draft creation to succeed.");
    }

    expect(result.skills).toHaveLength(3);
    expect(result.skillSourceRefIds).toHaveLength(3);

    const sourceFile = await prisma.sourceFile.findUniqueOrThrow({
      where: { id: result.sourceFileId },
      include: {
        skillRefs: {
          orderBy: { createdAt: "asc" },
          include: {
            skill: {
              include: {
                collection: true,
              },
            },
          },
        },
      },
    });

    expect(sourceFile).toMatchObject({
      userId,
      kind: SourceFileKind.TEXT,
      status: SourceFileStatus.READY,
      originalName: "Spanish unit review",
      mimeType: "text/plain",
    });
    expect(sourceFile.metadata).toMatchObject({
      focusNote: "Split into small grammar skills when the page covers multiple topics.",
      model: "test-gemini",
    });
    expect(sourceFile.skillRefs).toHaveLength(3);
    expect(sourceFile.skillRefs.map((ref) => ref.skill.title).toSorted()).toEqual(
      splitGeneratedSkillDrafts.map((draft) => draft.title).toSorted(),
    );
    expect(
      sourceFile.skillRefs.every(
        (ref) =>
          ref.userId === userId &&
          ref.sourceFileId === result.sourceFileId &&
          ref.note === "Split into small grammar skills when the page covers multiple topics." &&
          ref.skill.collection?.name === "Spanish grammar",
      ),
    ).toBe(true);
    expect(
      sourceFile.skillRefs.every((ref) => ref.skill.tags.includes("spanish")),
    ).toBe(true);
    expect(
      sourceFile.skillRefs.every((ref) => ref.skill.tags.includes("review")),
    ).toBe(true);

    const library = await getSkillsLibrary({ userId, now });
    expect(library.draftSkills.map((skill) => skill.title).toSorted()).toEqual(
      splitGeneratedSkillDrafts.map((draft) => draft.title).toSorted(),
    );
    expect(library.draftSkills.every((skill) => skill.sourceRefCount === 1)).toBe(true);

    const firstRef = sourceFile.skillRefs[0];
    const removed = await removeSkillSource({
      userId,
      skillId: firstRef.skillId,
      sourceRefId: firstRef.id,
    });

    expect(removed).toMatchObject({
      status: "removed",
      sourceFileDeleted: false,
    });
    await expect(
      prisma.sourceFile.count({ where: { id: result.sourceFileId, userId } }),
    ).resolves.toBe(1);
    await expect(
      prisma.skillSourceRef.count({ where: { sourceFileId: result.sourceFileId, userId } }),
    ).resolves.toBe(2);
  });

  it("creates source-backed draft skills from an uploaded source object", async () => {
    const userId = await createUser("upload_success");
    const { storage, presignedUploadInputs, getObjectByteInputs } = createFakeUploadStorage({
      byteSize: 4096,
    });
    const { sender, events } = createFakeSourceUploadSender();
    const prepared = await prepareSourceUpload({
      userId,
      now,
      storage,
      input: {
        originalName: "worksheet.png",
        mimeType: "image/png",
        byteSize: "4096",
        sourceLabel: "Uploaded worksheet",
        focusNote: "Split this into small grammar skills.",
        collectionName: "Spanish uploads",
        tags: "Spanish, upload",
      },
    });

    expect(prepared.status).toBe("prepared");

    if (prepared.status !== "prepared") {
      throw new Error("Expected upload preparation to succeed.");
    }

    expect(prepared.uploadUrl).toBe("https://s3.example.test/presigned-upload");
    expect(prepared.headers).toEqual({ "Content-Type": "image/png" });
    expect(prepared.objectKey).toContain(`source-uploads/${userId}/`);
    expect(presignedUploadInputs).toEqual([
      {
        key: prepared.objectKey,
        mimeType: "image/png",
        byteSize: 4096,
        maxBytes: MAX_SOURCE_UPLOAD_BYTES,
        expiresInSeconds: 600,
      },
    ]);

    const queued = await queueSourceUploadDrafts({
      userId,
      sourceFileId: prepared.sourceFileId,
      now,
      storage,
      eventSender: sender,
    });

    expect(queued).toMatchObject({
      status: "queued",
      sourceFileId: prepared.sourceFileId,
    });
    expect(events).toEqual([
      {
        userId,
        sourceFileId: prepared.sourceFileId,
        requestedAt: now.toISOString(),
      },
    ]);
    await expect(prisma.skill.count({ where: { userId } })).resolves.toBe(0);

    const queuedLibrary = await getSkillsLibrary({ userId, now });
    expect(queuedLibrary.sourceProcessing).toHaveLength(1);
    expect(queuedLibrary.sourceProcessing[0]).toMatchObject({
      id: prepared.sourceFileId,
      originalName: "Uploaded worksheet",
      status: SourceFileStatus.UPLOADED,
    });

    const completed = await runQueuedSourceUploadDraftJob({
      userId,
      sourceFileId: prepared.sourceFileId,
      now,
      storage,
      extractSourceText: successfulSourceExtractor,
      generateSkillDraft: async () => ({
        drafts: splitGeneratedSkillDrafts,
      }),
      model: "test-gemini",
    });

    expect(completed.status).toBe("created");
    expect(getObjectByteInputs).toEqual([
      {
        key: prepared.objectKey,
        bucket: "learnrecur-dev",
        maxBytes: MAX_SOURCE_UPLOAD_BYTES,
      },
    ]);

    if (completed.status !== "created") {
      throw new Error("Expected uploaded source completion to succeed.");
    }

    expect(completed.skills).toHaveLength(3);
    expect(completed.skillSourceRefIds).toHaveLength(3);

    const sourceFile = await prisma.sourceFile.findUniqueOrThrow({
      where: { id: completed.sourceFileId },
      include: {
        skillRefs: {
          include: {
            skill: {
              include: {
                collection: true,
              },
            },
          },
        },
      },
    });

    expect(sourceFile).toMatchObject({
      userId,
      kind: SourceFileKind.IMAGE,
      status: SourceFileStatus.READY,
      originalName: "Uploaded worksheet",
      mimeType: "image/png",
      byteSize: 4096,
      storageBucket: "learnrecur-dev",
    });
    expect(sourceFile.storageKey).toContain(`source-uploads/${userId}/`);
    expect(sourceFile.extractedText).toContain("Use ser for identity");
    expect(sourceFile.metadata).toMatchObject({
      createdBy: "source-upload-drafts-v0",
      originalFileName: "worksheet.png",
      focusNote: "Split this into small grammar skills.",
      model: "test-gemini",
    });
    expect(sourceFile.skillRefs).toHaveLength(3);
    expect(sourceFile.skillRefs.every((ref) => ref.skill.collection?.name === "Spanish uploads")).toBe(
      true,
    );

    const library = await getSkillsLibrary({ userId, now });
    expect(library.draftSkills.map((skill) => skill.title).toSorted()).toEqual(
      splitGeneratedSkillDrafts.map((draft) => draft.title).toSorted(),
    );
    expect(library.draftSkills.every((skill) => skill.sourceRefCount === 1)).toBe(true);
    expect(library.sourceProcessing).toHaveLength(0);
  });

  it("cleans up uploaded source state when extraction validation fails", async () => {
    const userId = await createUser("upload_invalid_extraction");
    const { storage, deletedKeys } = createFakeUploadStorage({
      byteSize: 2048,
      mimeType: "application/pdf",
    });
    const prepared = await prepareSourceUpload({
      userId,
      now,
      storage,
      input: {
        originalName: "bad.pdf",
        mimeType: "application/pdf",
        byteSize: "2048",
      },
    });

    if (prepared.status !== "prepared") {
      throw new Error("Expected upload preparation to succeed.");
    }

    const { sender } = createFakeSourceUploadSender();
    const queued = await queueSourceUploadDrafts({
      userId,
      sourceFileId: prepared.sourceFileId,
      now,
      storage,
      eventSender: sender,
    });

    expect(queued.status).toBe("queued");

    const completed = await runQueuedSourceUploadDraftJob({
      userId,
      sourceFileId: prepared.sourceFileId,
      now,
      storage,
      extractSourceText: async () => ({
        extractedText: "   ",
      }),
      generateSkillDraft: successfulSkillDraftGenerator,
      model: "test-gemini",
    });

    expect(completed).toMatchObject({
      status: "not-created",
      reason: "invalid-extraction",
    });
    await expect(prisma.skill.count({ where: { userId } })).resolves.toBe(0);
    const failedSource = await prisma.sourceFile.findUniqueOrThrow({
      where: { id: prepared.sourceFileId },
    });
    expect(failedSource.status).toBe(SourceFileStatus.FAILED);
    expect(failedSource.storageKey).toBe(prepared.objectKey);
    expect(failedSource.metadata).toMatchObject({
      failureReason: "invalid-extraction",
    });
    const library = await getSkillsLibrary({ userId, now });
    expect(library.sourceProcessing).toHaveLength(1);
    expect(library.sourceProcessing[0]).toMatchObject({
      status: SourceFileStatus.FAILED,
      errorMessage: "The AI could not extract enough study text from this file.",
      canRequeue: true,
    });
    await expect(prisma.skillSourceRef.count({ where: { userId } })).resolves.toBe(0);
    expect(deletedKeys).toEqual([]);
  });

  it("stores a public error when uploaded source extraction is temporarily unavailable", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const userId = await createUser("upload_extraction_unavailable");
    const { storage, deletedKeys } = createFakeUploadStorage({
      byteSize: 2048,
      mimeType: "image/png",
    });
    const prepared = await prepareSourceUpload({
      userId,
      now,
      storage,
      input: {
        originalName: "busy-model.png",
        mimeType: "image/png",
        byteSize: "2048",
      },
    });

    if (prepared.status !== "prepared") {
      throw new Error("Expected upload preparation to succeed.");
    }

    const { sender } = createFakeSourceUploadSender();
    const queued = await queueSourceUploadDrafts({
      userId,
      sourceFileId: prepared.sourceFileId,
      now,
      storage,
      eventSender: sender,
    });

    expect(queued.status).toBe("queued");

    try {
      const completed = await runQueuedSourceUploadDraftJob({
        userId,
        sourceFileId: prepared.sourceFileId,
        now,
        storage,
        extractSourceText: async () => {
          throw new Error(
            JSON.stringify({
              error: {
                code: 503,
                message: "This model is currently experiencing high demand.",
                status: "UNAVAILABLE",
              },
            }),
          );
        },
        generateSkillDraft: successfulSkillDraftGenerator,
        model: "test-gemini",
      });

      expect(completed).toMatchObject({
        status: "not-created",
        reason: "extraction-failed",
        message:
          "The AI service is busy right now, so LearnRecur could not finish creating this skill. Try again in a minute.",
      });
      expect(completed.message).not.toContain("{");

      const failedSource = await prisma.sourceFile.findUniqueOrThrow({
        where: { id: prepared.sourceFileId },
      });
      expect(failedSource.storageKey).toBe(prepared.objectKey);
      expect(failedSource.metadata).toMatchObject({
        failureReason: "extraction-failed",
        errorMessage:
          "The AI service is busy right now, so LearnRecur could not finish creating this skill. Try again in a minute.",
      });

      const library = await getSkillsLibrary({ userId, now });
      expect(library.sourceProcessing[0]).toMatchObject({
        status: SourceFileStatus.FAILED,
        errorMessage:
          "The AI service is busy right now, so LearnRecur could not finish creating this skill. Try again in a minute.",
        canRequeue: true,
      });
      expect(library.sourceProcessing[0].errorMessage).not.toContain("{");
      expect(deletedKeys).toEqual([]);
      expect(consoleError).toHaveBeenCalledWith(
        "[ai] source extraction failed",
        expect.objectContaining({
          code: 503,
          status: "UNAVAILABLE",
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("cleans up uploaded source state when downloaded bytes exceed the upload limit", async () => {
    const userId = await createUser("upload_oversized_download");
    const { storage, deletedKeys } = createFakeUploadStorage({
      byteSize: 2048,
      bytes: Buffer.alloc(MAX_SOURCE_UPLOAD_BYTES + 1, "a"),
    });
    const prepared = await prepareSourceUpload({
      userId,
      now,
      storage,
      input: {
        originalName: "oversized-after-head.png",
        mimeType: "image/png",
        byteSize: "2048",
      },
    });

    if (prepared.status !== "prepared") {
      throw new Error("Expected upload preparation to succeed.");
    }

    const { sender } = createFakeSourceUploadSender();
    const queued = await queueSourceUploadDrafts({
      userId,
      sourceFileId: prepared.sourceFileId,
      now,
      storage,
      eventSender: sender,
    });

    expect(queued.status).toBe("queued");

    const completed = await runQueuedSourceUploadDraftJob({
      userId,
      sourceFileId: prepared.sourceFileId,
      now,
      storage,
      extractSourceText: successfulSourceExtractor,
      generateSkillDraft: successfulSkillDraftGenerator,
      model: "test-gemini",
    });

    expect(completed).toMatchObject({
      status: "not-created",
      reason: "invalid-upload",
    });
    await expect(prisma.skill.count({ where: { userId } })).resolves.toBe(0);
    const failedSource = await prisma.sourceFile.findUniqueOrThrow({
      where: { id: prepared.sourceFileId },
    });
    expect(failedSource.status).toBe(SourceFileStatus.FAILED);
    expect(failedSource.storageKey).toBe(prepared.objectKey);
    expect(failedSource.metadata).toMatchObject({
      failureReason: "invalid-upload",
      errorMessage: "Uploaded file is missing or larger than 10 MB.",
    });
    const library = await getSkillsLibrary({ userId, now });
    expect(library.sourceProcessing).toHaveLength(1);
    const sourceProcessing = library.sourceProcessing[0];
    expect(sourceProcessing.id).toBe(prepared.sourceFileId);
    expect(sourceProcessing).toMatchObject({
      status: SourceFileStatus.FAILED,
      errorMessage: "Uploaded file is missing or larger than 10 MB.",
      canRequeue: true,
    });
    expect(deletedKeys).toEqual([]);
  });

  it("does not process the same uploaded source twice", async () => {
    const userId = await createUser("upload_duplicate_completion");
    const { storage } = createFakeUploadStorage({
      byteSize: 4096,
    });
    const prepared = await prepareSourceUpload({
      userId,
      now,
      storage,
      input: {
        originalName: "worksheet.png",
        mimeType: "image/png",
        byteSize: "4096",
      },
    });

    if (prepared.status !== "prepared") {
      throw new Error("Expected upload preparation to succeed.");
    }

    const { sender } = createFakeSourceUploadSender();
    const queued = await queueSourceUploadDrafts({
      userId,
      sourceFileId: prepared.sourceFileId,
      now,
      storage,
      eventSender: sender,
    });

    expect(queued.status).toBe("queued");

    const firstCompletion = await runQueuedSourceUploadDraftJob({
      userId,
      sourceFileId: prepared.sourceFileId,
      now,
      storage,
      extractSourceText: successfulSourceExtractor,
      generateSkillDraft: successfulSkillDraftGenerator,
      model: "test-gemini",
    });

    expect(firstCompletion.status).toBe("created");

    const secondCompletion = await runQueuedSourceUploadDraftJob({
      userId,
      sourceFileId: prepared.sourceFileId,
      now,
      storage,
      extractSourceText: successfulSourceExtractor,
      generateSkillDraft: successfulSkillDraftGenerator,
      model: "test-gemini",
    });

    expect(secondCompletion).toMatchObject({
      status: "not-created",
      reason: "invalid-upload",
    });
    await expect(prisma.skill.count({ where: { userId } })).resolves.toBe(1);
    await expect(prisma.skillSourceRef.count({ where: { userId } })).resolves.toBe(1);
  });

  it("rejects cross-user uploaded source completion without cleanup", async () => {
    const userId = await createUser("upload_cross_owner");
    const otherUserId = await createUser("upload_cross_other");
    const { storage, deletedKeys } = createFakeUploadStorage();
    const prepared = await prepareSourceUpload({
      userId,
      now,
      storage,
      input: {
        originalName: "worksheet.png",
        mimeType: "image/png",
        byteSize: "4096",
      },
    });

    if (prepared.status !== "prepared") {
      throw new Error("Expected upload preparation to succeed.");
    }

    await expect(
      queueSourceUploadDrafts({
        userId: otherUserId,
        sourceFileId: prepared.sourceFileId,
        now,
        storage,
        eventSender: createFakeSourceUploadSender().sender,
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "source-not-found",
    });
    await expect(prisma.sourceFile.count({ where: { id: prepared.sourceFileId } })).resolves.toBe(1);
    expect(deletedKeys).toEqual([]);
  });

  it("cleans up uploaded source state when queueing fails before the job starts", async () => {
    const userId = await createUser("upload_queue_failure");
    const { storage, deletedKeys } = createFakeUploadStorage({
      byteSize: 4096,
    });
    const prepared = await prepareSourceUpload({
      userId,
      now,
      storage,
      input: {
        originalName: "queue-failure.png",
        mimeType: "image/png",
        byteSize: "4096",
      },
    });

    if (prepared.status !== "prepared") {
      throw new Error("Expected upload preparation to succeed.");
    }

    const queued = await queueSourceUploadDrafts({
      userId,
      sourceFileId: prepared.sourceFileId,
      now,
      storage,
      eventSender: {
        async sendSourceUploadDraftRequested() {
          throw new Error("event transport down");
        },
      },
    });

    expect(queued).toMatchObject({
      status: "not-queued",
      reason: "event-send-failed",
    });
    await expect(prisma.sourceFile.count({ where: { id: prepared.sourceFileId } })).resolves.toBe(
      0,
    );
    expect(deletedKeys).toEqual([prepared.objectKey]);
  });

  it("requeues an uploaded source without creating drafts synchronously", async () => {
    const userId = await createUser("upload_requeue_uploaded");
    const { storage } = createFakeUploadStorage({
      byteSize: 4096,
    });
    const prepared = await prepareSourceUpload({
      userId,
      now,
      storage,
      input: {
        originalName: "queued-again.png",
        mimeType: "image/png",
        byteSize: "4096",
      },
    });

    if (prepared.status !== "prepared") {
      throw new Error("Expected upload preparation to succeed.");
    }

    const firstSender = createFakeSourceUploadSender();
    await expect(
      queueSourceUploadDrafts({
        userId,
        sourceFileId: prepared.sourceFileId,
        now,
        storage,
        eventSender: firstSender.sender,
      }),
    ).resolves.toMatchObject({ status: "queued" });

    const { sender, events } = createFakeSourceUploadSender();
    const requeueAt = new Date(now.getTime() + 60_000);
    const requeued = await requeueSourceUploadDraft({
      userId,
      sourceFileId: prepared.sourceFileId,
      now: requeueAt,
      storage,
      eventSender: sender,
    });

    expect(requeued).toMatchObject({
      status: "queued",
      sourceFileId: prepared.sourceFileId,
    });
    expect(events).toEqual([
      {
        userId,
        sourceFileId: prepared.sourceFileId,
        requestedAt: requeueAt.toISOString(),
      },
    ]);
    await expect(prisma.skill.count({ where: { userId } })).resolves.toBe(0);

    const sourceFile = await prisma.sourceFile.findUniqueOrThrow({
      where: { id: prepared.sourceFileId },
    });
    expect(sourceFile.status).toBe(SourceFileStatus.UPLOADED);
    expect(sourceFile.metadata).toMatchObject({
      queuedAt: requeueAt.toISOString(),
      requeuedAt: requeueAt.toISOString(),
      retryCount: 1,
    });
  });

  it("rolls back requeue state when event sending fails", async () => {
    const userId = await createUser("upload_requeue_send_failure");
    const { storage, deletedKeys } = createFakeUploadStorage({
      byteSize: 4096,
    });
    const prepared = await prepareSourceUpload({
      userId,
      now,
      storage,
      input: {
        originalName: "requeue-send-failure.png",
        mimeType: "image/png",
        byteSize: "4096",
      },
    });

    if (prepared.status !== "prepared") {
      throw new Error("Expected upload preparation to succeed.");
    }

    await queueSourceUploadDrafts({
      userId,
      sourceFileId: prepared.sourceFileId,
      now,
      storage,
      eventSender: createFakeSourceUploadSender().sender,
    });
    const originalMetadata = {
      processingStartedAt: new Date(
        now.getTime() - SOURCE_PROCESSING_STALE_AFTER_MS,
      ).toISOString(),
      retryCount: 2,
    };
    await prisma.sourceFile.update({
      where: { id: prepared.sourceFileId },
      data: {
        status: SourceFileStatus.PROCESSING,
        byteSize: 2048,
        metadata: originalMetadata,
      },
    });

    const requeued = await requeueSourceUploadDraft({
      userId,
      sourceFileId: prepared.sourceFileId,
      now,
      storage,
      eventSender: {
        async sendSourceUploadDraftRequested() {
          throw new Error("event transport down");
        },
      },
    });

    expect(requeued).toMatchObject({
      status: "not-queued",
      reason: "event-send-failed",
    });
    const sourceFile = await prisma.sourceFile.findUniqueOrThrow({
      where: { id: prepared.sourceFileId },
    });
    expect(sourceFile.status).toBe(SourceFileStatus.PROCESSING);
    expect(sourceFile.byteSize).toBe(2048);
    expect(sourceFile.metadata).toEqual(originalMetadata);
    expect(sourceFile.storageKey).toBe(prepared.objectKey);
    expect(deletedKeys).toEqual([]);
  });

  it("requeues stale processing sources and rejects fresh processing sources", async () => {
    const userId = await createUser("upload_requeue_processing");
    const { storage } = createFakeUploadStorage({
      byteSize: 4096,
    });
    const prepared = await prepareSourceUpload({
      userId,
      now,
      storage,
      input: {
        originalName: "stale-processing.png",
        mimeType: "image/png",
        byteSize: "4096",
      },
    });

    if (prepared.status !== "prepared") {
      throw new Error("Expected upload preparation to succeed.");
    }

    await queueSourceUploadDrafts({
      userId,
      sourceFileId: prepared.sourceFileId,
      now,
      storage,
      eventSender: createFakeSourceUploadSender().sender,
    });

    const staleStartedAt = new Date(
      now.getTime() - SOURCE_PROCESSING_STALE_AFTER_MS,
    ).toISOString();
    await prisma.sourceFile.update({
      where: { id: prepared.sourceFileId },
      data: {
        status: SourceFileStatus.PROCESSING,
        metadata: {
          processingStartedAt: staleStartedAt,
        },
      },
    });

    const { sender, events } = createFakeSourceUploadSender();
    const requeued = await requeueSourceUploadDraft({
      userId,
      sourceFileId: prepared.sourceFileId,
      now,
      storage,
      eventSender: sender,
    });

    expect(requeued).toMatchObject({
      status: "queued",
      sourceFileId: prepared.sourceFileId,
    });
    expect(events).toHaveLength(1);
    const sourceFile = await prisma.sourceFile.findUniqueOrThrow({
      where: { id: prepared.sourceFileId },
    });
    expect(sourceFile.status).toBe(SourceFileStatus.UPLOADED);
    expect(sourceFile.metadata).toMatchObject({
      processingStartedAt: staleStartedAt,
      requeuedAt: now.toISOString(),
      retryCount: 1,
    });

    const freshPrepared = await prepareSourceUpload({
      userId,
      now,
      storage,
      input: {
        originalName: "fresh-processing.png",
        mimeType: "image/png",
        byteSize: "4096",
      },
    });

    if (freshPrepared.status !== "prepared") {
      throw new Error("Expected upload preparation to succeed.");
    }

    await queueSourceUploadDrafts({
      userId,
      sourceFileId: freshPrepared.sourceFileId,
      now,
      storage,
      eventSender: createFakeSourceUploadSender().sender,
    });
    await prisma.sourceFile.update({
      where: { id: freshPrepared.sourceFileId },
      data: {
        status: SourceFileStatus.PROCESSING,
        metadata: {
          processingStartedAt: now.toISOString(),
        },
      },
    });

    const freshSender = createFakeSourceUploadSender();
    await expect(
      requeueSourceUploadDraft({
        userId,
        sourceFileId: freshPrepared.sourceFileId,
        now,
        storage,
        eventSender: freshSender.sender,
      }),
    ).resolves.toMatchObject({
      status: "not-queued",
      reason: "not-stale",
    });
    expect(freshSender.events).toHaveLength(0);
  });

  it("rejects requeue for non-recoverable, missing, and cross-user sources", async () => {
    const userId = await createUser("upload_requeue_reject");
    const otherUserId = await createUser("upload_requeue_reject_other");
    const { storage } = createFakeUploadStorage();
    const readySource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.IMAGE,
        status: SourceFileStatus.READY,
        originalName: "ready upload",
        mimeType: "image/png",
        byteSize: 1024,
        storageBucket: "learnrecur-dev",
        storageKey: `source-uploads/${userId}/ready.png`,
      },
    });
    const failedSource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.IMAGE,
        status: SourceFileStatus.FAILED,
        originalName: "failed upload",
        mimeType: "image/png",
      },
    });
    const savedFailedSource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.IMAGE,
        status: SourceFileStatus.FAILED,
        originalName: "saved failed upload",
        mimeType: "image/png",
        byteSize: 1024,
        storageBucket: "learnrecur-dev",
        storageKey: `source-uploads/${userId}/failed.png`,
      },
    });
    const textFailedSource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.FAILED,
        originalName: "failed pasted source",
        mimeType: "text/plain",
        byteSize: 1024,
        extractedText:
          "Use ser for identity and long-term traits. Use estar for location and temporary states.",
      },
    });
    const linkedSkill = await createSkillDraft({
      userId,
      input: {
        title: "Linked failed upload",
        objective: "Review an upload already attached to another skill.",
      },
    });

    if (linkedSkill.status !== "created") {
      throw new Error("Expected linked draft creation to succeed.");
    }

    const linkedFailedSource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.IMAGE,
        status: SourceFileStatus.FAILED,
        originalName: "linked failed upload",
        mimeType: "image/png",
        byteSize: 1024,
        storageBucket: "learnrecur-dev",
        storageKey: `source-uploads/${userId}/linked-failed.png`,
      },
    });
    await prisma.skillSourceRef.create({
      data: {
        userId,
        skillId: linkedSkill.skill.id,
        sourceFileId: linkedFailedSource.id,
      },
    });

    await expect(
      requeueSourceUploadDraft({
        userId,
        sourceFileId: readySource.id,
        now,
        storage,
        eventSender: createFakeSourceUploadSender().sender,
      }),
    ).resolves.toMatchObject({
      status: "not-queued",
      reason: "not-requeueable",
    });
    await expect(
      requeueSourceUploadDraft({
        userId,
        sourceFileId: failedSource.id,
        now,
        storage,
        eventSender: createFakeSourceUploadSender().sender,
      }),
    ).resolves.toMatchObject({
      status: "not-queued",
      reason: "not-requeueable",
    });
    await expect(
      requeueSourceUploadDraft({
        userId,
        sourceFileId: textFailedSource.id,
        now,
        storage,
        eventSender: createFakeSourceUploadSender().sender,
      }),
    ).resolves.toMatchObject({
      status: "not-queued",
      reason: "not-requeueable",
    });
    await expect(
      requeueSourceUploadDraft({
        userId,
        sourceFileId: linkedFailedSource.id,
        now,
        storage,
        eventSender: createFakeSourceUploadSender().sender,
      }),
    ).resolves.toMatchObject({
      status: "not-queued",
      reason: "not-requeueable",
    });

    const retrySender = createFakeSourceUploadSender();
    await expect(
      requeueSourceUploadDraft({
        userId,
        sourceFileId: savedFailedSource.id,
        now,
        storage,
        eventSender: retrySender.sender,
      }),
    ).resolves.toMatchObject({
      status: "queued",
      sourceFileId: savedFailedSource.id,
    });
    expect(retrySender.events).toHaveLength(1);
    await expect(
      requeueSourceUploadDraft({
        userId,
        sourceFileId: "missing-source-file",
        now,
        storage,
        eventSender: createFakeSourceUploadSender().sender,
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "source-not-found",
    });
    await expect(
      requeueSourceUploadDraft({
        userId: otherUserId,
        sourceFileId: readySource.id,
        now,
        storage,
        eventSender: createFakeSourceUploadSender().sender,
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "source-not-found",
    });
  });

  it("rejects requeue when storage metadata or the S3 object is missing", async () => {
    const userId = await createUser("upload_requeue_missing_storage");
    const incompleteSource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.IMAGE,
        status: SourceFileStatus.UPLOADED,
        originalName: "incomplete upload",
        mimeType: "image/png",
        byteSize: 2048,
        storageBucket: "learnrecur-dev",
      },
    });
    const missingObjectSource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.IMAGE,
        status: SourceFileStatus.UPLOADED,
        originalName: "missing object",
        mimeType: "image/png",
        byteSize: 2048,
        storageBucket: "learnrecur-dev",
        storageKey: `source-uploads/${userId}/missing-object.png`,
      },
    });
    const sender = createFakeSourceUploadSender();

    await expect(
      requeueSourceUploadDraft({
        userId,
        sourceFileId: incompleteSource.id,
        now,
        storage: createFakeUploadStorage().storage,
        eventSender: sender.sender,
      }),
    ).resolves.toMatchObject({
      status: "not-queued",
      reason: "invalid-upload",
    });
    await expect(
      requeueSourceUploadDraft({
        userId,
        sourceFileId: missingObjectSource.id,
        now,
        storage: createFakeUploadStorage({
          headError: new Error("object missing"),
        }).storage,
        eventSender: sender.sender,
      }),
    ).resolves.toMatchObject({
      status: "not-queued",
      reason: "invalid-upload",
    });
    expect(sender.events).toHaveLength(0);
  });

  it("keeps failed uploaded source rows visible without a dismiss path", async () => {
    const userId = await createUser("upload_failed_saved_row");
    const failedSource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.FAILED,
        originalName: "failed worksheet",
        mimeType: "application/pdf",
        byteSize: 1024,
        storageBucket: "learnrecur-dev",
        storageKey: `source-uploads/${userId}/failed.pdf`,
        metadata: {
          errorMessage: "Gemini could not extract enough study text from this file.",
        },
      },
    });

    await expect(getSkillsLibrary({ userId, now })).resolves.toMatchObject({
      sourceProcessing: [
        {
          id: failedSource.id,
          status: SourceFileStatus.FAILED,
          canDismiss: false,
          canRequeue: true,
        },
      ],
    });

    await expect(prisma.sourceFile.count({ where: { id: failedSource.id } })).resolves.toBe(1);
  });

  it("rejects dismissal for cross-user, linked, and non-failed uploaded sources", async () => {
    const userId = await createUser("upload_dismiss_reject");
    const otherUserId = await createUser("upload_dismiss_reject_other");
    const linkedSkill = await createSkillDraft({
      userId,
      input: {
        title: "Linked failed source skill",
        objective: "Review a linked failed source without deleting its history.",
      },
    });

    if (linkedSkill.status !== "created") {
      throw new Error("Expected draft creation to succeed.");
    }

    const linkedFailedSource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.IMAGE,
        status: SourceFileStatus.FAILED,
        originalName: "linked failed source",
        mimeType: "image/png",
      },
    });
    await prisma.skillSourceRef.create({
      data: {
        userId,
        skillId: linkedSkill.skill.id,
        sourceFileId: linkedFailedSource.id,
      },
    });
    const readySource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.IMAGE,
        status: SourceFileStatus.READY,
        originalName: "ready source",
        mimeType: "image/png",
      },
    });

    const library = await getSkillsLibrary({ userId, now });
    expect(library.sourceProcessing).toEqual([
      expect.objectContaining({
        id: linkedFailedSource.id,
        status: SourceFileStatus.FAILED,
        canDismiss: false,
      }),
    ]);

    await expect(
      dismissFailedSourceUpload({
        userId,
        sourceFileId: linkedFailedSource.id,
      }),
    ).resolves.toMatchObject({
      status: "not-dismissed",
      reason: "linked-source",
    });
    await expect(
      dismissFailedSourceUpload({
        userId,
        sourceFileId: readySource.id,
      }),
    ).resolves.toMatchObject({
      status: "not-dismissed",
      reason: "not-failed",
    });
    await expect(
      dismissFailedSourceUpload({
        userId: otherUserId,
        sourceFileId: linkedFailedSource.id,
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "source-not-found",
    });
    await expect(
      prisma.sourceFile.count({
        where: {
          id: {
            in: [linkedFailedSource.id, readySource.id],
          },
        },
      }),
    ).resolves.toBe(2);
  });

  it("does not persist a source, skill, or link when generated draft validation fails", async () => {
    const userId = await createUser("source_invalid_generation");
    const result = await createSkillDraftFromSource({
      userId,
      now,
      model: "test-gemini",
      generateSkillDraft: async () => ({
        drafts: [
          {
            title: "Incomplete draft",
            objective: "too short",
            rules: [],
            examples: [],
            exerciseConstraints: "",
            tags: [],
          },
        ],
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
      skillId: result.skills[0].id,
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
      skillId: result.skills[0].id,
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

  it("queues choice refill work without creating exercises synchronously", async () => {
    const userId = await createUser("choice_refill_queue");
    const skill = await createActiveSkillFixture({
      userId,
      title: "Queued refill skill",
    });
    await createChoiceExerciseFixture({ userId, skillId: skill.id, id: 1 });
    await createChoiceExerciseFixture({ userId, skillId: skill.id, id: 2 });
    const fake = createFakeRefillSender();

    const queued = expectQueued(
      await queueChoiceExerciseRefillForSkill({
        userId,
        skillId: skill.id,
        now,
        sender: fake.sender,
        model: "test-gemini",
      }),
    );

    expect(queued.requestedCount).toBe(3);
    expect(fake.choiceEvents).toEqual([
      {
        userId,
        skillId: skill.id,
        generationJobId: queued.generationJobId,
        targetReadyCount: DEFAULT_READY_EXERCISE_TARGET,
        requestedAt: now.toISOString(),
      },
    ]);
    await expect(
      prisma.generationJob.findUniqueOrThrow({
        where: { id: queued.generationJobId },
        select: { status: true, startedAt: true, completedAt: true },
      }),
    ).resolves.toEqual({
      status: GenerationJobStatus.PENDING,
      startedAt: null,
      completedAt: null,
    });
    await expect(prisma.exercise.count({ where: { userId, skillId: skill.id } })).resolves.toBe(2);
  });

  it("runs queued choice refill jobs idempotently", async () => {
    const userId = await createUser("choice_refill_runner");
    const skill = await createActiveSkillFixture({
      userId,
      title: "Queued runner skill",
    });
    await createChoiceExerciseFixture({ userId, skillId: skill.id, id: 1 });
    await createChoiceExerciseFixture({ userId, skillId: skill.id, id: 2 });
    const fake = createFakeRefillSender();
    const queued = expectQueued(
      await queueChoiceExerciseRefillForSkill({
        userId,
        skillId: skill.id,
        now,
        sender: fake.sender,
        model: "test-gemini",
      }),
    );

    const firstRun = await runChoiceExerciseRefillJob({
      userId,
      skillId: skill.id,
      generationJobId: queued.generationJobId,
      targetReadyCount: queued.targetReadyCount,
      requestedAt: now.toISOString(),
      now,
      generateChoiceExercises: async () => ({
        exercises: [generatedExercise(401), generatedExercise(402), generatedExercise(403)],
      }),
      verifyChoiceExercises: acceptAllVerifier,
      model: "test-gemini",
    });

    expect(firstRun).toMatchObject({
      status: "refilled",
      exerciseCount: 3,
      readyExerciseCount: DEFAULT_READY_EXERCISE_TARGET,
    });

    const secondRun = await runChoiceExerciseRefillJob({
      userId,
      skillId: skill.id,
      generationJobId: queued.generationJobId,
      targetReadyCount: queued.targetReadyCount,
      requestedAt: now.toISOString(),
      now,
      generateChoiceExercises: async () => {
        throw new Error("Duplicate execution should not generate again.");
      },
      verifyChoiceExercises: acceptAllVerifier,
      model: "test-gemini",
    });

    expect(secondRun).toMatchObject({
      status: "not-refilled",
      reason: "job-not-pending",
    });
    await expect(
      Promise.all([
        prisma.exercise.count({ where: { userId, skillId: skill.id } }),
        prisma.generationJob.findUniqueOrThrow({
          where: { id: queued.generationJobId },
          select: { status: true, acceptedCount: true, rejectedCount: true },
        }),
      ]),
    ).resolves.toEqual([
      DEFAULT_READY_EXERCISE_TARGET,
      {
        status: GenerationJobStatus.SUCCEEDED,
        acceptedCount: 3,
        rejectedCount: 0,
      },
    ]);
  });

  it("does not queue duplicate or locked refill jobs", async () => {
    const userId = await createUser("refill_queue_guards");
    const skill = await createActiveSkillFixture({
      userId,
      title: "Duplicate queued refill skill",
    });
    await createChoiceExerciseFixture({ userId, skillId: skill.id, id: 1 });
    const fake = createFakeRefillSender();
    const queued = expectQueued(
      await queueChoiceExerciseRefillForSkill({
        userId,
        skillId: skill.id,
        now,
        sender: fake.sender,
        model: "test-gemini",
      }),
    );

    const duplicate = await queueChoiceExerciseRefillForSkill({
      userId,
      skillId: skill.id,
      now,
      sender: fake.sender,
      model: "test-gemini",
    });

    expect(duplicate).toMatchObject({
      status: "not-queued",
      reason: "job-in-progress",
      generationJobId: queued.generationJobId,
    });
    expect(fake.choiceEvents).toHaveLength(1);

    const lockedExactInput = await queueExactInputExerciseRefillForSkill({
      userId,
      skillId: skill.id,
      now,
      sender: fake.sender,
      model: "test-gemini",
    });

    expect(lockedExactInput).toMatchObject({
      status: "not-queued",
      reason: "exact-input-locked",
    });
    expect(fake.exactInputEvents).toHaveLength(0);
  });

  it("enforces one pending or running generation job per user skill and kind", async () => {
    const userId = await createUser("refill_queue_unique_index");
    const skill = await createActiveSkillFixture({
      userId,
      title: "Unique queued refill skill",
    });
    const jobDefaults = {
      userId,
      skillId: skill.id,
      provider: "google",
      model: "test-gemini",
      promptVersion: "skill-mcq-v0",
      requestedCount: 3,
    };

    await prisma.generationJob.create({
      data: {
        ...jobDefaults,
        kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
        status: GenerationJobStatus.PENDING,
      },
    });

    await expect(
      prisma.generationJob.create({
        data: {
          ...jobDefaults,
          kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
          status: GenerationJobStatus.RUNNING,
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });

    await expect(
      prisma.generationJob.create({
        data: {
          ...jobDefaults,
          kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
          status: GenerationJobStatus.FAILED,
          errorMessage: "older failed job",
        },
      }),
    ).resolves.toBeTruthy();

    await expect(
      prisma.generationJob.create({
        data: {
          ...jobDefaults,
          kind: GenerationJobKind.EXACT_INPUT_EXERCISE_GENERATION,
          status: GenerationJobStatus.PENDING,
          promptVersion: "skill-exact-input-v0",
        },
      }),
    ).resolves.toBeTruthy();
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

  it("queues and runs exact-input refill jobs for unlocked skills", async () => {
    const userId = await createUser("exact_refill_queue");
    const skill = await createActiveSkillFixture({
      userId,
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    const fake = createFakeRefillSender();

    const queued = expectQueued(
      await queueExactInputExerciseRefillForSkill({
        userId,
        skillId: skill.id,
        now,
        sender: fake.sender,
        model: "test-gemini",
      }),
    );

    expect(fake.exactInputEvents).toEqual([
      {
        userId,
        skillId: skill.id,
        generationJobId: queued.generationJobId,
        targetReadyCount: DEFAULT_READY_EXACT_INPUT_TARGET,
        requestedAt: now.toISOString(),
      },
    ]);
    await expect(prisma.exercise.count({ where: { userId, skillId: skill.id } })).resolves.toBe(0);

    const result = await runExactInputExerciseRefillJob({
      userId,
      skillId: skill.id,
      generationJobId: queued.generationJobId,
      targetReadyCount: queued.targetReadyCount,
      requestedAt: now.toISOString(),
      now,
      generateExactInputExercises: async () => ({
        exercises: [generatedExactInputExercise(701), generatedExactInputExercise(702)],
      }),
      verifyExactInputExercises: acceptAllExactInputVerifier,
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "refilled",
      exerciseCount: DEFAULT_READY_EXACT_INPUT_TARGET,
    });
    await expect(
      prisma.generationJob.findUniqueOrThrow({
        where: { id: queued.generationJobId },
        select: { status: true, acceptedCount: true, rejectedCount: true },
      }),
    ).resolves.toEqual({
      status: GenerationJobStatus.SUCCEEDED,
      acceptedCount: DEFAULT_READY_EXACT_INPUT_TARGET,
      rejectedCount: 0,
    });
  });

  it("queues and runs math refill jobs for unlocked skills", async () => {
    const userId = await createUser("math_refill_queue");
    const skill = await createActiveSkillFixture({
      userId,
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    const fake = createFakeRefillSender();

    const queued = expectQueued(
      await queueMathExerciseRefillForSkill({
        userId,
        skillId: skill.id,
        now,
        sender: fake.sender,
        model: "test-gemini",
      }),
    );

    expect(fake.mathEvents).toEqual([
      {
        userId,
        skillId: skill.id,
        generationJobId: queued.generationJobId,
        targetReadyCount: DEFAULT_READY_MATH_TARGET,
        requestedAt: now.toISOString(),
      },
    ]);
    await expect(prisma.exercise.count({ where: { userId, skillId: skill.id } })).resolves.toBe(0);

    const result = await runMathExerciseRefillJob({
      userId,
      skillId: skill.id,
      generationJobId: queued.generationJobId,
      targetReadyCount: queued.targetReadyCount,
      requestedAt: now.toISOString(),
      now,
      generateMathExercises: async () => ({
        exercises: [generatedMathExercise(701), generatedMathExercise(702)],
      }),
      verifyMathExercises: acceptAllMathVerifier,
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "refilled",
      exerciseCount: DEFAULT_READY_MATH_TARGET,
      readyExerciseCount: DEFAULT_READY_MATH_TARGET,
    });
    await expect(
      Promise.all([
        prisma.generationJob.findUniqueOrThrow({
          where: { id: queued.generationJobId },
          select: { status: true, acceptedCount: true, rejectedCount: true, kind: true },
        }),
        getNextPracticeItemForUser(userId, now),
      ]),
    ).resolves.toEqual([
      {
        status: GenerationJobStatus.SUCCEEDED,
        acceptedCount: DEFAULT_READY_MATH_TARGET,
        rejectedCount: 0,
        kind: GenerationJobKind.MATH_EXERCISE_GENERATION,
      },
      expect.objectContaining({
        status: "ready",
        exercise: expect.objectContaining({
          answerKind: AnswerKind.MATH,
        }),
      }),
    ]);
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

  it("does not refill math exercises before the review threshold", async () => {
    const userId = await createUser("math_refill_locked");
    const skill = await createActiveSkillFixture({
      userId,
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS - 1,
    });

    const result = await refillMathExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      generateMathExercises: async () => {
        throw new Error("Generator should not run before math input unlocks.");
      },
      verifyMathExercises: acceptAllMathVerifier,
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

  it("does not refill math exercises that are already at target", async () => {
    const userId = await createUser("math_refill_noop");
    const skill = await createActiveSkillFixture({
      userId,
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    await createMathExerciseFixture({ userId, skillId: skill.id, id: 1 });
    await createMathExerciseFixture({ userId, skillId: skill.id, id: 2 });

    const result = await refillMathExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      generateMathExercises: async () => {
        throw new Error("Generator should not run for a full math queue.");
      },
      verifyMathExercises: acceptAllMathVerifier,
      model: "test-gemini",
    });

    expect(result).toMatchObject({
      status: "not-refilled",
      reason: "already-at-target",
      readyExerciseCount: DEFAULT_READY_MATH_TARGET,
    });
    await expect(
      prisma.generationJob.count({ where: { userId, skillId: skill.id } }),
    ).resolves.toBe(0);
  });

  it("creates a failed math generation job without writing exercises when verification fails", async () => {
    const userId = await createUser("math_refill_verification_fail");
    const skill = await createActiveSkillFixture({
      userId,
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });

    const result = await refillMathExercisesForSkill({
      userId,
      skillId: skill.id,
      now,
      generateMathExercises: async () => ({
        exercises: [generatedMathExercise(1)],
      }),
      verifyMathExercises: async (input) => ({
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
      kind: GenerationJobKind.MATH_EXERCISE_GENERATION,
      acceptedCount: 0,
      rejectedCount: 1,
    });
  });

  it("rejects non-active, missing, and cross-user math refills without jobs", async () => {
    const userId = await createUser("math_refill_rejects");
    const otherUserId = await createUser("math_refill_rejects_other");
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
        refillMathExercisesForSkill({
          userId,
          skillId,
          now,
          generateMathExercises: async () => ({
            exercises: [generatedMathExercise(1)],
          }),
          verifyMathExercises: acceptAllMathVerifier,
          model: "test-gemini",
        }),
      ).resolves.toMatchObject({
        status: "not-refilled",
        reason: "skill-not-active",
      });
    }

    await expect(
      refillMathExercisesForSkill({
        userId,
        skillId: otherSkill.id,
        now,
        generateMathExercises: async () => ({
          exercises: [generatedMathExercise(1)],
        }),
        verifyMathExercises: acceptAllMathVerifier,
        model: "test-gemini",
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "skill-not-found",
    });

    await expect(
      refillMathExercisesForSkill({
        userId,
        skillId: "missing-skill",
        now,
        generateMathExercises: async () => ({
          exercises: [generatedMathExercise(1)],
        }),
        verifyMathExercises: acceptAllMathVerifier,
        model: "test-gemini",
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "skill-not-found",
    });

    await expect(
      prisma.generationJob.count({
        where: { userId, kind: GenerationJobKind.MATH_EXERCISE_GENERATION },
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
