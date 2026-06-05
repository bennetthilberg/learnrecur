import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ExerciseAttemptResult,
  ExerciseFlagReason,
  ExerciseRetirementReason,
  FsrsRating,
  GenerationJobKind,
  GenerationJobStatus,
  SkillFsrsState,
  SkillStatus,
  SourceFileKind,
  SourceFileStatus,
} from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  activateSkillDraft,
  refillChoiceExercisesForSkill,
  type ChoiceExerciseGenerator,
  type ChoiceExerciseVerifier,
} from "@/lib/skills";
import {
  getSkillSourceSummaries,
  removeSkillSource,
} from "@/lib/skills/sources";
import { getSkillsLibrary } from "@/lib/skills/library";

import {
  createSkillFixture,
  createTextExercise,
} from "./test-helpers";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `source_controls_${randomUUID()}`;
const now = new Date("2026-06-05T12:00:00.000Z");

const generatedExercise = (id: number) => ({
  prompt: `Which source-control item ${id} is correct?`,
  choices: [
    { id: "correct", label: `Correct ${id}` },
    { id: "wrong", label: `Wrong ${id}` },
    { id: "close", label: `Close ${id}` },
  ],
  correctChoiceId: "correct",
  explanation: `Item ${id} checks the skill.`,
  difficulty: 2,
  expectedSeconds: 30,
});

const acceptAllVerifier: ChoiceExerciseVerifier = async (input) => ({
  verifications: input.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    verdict: "verified",
  })),
});

