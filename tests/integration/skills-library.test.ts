import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AnswerKind,
  CollectionStatus,
  ExerciseRetirementReason,
  ExerciseType,
  ExerciseVerificationStatus,
  GenerationJobKind,
  GenerationJobStatus,
  type Prisma,
  SkillStatus,
  SourceFileKind,
  SourceFileStatus,
} from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import { createInitialSkillSchedule } from "@/lib/scheduling";
import { EXACT_INPUT_UNLOCK_REPETITIONS } from "@/lib/skills";
import { getSkillsLibrary } from "@/lib/skills/library";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `skills_library_${randomUUID()}`;
const now = new Date("2026-06-04T12:00:00.000Z");

describeDatabase("skills library read model", () => {
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

  async function createCollection(userId: string, name: string) {
    return prisma.collection.create({
      data: {
        userId,
        name,
        status: CollectionStatus.ACTIVE,
      },
    });
  }

  async function createSkillFixture({
    userId,
    title,
    collectionId,
    status,
    dueAt = new Date("2026-06-03T09:00:00.000Z"),
    initialized = true,
    repetitions = 0,
    tags = [],
  }: {
    userId: string;
    title: string;
    collectionId?: string | null;
    status: SkillStatus;
    dueAt?: Date;
    initialized?: boolean;
    repetitions?: number;
    tags?: string[];
  }) {
    const schedule =
      status === SkillStatus.ACTIVE && initialized ? createInitialSkillSchedule(dueAt) : {};

    return prisma.skill.create({
      data: {
        userId,
        collectionId,
        title,
        objective: `${title} objective for a compact practice target.`,
        status,
        tags,
        ...schedule,
        repetitions,
      },
    });
  }

  async function createChoiceExercise({
    userId,
    skillId,
    verificationStatus = ExerciseVerificationStatus.VERIFIED,
    retiredAt = null,
    choices = [
      { id: "right", label: "Right" },
      { id: "wrong", label: "Wrong" },
    ],
  }: {
    userId: string;
    skillId: string;
    verificationStatus?: ExerciseVerificationStatus;
    retiredAt?: Date | null;
    choices?: Array<{ id: string; label?: string }>;
  }) {
    return prisma.exercise.create({
      data: {
        userId,
        skillId,
        type: ExerciseType.MULTIPLE_CHOICE,
        answerKind: AnswerKind.CHOICE,
        prompt: "Choose the right answer.",
        choices,
        answerSpec: {
          kind: "choice",
          correctChoiceId: "right",
        },
        correctAnswerDisplay: "Right",
        verificationStatus,
        retiredAt,
        retirementReason: retiredAt ? ExerciseRetirementReason.MANUAL : null,
      },
    });
  }

  async function createTextExercise(
    userId: string,
    skillId: string,
    {
      answerSpec = {
        kind: "text",
        accepted: ["right"],
      },
      verificationStatus = ExerciseVerificationStatus.VERIFIED,
      retiredAt = null,
    }: {
      answerSpec?: Prisma.InputJsonValue;
      verificationStatus?: ExerciseVerificationStatus;
      retiredAt?: Date | null;
    } = {},
  ) {
    return prisma.exercise.create({
      data: {
        userId,
        skillId,
        type: ExerciseType.EXACT_INPUT,
        answerKind: AnswerKind.TEXT,
        prompt: "Type the right answer.",
        answerSpec,
        correctAnswerDisplay: "right",
        verificationStatus,
        retiredAt,
        retirementReason: retiredAt ? ExerciseRetirementReason.MANUAL : null,
      },
    });
  }

  async function createNumericExercise(userId: string, skillId: string) {
    return prisma.exercise.create({
      data: {
        userId,
        skillId,
        type: ExerciseType.EXACT_INPUT,
        answerKind: AnswerKind.NUMERIC,
        prompt: "Enter one half.",
        answerSpec: {
          kind: "numeric",
          accepted: ["1/2", 0.5],
          tolerance: 0,
        },
        correctAnswerDisplay: "0.5",
        verificationStatus: ExerciseVerificationStatus.VERIFIED,
      },
    });
  }

  async function linkTextSource(userId: string, skillId: string, collectionId: string | null) {
    const sourceFile = await prisma.sourceFile.create({
      data: {
        userId,
        collectionId,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.READY,
        originalName: "Pasted notes",
        mimeType: "text/plain",
        byteSize: 128,
        extractedText: "A small source excerpt for a generated skill draft.",
      },
    });

    return prisma.skillSourceRef.create({
      data: {
        userId,
        skillId,
        sourceFileId: sourceFile.id,
      },
    });
  }

  async function createGenerationJob({
    userId,
    skillId,
    status,
    errorMessage = null,
    createdAt,
  }: {
    userId: string;
    skillId: string;
    status: GenerationJobStatus;
    errorMessage?: string | null;
    createdAt: Date;
  }) {
    return prisma.generationJob.create({
      data: {
        userId,
        skillId,
        kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
        status,
        provider: "google",
        model: "test-gemini",
        promptVersion: "skill-mcq-v0",
        requestedCount: 5,
        acceptedCount: status === GenerationJobStatus.SUCCEEDED ? 3 : 1,
        rejectedCount: status === GenerationJobStatus.SUCCEEDED ? 2 : 4,
        errorMessage,
        startedAt: createdAt,
        completedAt: createdAt,
        createdAt,
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

  it("groups user-owned draft and active skills with recovery and practice counts", async () => {
    const userId = await createUser("owner");
    const otherUserId = await createUser("other");
    const grammar = await createCollection(userId, "Spanish grammar");
    const otherCollection = await createCollection(otherUserId, "Other grammar");

    const draftSkill = await createSkillFixture({
      userId,
      collectionId: grammar.id,
      title: "Ser vs. estar draft",
      status: SkillStatus.DRAFT,
      tags: ["spanish", "grammar"],
    });
    await linkTextSource(userId, draftSkill.id, grammar.id);
    await createGenerationJob({
      userId,
      skillId: draftSkill.id,
      status: GenerationJobStatus.SUCCEEDED,
      createdAt: new Date("2026-06-04T09:00:00.000Z"),
    });
    await createGenerationJob({
      userId,
      skillId: draftSkill.id,
      status: GenerationJobStatus.FAILED,
      errorMessage: "Gemini verified 1 exercises; at least 3 are required.",
      createdAt: new Date("2026-06-04T10:00:00.000Z"),
    });

    const readySkill = await createSkillFixture({
      userId,
      collectionId: grammar.id,
      title: "Preterite endings",
      status: SkillStatus.ACTIVE,
      dueAt: new Date("2026-06-03T09:00:00.000Z"),
      tags: ["verbs"],
    });
    await createChoiceExercise({ userId, skillId: readySkill.id });
    await createChoiceExercise({
      userId,
      skillId: readySkill.id,
      retiredAt: new Date("2026-06-04T08:00:00.000Z"),
    });
    await createTextExercise(userId, readySkill.id);

    const futureSkill = await createSkillFixture({
      userId,
      collectionId: grammar.id,
      title: "Future tense",
      status: SkillStatus.ACTIVE,
      dueAt: new Date("2026-06-05T09:00:00.000Z"),
    });
    await createChoiceExercise({ userId, skillId: futureSkill.id });

    const malformedChoiceSkill = await createSkillFixture({
      userId,
      collectionId: grammar.id,
      title: "Malformed choices",
      status: SkillStatus.ACTIVE,
      dueAt: new Date("2026-06-03T09:30:00.000Z"),
    });
    await createChoiceExercise({
      userId,
      skillId: malformedChoiceSkill.id,
      choices: [{ id: "right" }],
    });

    const archivedSkill = await createSkillFixture({
      userId,
      collectionId: grammar.id,
      title: "Archived skill",
      status: SkillStatus.ARCHIVED,
    });
    await createChoiceExercise({ userId, skillId: archivedSkill.id });

    const otherSkill = await createSkillFixture({
      userId: otherUserId,
      collectionId: otherCollection.id,
      title: "Other user skill",
      status: SkillStatus.ACTIVE,
    });
    await createChoiceExercise({ userId: otherUserId, skillId: otherSkill.id });

    const library = await getSkillsLibrary({ userId, now });

    expect(library.draftSkills).toHaveLength(1);
    expect(library.activeSkills).toHaveLength(3);

    expect(library.draftSkills[0]).toMatchObject({
      id: draftSkill.id,
      title: "Ser vs. estar draft",
      collectionName: "Spanish grammar",
      tags: ["spanish", "grammar"],
      sourceRefCount: 1,
      latestGenerationJob: {
        status: GenerationJobStatus.FAILED,
        errorMessage: "Gemini verified 1 exercises; at least 3 are required.",
        acceptedCount: 1,
        rejectedCount: 4,
      },
    });

    const readySummary = library.activeSkills.find((skill) => skill.id === readySkill.id);
    expect(readySummary).toMatchObject({
      title: "Preterite endings",
      collectionName: "Spanish grammar",
      isReadyNow: true,
      dueLabel: "Due now",
      verifiedExerciseCount: 3,
      retiredExerciseCount: 1,
      readyExerciseCount: 1,
      sourceRefCount: 0,
    });

    const futureSummary = library.activeSkills.find((skill) => skill.id === futureSkill.id);
    expect(futureSummary).toMatchObject({
      isReadyNow: false,
      dueLabel: "Tomorrow",
      verifiedExerciseCount: 1,
      retiredExerciseCount: 0,
      readyExerciseCount: 1,
    });

    const malformedSummary = library.activeSkills.find(
      (skill) => skill.id === malformedChoiceSkill.id,
    );
    expect(malformedSummary).toMatchObject({
      isReadyNow: false,
      dueLabel: "Not available in practice yet",
      verifiedExerciseCount: 1,
      retiredExerciseCount: 0,
      readyExerciseCount: 0,
    });

    expect(library.activeSkills.map((skill) => skill.id)).not.toContain(otherSkill.id);
    expect(library.draftSkills.map((skill) => skill.id)).not.toContain(archivedSkill.id);
  });

  it("counts exact-input active skills with the current practice eligibility rules", async () => {
    const userId = await createUser("exact_active_rows");
    const collection = await createCollection(userId, "Exact library");

    const readyExactSkill = await createSkillFixture({
      userId,
      collectionId: collection.id,
      title: "Unlocked exact skill",
      status: SkillStatus.ACTIVE,
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    await createTextExercise(userId, readyExactSkill.id);
    await createNumericExercise(userId, readyExactSkill.id);

    const lockedExactSkill = await createSkillFixture({
      userId,
      collectionId: collection.id,
      title: "Locked exact skill",
      status: SkillStatus.ACTIVE,
      dueAt: new Date("2026-06-03T09:15:00.000Z"),
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS - 1,
    });
    await createTextExercise(userId, lockedExactSkill.id);

    const malformedExactSkill = await createSkillFixture({
      userId,
      collectionId: collection.id,
      title: "Malformed exact skill",
      status: SkillStatus.ACTIVE,
      dueAt: new Date("2026-06-03T09:30:00.000Z"),
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    await createTextExercise(userId, malformedExactSkill.id, {
      answerSpec: {
        kind: "numeric",
        accepted: ["1/2"],
        tolerance: 0,
      },
    });

    const retiredExactSkill = await createSkillFixture({
      userId,
      collectionId: collection.id,
      title: "Retired exact skill",
      status: SkillStatus.ACTIVE,
      dueAt: new Date("2026-06-03T09:45:00.000Z"),
      repetitions: EXACT_INPUT_UNLOCK_REPETITIONS,
    });
    await createTextExercise(userId, retiredExactSkill.id, {
      retiredAt: new Date("2026-06-04T08:00:00.000Z"),
    });

    const library = await getSkillsLibrary({ userId, now });

    expect(library.activeSkills.find((skill) => skill.id === readyExactSkill.id)).toMatchObject({
      isReadyNow: true,
      dueLabel: "Due now",
      verifiedExerciseCount: 2,
      retiredExerciseCount: 0,
      readyExerciseCount: 2,
    });
    expect(library.activeSkills.find((skill) => skill.id === lockedExactSkill.id)).toMatchObject({
      isReadyNow: false,
      dueLabel: "Not available in practice yet",
      verifiedExerciseCount: 1,
      retiredExerciseCount: 0,
      readyExerciseCount: 0,
    });
    expect(
      library.activeSkills.find((skill) => skill.id === malformedExactSkill.id),
    ).toMatchObject({
      isReadyNow: false,
      dueLabel: "Not available in practice yet",
      verifiedExerciseCount: 1,
      retiredExerciseCount: 0,
      readyExerciseCount: 0,
    });
    expect(library.activeSkills.find((skill) => skill.id === retiredExactSkill.id)).toMatchObject({
      isReadyNow: false,
      dueLabel: "Not available in practice yet",
      verifiedExerciseCount: 1,
      retiredExerciseCount: 1,
      readyExerciseCount: 0,
    });
  });

  it("sorts drafts by update time and active skills by due date", async () => {
    const userId = await createUser("sorting");

    const olderDraft = await createSkillFixture({
      userId,
      title: "Older draft",
      status: SkillStatus.DRAFT,
    });
    const newerDraft = await createSkillFixture({
      userId,
      title: "Newer draft",
      status: SkillStatus.DRAFT,
    });
    await prisma.skill.update({
      where: { id: newerDraft.id },
      data: { objective: "Newer draft objective updated after creation." },
    });

    const secondDue = await createSkillFixture({
      userId,
      title: "Second due",
      status: SkillStatus.ACTIVE,
      dueAt: new Date("2026-06-03T10:00:00.000Z"),
    });
    await createChoiceExercise({ userId, skillId: secondDue.id });

    const firstDue = await createSkillFixture({
      userId,
      title: "First due",
      status: SkillStatus.ACTIVE,
      dueAt: new Date("2026-06-03T09:00:00.000Z"),
    });
    await createChoiceExercise({ userId, skillId: firstDue.id });

    const library = await getSkillsLibrary({ userId, now });

    expect(library.draftSkills.map((skill) => skill.id)).toEqual([
      newerDraft.id,
      olderDraft.id,
    ]);
    expect(library.activeSkills.map((skill) => skill.id)).toEqual([
      firstDue.id,
      secondDue.id,
    ]);
  });
});
