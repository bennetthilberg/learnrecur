import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ExerciseRetirementReason,
  ExerciseVerificationStatus,
  GenerationAuditDecision,
  SourceFileKind,
  SourceFileStatus,
} from "@/generated/prisma/client";
import {
  getExerciseForAudit,
  listExercisesForAudit,
} from "@/lib/practice/exercise-audit";
import { getPrisma } from "@/lib/prisma";

import { createChoiceExercise, createSkillFixture } from "./test-helpers";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `exercise_audit_${randomUUID()}`;
const now = new Date("2026-06-07T14:00:00.000Z");

describeDatabase("exercise audit read model", () => {
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

  async function createAuditExercise({
    userId,
    skillId,
    label,
    createdAt,
    retired = false,
  }: {
    userId: string;
    skillId: string;
    label: string;
    createdAt: Date;
    retired?: boolean;
  }) {
    const exercise = await createChoiceExercise({
      prisma,
      userId,
      skillId,
      prompt: `Choose ${label}.`,
      correctChoiceId: "right",
      verificationStatus: ExerciseVerificationStatus.VERIFIED,
      retiredAt: retired ? new Date("2026-06-05T12:00:00.000Z") : null,
    });

    return prisma.exercise.update({
      where: { id: exercise.id },
      data: {
        prompt: `Choose ${label}.\n\nSelect the right answer.`,
        explanation: `The audited explanation for ${label}.`,
        generationMetadata: {
          promptLayout: {
            instruction: `Choose ${label}.`,
            content: "Select the right answer.",
          },
        },
        provenance: {
          kind: "SOURCE_DERIVED",
          sourceRevisionIds: ["revision_spanish_1"],
          sourceFileIds: ["source-file-placeholder"],
          evidenceAnchorIds: [`chunk_${label}`],
          contentHashes: ["A".repeat(64)],
          providerResponse: "must not be returned",
          storageKey: "private/should-not-return.pdf",
        },
        acceptanceDecision: GenerationAuditDecision.PUBLISHED,
        createdAt,
        ...(retired
          ? {
              retiredAt: new Date("2026-06-05T12:00:00.000Z"),
              retirementReason: ExerciseRetirementReason.MANUAL,
            }
          : {}),
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

  it("returns a full owned audit record, including retired exercises and sanitized provenance", async () => {
    const userId = await createUser("owned");
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Spanish past tense",
    });
    const sourceFile = await prisma.sourceFile.create({
      data: {
        userId,
        originalName: "Spanish grammar.pdf",
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.READY,
      },
    });
    await prisma.skillSourceRef.create({
      data: {
        userId,
        skillId: skill.id,
        sourceFileId: sourceFile.id,
        locator: {
          kind: "page",
          page: 12,
          sectionId: "preterite",
          storageKey: "private/should-not-return.pdf",
        },
        note: "Chapter 4",
      },
    });

    const active = await createAuditExercise({
      userId,
      skillId: skill.id,
      label: "the verb",
      createdAt: new Date("2026-06-01T10:00:00.000Z"),
    });
    const retired = await createAuditExercise({
      userId,
      skillId: skill.id,
      label: "the retired verb",
      createdAt: new Date("2026-06-01T11:00:00.000Z"),
      retired: true,
    });

    const activePage = await listExercisesForAudit({
      userId,
      skillId: skill.id,
      lifecycle: "active",
      now,
    });
    const allPage = await listExercisesForAudit({
      userId,
      skillId: skill.id,
      lifecycle: "all",
      now,
    });
    const retiredLookup = await getExerciseForAudit({
      userId,
      exerciseId: retired.id,
    });

    expect(activePage.exercises.map((exercise) => exercise.id)).toEqual([active.id]);
    expect(allPage.exercises.map((exercise) => exercise.id)).toEqual(
      [retired.id, active.id],
    );
    expect(retiredLookup).toMatchObject({
      status: "ready",
      exercise: {
        id: retired.id,
        lifecycle: "retired",
        retirement: {
          isRetired: true,
          reason: ExerciseRetirementReason.MANUAL,
        },
      },
    });

    const record = activePage.exercises[0];
    expect(record).toMatchObject({
      skillId: skill.id,
      skillTitle: "Spanish past tense",
      prompt: "Choose the verb.\n\nSelect the right answer.",
      instruction: "Choose the verb.",
      content: "Select the right answer.",
      answerSpec: {
        kind: "choice",
        correctChoiceId: "right",
      },
      answerContract: {
        comparisonPolicy: {
          comparison: "choice-id",
          correctChoiceId: "right",
        },
        acceptedVariants: [{ choiceId: "right", display: "Right" }],
      },
      acceptedValues: ["right"],
      correctAnswerDisplay: "right",
      explanation: "The audited explanation for the verb.",
      verificationSummary: {
        status: ExerciseVerificationStatus.VERIFIED,
        acceptanceDecision: GenerationAuditDecision.PUBLISHED,
      },
      sourceRefs: [
        {
          sourceFileId: sourceFile.id,
          label: "Spanish grammar.pdf",
          materialRevisionId: null,
          locator: {
            kind: "page",
            page: 12,
            sectionId: "preterite",
          },
          note: "Chapter 4",
        },
      ],
      provenance: {
        sourceBacked: true,
        kind: "SOURCE_DERIVED",
        sourceRevisionIds: ["revision_spanish_1"],
        sourceFileIds: [sourceFile.id, "source-file-placeholder"],
        evidenceAnchorIds: ["chunk_the verb"],
        contentHashes: ["a".repeat(64)],
      },
    });
    expect(JSON.stringify(record)).not.toContain("private/should-not-return.pdf");
    expect(JSON.stringify(record)).not.toContain("providerResponse");
  });

  it("keeps a created-at snapshot and id tie-breaker across audit pages", async () => {
    const userId = await createUser("pages");
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Spanish audit pagination",
    });
    const createdAt = new Date("2026-06-02T10:00:00.000Z");
    const exercises = await Promise.all(
      ["one", "two", "three"].map((label) =>
        createAuditExercise({ userId, skillId: skill.id, label, createdAt }),
      ),
    );

    const first = await listExercisesForAudit({
      userId,
      skillId: skill.id,
      lifecycle: "all",
      limit: 2,
      now,
    });
    expect(first.exercises).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    await createAuditExercise({
      userId,
      skillId: skill.id,
      label: "inserted after snapshot",
      createdAt: new Date("2026-06-07T15:00:00.000Z"),
    });

    const second = await listExercisesForAudit({
      userId,
      skillId: skill.id,
      lifecycle: "all",
      limit: 2,
      now: new Date("2026-06-07T16:00:00.000Z"),
      cursor: first.nextCursor ?? undefined,
    });
    const pagedIds = [...first.exercises, ...second.exercises].map((exercise) => exercise.id);

    expect(second.exercises).toHaveLength(1);
    expect(new Set(pagedIds).size).toBe(3);
    expect(pagedIds.toSorted()).toEqual(exercises.map((exercise) => exercise.id).toSorted());
    expect(second.nextCursor).toBeNull();
    expect(second.snapshotCutoff).toEqual(first.snapshotCutoff);
  });

  it("does not reveal another account's skill or exercise", async () => {
    const ownerId = await createUser("owner");
    const otherUserId = await createUser("other");
    const skill = await createSkillFixture(prisma, {
      userId: ownerId,
      title: "Private Spanish skill",
    });
    const exercise = await createAuditExercise({
      userId: ownerId,
      skillId: skill.id,
      label: "private",
      createdAt: new Date("2026-06-03T10:00:00.000Z"),
    });

    const list = await listExercisesForAudit({
      userId: otherUserId,
      skillId: skill.id,
      now,
    });
    const lookup = await getExerciseForAudit({
      userId: otherUserId,
      exerciseId: exercise.id,
    });

    expect(list.exercises).toEqual([]);
    expect(lookup).toEqual({
      status: "not-found",
      message: "Exercise not found.",
    });
  });
});