describeDatabase("source material controls", () => {
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

  async function createSourceFile({
    userId,
    label = "Pasted notes",
    extractedText = "Use ser for identity.\n\nUse estar for location.",
  }: {
    userId: string;
    label?: string;
    extractedText?: string | null;
  }) {
    return prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.READY,
        originalName: label,
        mimeType: "text/plain",
        byteSize: extractedText ? Buffer.byteLength(extractedText, "utf8") : null,
        extractedText,
      },
    });
  }

  async function linkSource({
    userId,
    skillId,
    sourceFileId,
    note = "Focus on the contrast, not broad vocabulary.",
  }: {
    userId: string;
    skillId: string;
    sourceFileId: string;
    note?: string | null;
  }) {
    return prisma.skillSourceRef.create({
      data: {
        userId,
        skillId,
        sourceFileId,
        note,
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

  it("lists only user-owned source summaries with capped preview metadata", async () => {
    const userId = await createUser("summary_owner");
    const otherUserId = await createUser("summary_other");
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Source-backed summary skill",
      status: SkillStatus.DRAFT,
    });
    const otherSkill = await createSkillFixture(prisma, {
      userId: otherUserId,
      title: "Other source-backed skill",
      status: SkillStatus.DRAFT,
    });
    const sourceFile = await createSourceFile({
      userId,
      label: "Spanish notes",
      extractedText: "  Use ser for identity.\n\nUse estar for location.  ",
    });
    const emptySourceFile = await createSourceFile({
      userId,
      label: "Empty source shell",
      extractedText: null,
    });
    await linkSource({ userId, skillId: skill.id, sourceFileId: sourceFile.id });
    await linkSource({
      userId,
      skillId: skill.id,
      sourceFileId: emptySourceFile.id,
      note: null,
    });

    const result = await getSkillSourceSummaries({ userId, skillId: skill.id });

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.sources).toHaveLength(2);
      expect(result.sources[0]).toMatchObject({
        label: "Spanish notes",
        kind: SourceFileKind.TEXT,
        status: SourceFileStatus.READY,
        preview: "Use ser for identity. Use estar for location.",
      });
      expect(result.sources[1]).toMatchObject({
        label: "Empty source shell",
        preview: null,
      });
    }

    await expect(
      getSkillSourceSummaries({ userId, skillId: otherSkill.id }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "skill-not-found",
    });
  });

  it("removes an orphan source without deleting skill history or generated records", async () => {
    const userId = await createUser("orphan_remove");
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Source removal preserves history",
    });
    const sourceFile = await createSourceFile({ userId });
    const sourceRef = await linkSource({
      userId,
      skillId: skill.id,
      sourceFileId: sourceFile.id,
    });
    const exercise = await createTextExercise(prisma, userId, skill.id);
    const attempt = await prisma.exerciseAttempt.create({
      data: {
        userId,
        skillId: skill.id,
        exerciseId: exercise.id,
        answer: "right",
        normalizedAnswer: "right",
        isCorrect: true,
        result: ExerciseAttemptResult.CORRECT,
      },
    });
    await prisma.reviewLog.create({
      data: {
        userId,
        skillId: skill.id,
        exerciseAttemptId: attempt.id,
        finalRating: FsrsRating.GOOD,
        previousState: SkillFsrsState.NEW,
        nextState: SkillFsrsState.REVIEW,
        schedulerName: "ts-fsrs",
        schedulerVersion: "5.x",
        desiredRetention: 0.9,
        schedulerParameters: { source: "default" },
      },
    });
    await prisma.exerciseFlag.create({
      data: {
        userId,
        exerciseId: exercise.id,
        reason: ExerciseFlagReason.UNCLEAR_PROMPT,
        retiredExerciseAt: now,
        retirementReason: ExerciseRetirementReason.FLAGGED_UNCLEAR,
      },
    });
    await prisma.generationJob.create({
      data: {
        userId,
        skillId: skill.id,
        kind: GenerationJobKind.CHOICE_EXERCISE_GENERATION,
        status: GenerationJobStatus.SUCCEEDED,
        provider: "google",
        model: "test-gemini",
        promptVersion: "skill-mcq-v0",
        requestedCount: 1,
        acceptedCount: 1,
        rejectedCount: 0,
      },
    });

    await expect(
      removeSkillSource({ userId, skillId: skill.id, sourceRefId: sourceRef.id }),
    ).resolves.toMatchObject({
      status: "removed",
      sourceFileDeleted: true,
    });

    await expect(prisma.skillSourceRef.count({ where: { id: sourceRef.id } })).resolves.toBe(0);
    await expect(prisma.sourceFile.findUnique({ where: { id: sourceFile.id } })).resolves.toBeNull();
    await expect(prisma.skill.count({ where: { id: skill.id } })).resolves.toBe(1);
    await expect(prisma.exercise.count({ where: { id: exercise.id } })).resolves.toBe(1);
    await expect(prisma.exerciseAttempt.count({ where: { id: attempt.id } })).resolves.toBe(1);
    await expect(
      prisma.reviewLog.count({ where: { exerciseAttemptId: attempt.id } }),
    ).resolves.toBe(1);
    await expect(prisma.exerciseFlag.count({ where: { exerciseId: exercise.id } })).resolves.toBe(1);
    await expect(prisma.generationJob.count({ where: { skillId: skill.id } })).resolves.toBe(1);
  });

  it("removes only one link when a source file is shared by two skills", async () => {
    const userId = await createUser("shared_source");
    const firstSkill = await createSkillFixture(prisma, {
      userId,
      title: "First linked skill",
    });
    const secondSkill = await createSkillFixture(prisma, {
      userId,
      title: "Second linked skill",
    });
    const sourceFile = await createSourceFile({ userId, label: "Shared notes" });
    const firstRef = await linkSource({
      userId,
      skillId: firstSkill.id,
      sourceFileId: sourceFile.id,
    });
    const secondRef = await linkSource({
      userId,
      skillId: secondSkill.id,
      sourceFileId: sourceFile.id,
    });

    await removeSkillSource({ userId, skillId: firstSkill.id, sourceRefId: firstRef.id });

    await expect(prisma.sourceFile.count({ where: { id: sourceFile.id } })).resolves.toBe(1);
    await expect(prisma.skillSourceRef.count({ where: { id: firstRef.id } })).resolves.toBe(0);
    await expect(prisma.skillSourceRef.count({ where: { id: secondRef.id } })).resolves.toBe(1);

    const library = await getSkillsLibrary({ userId, now });
    expect(library.activeSkills.find((skill) => skill.id === firstSkill.id)).toMatchObject({
      sourceRefCount: 0,
    });
    expect(library.activeSkills.find((skill) => skill.id === secondSkill.id)).toMatchObject({
      sourceRefCount: 1,
    });
  });

  it("rejects cross-user source removal without changing rows", async () => {
    const userId = await createUser("cross_owner");
    const otherUserId = await createUser("cross_other");
    const otherSkill = await createSkillFixture(prisma, {
      userId: otherUserId,
      title: "Other user's source skill",
    });
    const otherSource = await createSourceFile({ userId: otherUserId });
    const otherRef = await linkSource({
      userId: otherUserId,
      skillId: otherSkill.id,
      sourceFileId: otherSource.id,
    });

    await expect(
      removeSkillSource({
        userId,
        skillId: otherSkill.id,
        sourceRefId: otherRef.id,
      }),
    ).resolves.toMatchObject({
      status: "not-found",
      reason: "source-not-found",
    });

    await expect(prisma.sourceFile.count({ where: { id: otherSource.id } })).resolves.toBe(1);
    await expect(prisma.skillSourceRef.count({ where: { id: otherRef.id } })).resolves.toBe(1);
  });

  it("excludes removed source context from activation and refill generation", async () => {
    const userId = await createUser("context_removed");
    const draftSkill = await createSkillFixture(prisma, {
      userId,
      title: "Draft without source context after removal",
      status: SkillStatus.DRAFT,
    });
    const draftSource = await createSourceFile({
      userId,
      label: "Activation notes",
      extractedText: "This source should not reach activation after removal.",
    });
    const draftRef = await linkSource({
      userId,
      skillId: draftSkill.id,
      sourceFileId: draftSource.id,
    });
    await removeSkillSource({ userId, skillId: draftSkill.id, sourceRefId: draftRef.id });

    let activationSourceContext: string | null | undefined = "unset";
    let activationVerifierSourceContext: string | null | undefined = "unset";
    const activationGenerator: ChoiceExerciseGenerator = async (input) => {
      activationSourceContext = input.sourceContext;
      return {
        exercises: [generatedExercise(1), generatedExercise(2), generatedExercise(3)],
      };
    };
    const activationVerifier: ChoiceExerciseVerifier = async (input) => {
      activationVerifierSourceContext = input.sourceContext;
      return acceptAllVerifier(input);
    };

    await expect(
      activateSkillDraft({
        userId,
        skillId: draftSkill.id,
        now,
        generateChoiceExercises: activationGenerator,
        verifyChoiceExercises: activationVerifier,
      }),
    ).resolves.toMatchObject({
      status: "activated",
    });
    expect(activationSourceContext).toBeNull();
    expect(activationVerifierSourceContext).toBeNull();

    const refillSkill = await createSkillFixture(prisma, {
      userId,
      title: "Refill without source context after removal",
    });
    const refillSource = await createSourceFile({
      userId,
      label: "Refill notes",
      extractedText: "This source should not reach refill after removal.",
    });
    const refillRef = await linkSource({
      userId,
      skillId: refillSkill.id,
      sourceFileId: refillSource.id,
    });
    await removeSkillSource({ userId, skillId: refillSkill.id, sourceRefId: refillRef.id });

    let refillSourceContext: string | null | undefined = "unset";
    let refillVerifierSourceContext: string | null | undefined = "unset";
    const refillGenerator: ChoiceExerciseGenerator = async (input) => {
      refillSourceContext = input.sourceContext;
      return {
        exercises: [generatedExercise(4)],
      };
    };
    const refillVerifier: ChoiceExerciseVerifier = async (input) => {
      refillVerifierSourceContext = input.sourceContext;
      return acceptAllVerifier(input);
    };

    await expect(
      refillChoiceExercisesForSkill({
        userId,
        skillId: refillSkill.id,
        now,
        targetReadyCount: 1,
        generateChoiceExercises: refillGenerator,
        verifyChoiceExercises: refillVerifier,
      }),
    ).resolves.toMatchObject({
      status: "refilled",
      exerciseCount: 1,
    });
    expect(refillSourceContext).toBeNull();
    expect(refillVerifierSourceContext).toBeNull();
  });
});
