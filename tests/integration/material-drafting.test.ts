import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  GenerationJobKind,
  GenerationJobStatus,
  MaterialPageTextStatus,
  SkillDraftBatchItemStatus,
  SkillDraftBatchStatus,
  SkillStatus,
  SourceFileKind,
  SourceFileStatus,
  StudyMaterialKind,
} from "@/generated/prisma/client";
import type { MaterialDraftAiSetup } from "@/lib/materials/ai";
import {
  MaterialBatchActivationError,
  confirmMaterialPlan,
  excludeMaterialDraftItem,
  getMaterialDraftBatch,
  MaterialDraftGenerationError,
  planMaterialSkills,
  queueMaterialBatchActivation,
  retryMaterialBatchActivationItem,
  retryMaterialDraftItem,
  runMaterialBatchActivationJob,
  runMaterialDraftItemJob,
} from "@/lib/materials/batches";
import {
  createMaterialWithInitialRevision,
  finalizeMaterialRevision,
  requestMaterialDeletion,
} from "@/lib/materials/lifecycle";
import { searchMaterialChunksLexical } from "@/lib/materials/retrieval";
import { getPrisma } from "@/lib/prisma";
import { activateSkillDraft, refillChoiceExercisesForSkill } from "@/lib/skills";
import { deleteSkillPermanently } from "@/lib/skills/delete";
import { ALPHA_ACTIVE_SKILLS } from "@/lib/usage-limits";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `material_drafting_${randomUUID()}`;

describeDatabase("material multi-skill drafting", () => {
  const prisma = getPrisma();
  const userId = `${runId}_owner`;
  const otherUserId = `${runId}_other`;
  let materialId = "";
  let materialRevisionId = "";
  let sourceFileId = "";
  let directSectionId = "";
  let indirectSectionId = "";
  let directChunkId = "";
  let indirectChunkId = "";

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: userId, email: `${userId}@example.com` },
        { id: otherUserId, email: `${otherUserId}@example.com` },
      ],
    });
    const { material, revision } = await createMaterialWithInitialRevision({
      userId,
      title: "Spanish Grammar Atlas",
      kind: StudyMaterialKind.PDF,
    });
    materialId = material.id;
    materialRevisionId = revision.id;
    const chapter = await prisma.materialSection.create({
      data: {
        userId,
        materialRevisionId,
        ordinal: 0,
        level: 1,
        title: "Chapter 4 · Object pronouns",
        normalizedTitle: "chapter 4 object pronouns",
        pageStart: 90,
        pageEnd: 128,
        headingPath: ["Chapter 4"],
      },
    });
    const direct = await prisma.materialSection.create({
      data: {
        id: `${runId}_section_a_direct`,
        userId,
        materialRevisionId,
        parentId: chapter.id,
        ordinal: 1,
        level: 2,
        title: "4.1 Direct object pronouns",
        normalizedTitle: "4 1 direct object pronouns",
        pageStart: 94,
        pageEnd: 105,
        headingPath: ["Chapter 4", "Direct object pronouns"],
      },
    });
    const indirect = await prisma.materialSection.create({
      data: {
        id: `${runId}_section_z_indirect`,
        userId,
        materialRevisionId,
        parentId: chapter.id,
        ordinal: 2,
        level: 2,
        title: "4.2 Indirect object pronouns",
        normalizedTitle: "4 2 indirect object pronouns",
        pageStart: 106,
        pageEnd: 116,
        headingPath: ["Chapter 4", "Indirect object pronouns"],
      },
    });
    directSectionId = direct.id;
    indirectSectionId = indirect.id;
    const chunks = await Promise.all([
      prisma.materialChunk.create({
        data: {
          userId,
          materialRevisionId,
          materialSectionId: direct.id,
          ordinal: 0,
          text: "Direct object pronouns replace nouns receiving the action and precede a conjugated verb.",
          tokenEstimate: 15,
          contentHash: `sha256:${runId}:direct`,
          headingText: direct.title,
          locator: { kind: "pdf", pageRange: { start: 94, end: 105 } },
        },
      }),
      prisma.materialChunk.create({
        data: {
          userId,
          materialRevisionId,
          materialSectionId: indirect.id,
          ordinal: 80,
          text: "Indirect object pronouns identify the recipient and distinguish singular le from plural les.",
          tokenEstimate: 15,
          contentHash: `sha256:${runId}:indirect`,
          headingText: indirect.title,
          locator: { kind: "pdf", pageRange: { start: 106, end: 116 } },
        },
      }),
    ]);
    directChunkId = chunks[0].id;
    indirectChunkId = chunks[1].id;
    await prisma.materialChunk.createMany({
      data: Array.from({ length: 79 }, (_, index) => ({
        userId,
        materialRevisionId,
        materialSectionId: direct.id,
        ordinal: index + 1,
        text: `Direct object pronoun filler excerpt ${index + 1}.`,
        tokenEstimate: 8,
        contentHash: `sha256:${runId}:direct-filler-${index + 1}`,
        headingText: direct.title,
        locator: { kind: "pdf", pageRange: { start: 94, end: 105 } },
      })),
    });
    const sourceFile = await prisma.sourceFile.create({
      data: {
        userId,
        materialRevisionId,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.READY,
        originalName: "spanish-grammar-atlas.pdf",
        mimeType: "application/pdf",
        storageBucket: "test-materials",
        storageKey: `${runId}/spanish.pdf`,
        extractedText:
          "UNRELATED CHAPTER SIX SOURCE TEXT. This whole-book excerpt must not ground chapter four exercises.",
      },
    });
    sourceFileId = sourceFile.id;
    await finalizeMaterialRevision({
      userId,
      materialId,
      materialRevisionId,
      contentHash: `sha256:${runId}`,
      byteSize: 8_192,
      pageCount: 220,
      storageBucket: "test-materials",
      storageKey: `${runId}/spanish.pdf`,
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  it("plans idempotently, warns on an exact linked duplicate, and confirms only new items", async () => {
    const existing = await prisma.skill.create({
      data: {
        userId,
        title: "Direct object pronouns",
        objective: "Replace direct objects with the correct Spanish pronoun in short sentences.",
        tags: ["spanish"],
        status: SkillStatus.DRAFT,
      },
    });
    await prisma.skillSourceRef.create({
      data: { userId, skillId: existing.id, sourceFileId },
    });
    const planScope = vi.fn(async () => ({
      resolutionStatus: "resolved",
      resolvedScopeLabel: "Chapter 4, pages 90–128",
      clarification: null,
      warnings: [],
      items: [
        {
          key: "direct-object-pronouns",
          title: "Direct object pronouns",
          objective: "Replace direct objects with the correct Spanish pronoun in short sentences.",
          materialSectionIds: [directSectionId],
          evidenceChunkIds: [directChunkId],
        },
        {
          key: "indirect-object-pronouns",
          title: "Indirect object pronouns",
          objective: "Choose the correct indirect object pronoun for a recipient in a short sentence.",
          materialSectionIds: [indirectSectionId],
          evidenceChunkIds: [indirectChunkId],
        },
      ],
    }));
    const aiSetup = createAiSetup({ planScope });
    const request = {
      materialId,
      materialRevisionId,
      instruction: "Make two skills from chapter four.",
      idempotencyKey: `${runId}_duplicate_plan`,
    };
    const first = await planMaterialSkills({
      userId,
      input: request,
      now: new Date(),
      aiSetup,
      embeddingGenerator: null,
    });
    const retry = await planMaterialSkills({
      userId,
      input: request,
      now: new Date(),
      aiSetup,
      embeddingGenerator: null,
    });
    expect(first.status).toBe("planned");
    expect(retry).toEqual(first);
    expect(planScope).toHaveBeenCalledTimes(1);
    if (first.status !== "planned") {
      throw new Error("expected planned batch");
    }
    expect(first.plan.items[0]).toMatchObject({ overlapSkillId: existing.id });
    expect(
      await planMaterialSkills({
        userId: otherUserId,
        input: { ...request, idempotencyKey: `${runId}_foreign_plan` },
        now: new Date(),
        aiSetup,
        embeddingGenerator: null,
      }),
    ).toMatchObject({ status: "not-found" });

    const events: string[] = [];
    expect(
      await confirmMaterialPlan({
        userId,
        input: {
          batchId: first.batchId,
          plan: {
            ...first.plan,
            items: first.plan.items.map((item, index) =>
              index === 0 ? { ...item, title: "Tampered title" } : item,
            ),
          },
        },
        now: new Date(),
        eventSender: { async sendMaterialDraftItemRequested() {} },
      }),
    ).toMatchObject({ status: "invalid" });
    const confirmed = await confirmMaterialPlan({
      userId,
      input: { batchId: first.batchId, plan: first.plan },
      now: new Date(),
      eventSender: {
        async sendMaterialDraftItemRequested(payload) {
          events.push(payload.itemId);
        },
      },
    });
    expect(confirmed).toMatchObject({ status: "queued" });
    const batch = await getMaterialDraftBatch({ userId, batchId: first.batchId });
    expect(batch?.items.map((item) => item.status)).toEqual([
      SkillDraftBatchItemStatus.EXCLUDED,
      SkillDraftBatchItemStatus.PLANNED,
    ]);
    expect(events).toEqual([batch?.items[1].id]);

    const repeatedEvents: string[] = [];
    const repeated = await confirmMaterialPlan({
      userId,
      input: { batchId: first.batchId, plan: first.plan },
      now: new Date(),
      eventSender: {
        async sendMaterialDraftItemRequested(payload) {
          repeatedEvents.push(payload.itemId);
        },
      },
    });
    expect(repeated).toMatchObject({
      status: "queued",
      alreadyConfirmed: true,
      queuedItemIds: [batch?.items[1].id],
    });
    expect(repeatedEvents).toEqual([batch?.items[1].id]);

    await expect(
      prisma.skillDraftBatchItem.update({
        where: { id: batch?.items[1].id },
        data: {
          skillId: (
            await prisma.skill.create({
              data: { userId: otherUserId, title: "Foreign skill", tags: [] },
            })
          ).id,
        },
      }),
    ).rejects.toThrow();
  });

  it("preflights a narrow proposal against the original request before confirmation", async () => {
    const planScope = vi
      .fn()
      .mockResolvedValueOnce({ resolutionStatus: "resolved" })
      .mockResolvedValueOnce({
        resolutionStatus: "resolved",
        resolvedScopeLabel: "Chapter 4 object pronouns",
        clarification: null,
        warnings: [],
        items: [
          {
            key: "direct-pronouns",
            title: "Direct object pronouns",
            objective: "Choose a direct object pronoun for one noun in a Spanish sentence.",
            materialSectionIds: [directSectionId],
            evidenceChunkIds: [directChunkId],
          },
        ],
      });
    const reviewScope = vi.fn(async () => ({
      resolutionStatus: "resolved",
      resolvedScopeLabel: "Chapter 4 direct and indirect object pronouns",
      clarification: null,
      warnings: [],
      items: [
        {
          key: "direct-pronouns",
          title: "Direct object pronouns",
          objective: "Choose a direct object pronoun for one noun in a Spanish sentence.",
          includeConcepts: ["direct object pronoun selection"],
          excludeConcepts: ["indirect object pronouns"],
          materialSectionIds: [directSectionId],
          evidenceChunkIds: [directChunkId],
        },
        {
          key: "indirect-pronouns",
          title: "Indirect object pronouns",
          objective: "Choose an indirect object pronoun for a recipient in a Spanish sentence.",
          includeConcepts: ["indirect object pronoun selection"],
          excludeConcepts: ["direct object pronouns"],
          materialSectionIds: [indirectSectionId],
          evidenceChunkIds: [indirectChunkId],
        },
      ],
    }));
    const result = await planMaterialSkills({
      userId,
      input: {
        materialId,
        materialRevisionId,
        instruction: "Make skills for the object pronouns in chapter four.",
        idempotencyKey: `${runId}_scope_preflight`,
      },
      now: new Date(),
      aiSetup: createAiSetup({ planScope, reviewScope }),
      embeddingGenerator: null,
    });

    expect(result).toMatchObject({
      status: "planned",
      plan: {
        items: [
          { key: "direct-pronouns", excludeConcepts: ["indirect object pronouns"] },
          { key: "indirect-pronouns", excludeConcepts: ["direct object pronouns"] },
        ],
      },
    });
    expect(reviewScope).toHaveBeenCalledWith(
      expect.objectContaining({
        instruction: "Make skills for the object pronouns in chapter four.",
        candidatePlan: expect.objectContaining({ items: [expect.any(Object)] }),
      }),
    );
    expect(planScope).toHaveBeenCalledTimes(2);
  });

  it("requires clarification without calling the semantic planner when a chapter is absent", async () => {
    const planScope = vi.fn(async () => {
      throw new Error("semantic planner should not run");
    });
    const result = await planMaterialSkills({
      userId,
      input: {
        materialId,
        materialRevisionId,
        instruction: "Make the first concept in chapter nine.",
        idempotencyKey: `${runId}_missing_chapter`,
      },
      now: new Date(),
      aiSetup: createAiSetup({ planScope }),
      embeddingGenerator: null,
    });

    expect(result).toMatchObject({
      status: "needs-scope",
      plan: {
        resolutionStatus: "ambiguous",
        items: [],
        clarification: expect.stringMatching(/chapter nine/i),
      },
    });
    expect(planScope).not.toHaveBeenCalled();
    if (result.status !== "needs-scope") {
      throw new Error("expected ambiguous scope");
    }
    expect(
      await prisma.skillDraftBatch.findUnique({
        where: { id: result.batchId },
        select: { status: true, proposedPlan: true, confirmedAt: true },
      }),
    ).toMatchObject({
      status: SkillDraftBatchStatus.NEEDS_SCOPE,
      proposedPlan: expect.any(Object),
      confirmedAt: null,
    });
  });

  it("records structured diagnostics when draft events cannot be queued", async () => {
    const planScope = vi.fn(async () => ({
      resolutionStatus: "resolved" as const,
      resolvedScopeLabel: "Chapter 4",
      clarification: null,
      warnings: [],
      items: [
        {
          key: "queue-diagnostic",
          title: "Queue diagnostic skill",
          objective: "Choose a direct object pronoun in one focused sentence.",
          materialSectionIds: [directSectionId],
          evidenceChunkIds: [directChunkId],
        },
      ],
    }));
    const planned = await planMaterialSkills({
      userId,
      input: {
        materialId,
        materialRevisionId,
        instruction: "Make one diagnostic skill from chapter four.",
        idempotencyKey: `${runId}_queue_diagnostic`,
      },
      now: new Date(),
      aiSetup: createAiSetup({ planScope }),
      embeddingGenerator: null,
    });
    if (planned.status !== "planned") {
      throw new Error("expected planned batch");
    }
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await confirmMaterialPlan({
      userId,
      input: { batchId: planned.batchId, plan: planned.plan },
      now: new Date(),
      eventSender: {
        async sendMaterialDraftItemRequested() {
          throw new Error("connect ECONNREFUSED 127.0.0.1:8288");
        },
      },
    });

    expect(result).toMatchObject({ status: "partial", failedItemIds: [expect.any(String)] });
    expect(errorSpy).toHaveBeenCalledWith(
      "[inngest] material draft event send failed",
      expect.objectContaining({
        batchId: planned.batchId,
        itemId: result.failedItemIds[0],
        error: expect.objectContaining({
          message: "connect ECONNREFUSED 127.0.0.1:8288",
        }),
      }),
    );
    errorSpy.mockRestore();
  });

  it("stores and returns a public message when Gemini scope planning fails", async () => {
    const providerError = JSON.stringify({
      error: {
        code: 400,
        message: "Request contains an invalid argument.",
        status: "INVALID_ARGUMENT",
      },
    });
    const result = await planMaterialSkills({
      userId,
      input: {
        materialId,
        materialRevisionId,
        instruction: "Make one skill from chapter four.",
        idempotencyKey: `${runId}_provider_failure`,
      },
      now: new Date(),
      aiSetup: createAiSetup({
        planScope: vi.fn(async () => {
          throw new Error(providerError);
        }),
      }),
      embeddingGenerator: null,
    });

    expect(result).toMatchObject({
      status: "failed",
      message: "LearnRecur could not review that scope. Check the request and try again.",
    });
    expect(JSON.stringify(result)).not.toContain("INVALID_ARGUMENT");
    if (!("batchId" in result)) {
      throw new Error("expected failed batch id");
    }
    expect(
      await prisma.skillDraftBatch.findUnique({
        where: { id: result.batchId },
        select: { errorCode: true, errorMessage: true },
      }),
    ).toEqual({
      errorCode: "PLANNING_FAILED",
      errorMessage: "LearnRecur could not review that scope. Check the request and try again.",
    });
  });

  it("does not let a slower duplicate planner overwrite the plan that finished first", async () => {
    let releaseFirstPlanner = () => {};
    const firstPlannerMayFinish = new Promise<void>((resolve) => {
      releaseFirstPlanner = resolve;
    });
    let markFirstPlannerStarted = () => {};
    const firstPlannerStarted = new Promise<void>((resolve) => {
      markFirstPlannerStarted = resolve;
    });
    let callCount = 0;
    const planScope = vi.fn(async () => {
      callCount += 1;
      const call = callCount;
      if (call === 1) {
        markFirstPlannerStarted();
        await firstPlannerMayFinish;
      }
      return {
        resolutionStatus: "resolved" as const,
        resolvedScopeLabel: "Chapter 4",
        clarification: null,
        warnings: [],
        items: [
          {
            key: "duplicate-planner-fence",
            title: call === 1 ? "Stale slower plan" : "Winning faster plan",
            objective: "Choose a direct object pronoun in one focused sentence.",
            materialSectionIds: [directSectionId],
            evidenceChunkIds: [directChunkId],
          },
        ],
      };
    });
    const request = {
      materialId,
      materialRevisionId,
      instruction: "Make one skill from chapter four.",
      idempotencyKey: `${runId}_concurrent_plan_fence`,
    };
    const firstRequest = planMaterialSkills({
      userId,
      input: request,
      now: new Date("2026-07-09T11:00:00.000Z"),
      aiSetup: createAiSetup({ planScope }),
      embeddingGenerator: null,
    });
    await firstPlannerStarted;
    const secondResult = await planMaterialSkills({
      userId,
      input: request,
      now: new Date("2026-07-09T11:00:01.000Z"),
      aiSetup: createAiSetup({ planScope }),
      embeddingGenerator: null,
    });
    releaseFirstPlanner();
    const firstResult = await firstRequest;

    expect(planScope).toHaveBeenCalledTimes(2);
    expect(secondResult).toMatchObject({
      status: "planned",
      plan: { items: [{ title: "Winning faster plan" }] },
    });
    expect(firstResult).toEqual(secondResult);
  });

  it("rechecks the reviewed plan after acquiring the confirmation lock", async () => {
    const planScope = vi.fn(async () => ({
      resolutionStatus: "resolved" as const,
      resolvedScopeLabel: "Chapter 4",
      clarification: null,
      warnings: [],
      items: [
        {
          key: "confirmation-fence",
          title: "Original reviewed plan",
          objective: "Choose a direct object pronoun in one focused sentence.",
          materialSectionIds: [directSectionId],
          evidenceChunkIds: [directChunkId],
        },
      ],
    }));
    const planned = await planMaterialSkills({
      userId,
      input: {
        materialId,
        materialRevisionId,
        instruction: "Make one skill from chapter four.",
        idempotencyKey: `${runId}_confirmation_fence`,
      },
      now: new Date(),
      aiSetup: createAiSetup({ planScope }),
      embeddingGenerator: null,
    });
    if (planned.status !== "planned") {
      throw new Error("expected planned confirmation fence batch");
    }
    const replacementPlan = {
      ...planned.plan,
      items: planned.plan.items.map((item) => ({ ...item, title: "Newer replacement plan" })),
    };
    let confirmation: ReturnType<typeof confirmMaterialPlan> | null = null;

    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "skill_draft_batches"
        WHERE "id" = ${planned.batchId} AND "userId" = ${userId}
        FOR UPDATE
      `;
      confirmation = confirmMaterialPlan({
        userId,
        input: { batchId: planned.batchId, plan: planned.plan },
        now: new Date(),
        eventSender: { async sendMaterialDraftItemRequested() {} },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await tx.skillDraftBatch.update({
        where: { id: planned.batchId },
        data: { proposedPlan: JSON.parse(JSON.stringify(replacementPlan)) },
      });
    });

    expect(await confirmation).toMatchObject({ status: "invalid" });
    expect(
      await prisma.skillDraftBatchItem.count({ where: { batchId: planned.batchId } }),
    ).toBe(0);
  });

  it("gives the planner a fallback chunk from every candidate section before the cap", async () => {
    const planScope = vi.fn(async () => ({
      resolutionStatus: "resolved",
      resolvedScopeLabel: "Chapter 4",
      clarification: null,
      warnings: [],
      items: [
        {
          key: "balanced-fallback",
          title: "Balanced pronoun evidence",
          objective: "Distinguish direct and indirect object pronoun evidence in short examples.",
          materialSectionIds: [directSectionId, indirectSectionId],
          evidenceChunkIds: [directChunkId, indirectChunkId],
        },
      ],
    }));
    const result = await planMaterialSkills({
      userId,
      input: {
        materialId,
        materialRevisionId,
        instruction: "Make one skill for each section in chapter four.",
        idempotencyKey: `${runId}_balanced_fallback`,
      },
      now: new Date(),
      aiSetup: createAiSetup({ planScope }),
      embeddingGenerator: null,
    });

    expect(result.status).toBe("planned");
    const planningInput = planScope.mock.calls[0]?.[0];
    expect(planningInput?.chunks.map((chunk) => chunk.id)).toEqual(
      expect.arrayContaining([directChunkId, indirectChunkId]),
    );
  });

  it("retrieves the reflexive-verb lesson when semantic search is unavailable", async () => {
    const { material, revision } = await createMaterialWithInitialRevision({
      userId,
      title: "Reflexive verb retrieval fixture",
      kind: StudyMaterialKind.PDF,
    });
    const frontMatter = await prisma.materialSection.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        ordinal: 0,
        level: 1,
        title: "Front matter",
        normalizedTitle: "front matter",
        pageStart: 1,
        pageEnd: 12,
        headingPath: ["Front matter"],
      },
    });
    const lesson = await prisma.materialSection.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        ordinal: 1,
        level: 1,
        title: "Lesson 12",
        normalizedTitle: "lesson 12",
        pageStart: 193,
        pageEnd: 205,
        headingPath: ["Lesson 12"],
      },
    });
    const unrelatedSectionIds = Array.from(
      { length: 12 },
      (_, index) => `${runId}_reflexive_unrelated_${index}`,
    );
    await prisma.materialSection.createMany({
      data: unrelatedSectionIds.map((id, index) => ({
        id,
        userId,
        materialRevisionId: revision.id,
        ordinal: index + 2,
        level: 1,
        title: `Unrelated lesson ${index + 1}`,
        normalizedTitle: `unrelated lesson ${index + 1}`,
        pageStart: index + 20,
        pageEnd: index + 20,
        headingPath: [`Unrelated lesson ${index + 1}`],
      })),
    });
    const teachingChunkIds = [
      `${runId}_reflexive_teaching_1`,
      `${runId}_reflexive_teaching_2`,
      `${runId}_reflexive_teaching_3`,
    ];
    const accentChunkId = `${runId}_accented_topic`;
    await prisma.materialChunk.createMany({
      data: [
        {
          id: `${runId}_reflexive_toc`,
          userId,
          materialRevisionId: revision.id,
          materialSectionId: frontMatter.id,
          ordinal: 0,
          text: "Contents: Reflexive Verbs 193. Reflexive pronouns 193.",
          tokenEstimate: 8,
          contentHash: `sha256:${runId}:reflexive-toc`,
          headingText: "Front matter",
          locator: { kind: "pdf", pageRange: { start: 8, end: 8 } },
        },
        ...teachingChunkIds.map((id, index) => ({
          id,
          userId,
          materialRevisionId: revision.id,
          materialSectionId: lesson.id,
          ordinal: index + 1,
          text:
            index === 0
              ? "Reflexive verbs use reflexive pronouns that agree with the subject."
              : index === 1
                ? "With a conjugated reflexive verb, the reflexive pronoun normally comes before the verb."
                : "Reflexive verbs can express routines, movement, emotion, and reciprocal actions.",
          tokenEstimate: 12,
          contentHash: `sha256:${id}`,
          headingText: "Lesson 12",
          locator: {
            kind: "pdf",
            pageRange: { start: 193 + index, end: 193 + index },
          },
        })),
        ...unrelatedSectionIds.map((sectionId, index) => ({
          id: `${runId}_reflexive_unrelated_chunk_${index}`,
          userId,
          materialRevisionId: revision.id,
          materialSectionId: sectionId,
          ordinal: index + 20,
          text: `General unrelated grammar material ${index + 1}.`,
          tokenEstimate: 8,
          contentHash: `sha256:${runId}:reflexive-unrelated-${index}`,
          headingText: `Unrelated lesson ${index + 1}`,
          locator: {
            kind: "pdf",
            pageRange: { start: index + 20, end: index + 20 },
          },
        })),
        {
          id: accentChunkId,
          userId,
          materialRevisionId: revision.id,
          materialSectionId: unrelatedSectionIds[0],
          ordinal: 50,
          text: "Números cardinales del 21 al 99.",
          tokenEstimate: 7,
          contentHash: `sha256:${runId}:accented-topic`,
          headingText: "Números",
          locator: { kind: "pdf", pageRange: { start: 20, end: 20 } },
        },
      ],
    });
    await prisma.materialPage.createMany({
      data: [
        {
          userId,
          materialRevisionId: revision.id,
          pageNumber: 194,
          ocrText: "Reflexive verbs place reflexive pronouns according to the verb form.",
          textStatus: MaterialPageTextStatus.OCR_READY,
          contentHash: `sha256:${runId}:reflexive-ocr`,
          tokenEstimate: 10,
        },
        {
          userId,
          materialRevisionId: revision.id,
          pageNumber: 20,
          ocrText: "An unrelated scanned worksheet with no relevant topic.",
          textStatus: MaterialPageTextStatus.OCR_READY,
          contentHash: `sha256:${runId}:unrelated-ocr`,
          tokenEstimate: 9,
        },
      ],
    });
    await finalizeMaterialRevision({
      userId,
      materialId: material.id,
      materialRevisionId: revision.id,
      contentHash: `sha256:${runId}:reflexive-retrieval`,
      byteSize: 16_384,
      pageCount: 205,
      storageBucket: "test-materials",
      storageKey: `${runId}/reflexive-retrieval.pdf`,
    });
    const planScope = vi.fn(async () => ({
      resolutionStatus: "resolved" as const,
      resolvedScopeLabel: "Reflexive verb rules",
      clarification: null,
      clarificationOptions: [],
      warnings: [],
      items: [
        {
          key: "reflexive-pronoun-placement",
          title: "Reflexive pronoun placement",
          objective: "Place reflexive pronouns correctly with conjugated Spanish verbs.",
          includeConcepts: ["reflexive pronoun placement"],
          excludeConcepts: ["commands"],
          materialSectionIds: [lesson.id],
          evidenceChunkIds: [teachingChunkIds[1]],
        },
      ],
    }));
    const lexicalMatches = await searchMaterialChunksLexical({
      userId,
      materialRevisionId: revision.id,
      query: "reflexive verb",
      prefixMatching: true,
      limit: 48,
    });
    expect(
      lexicalMatches.filter((chunk) => chunk.lexicalScore > 0).map((chunk) => chunk.id),
    ).toEqual(expect.arrayContaining(teachingChunkIds));
    const accentedMatches = await searchMaterialChunksLexical({
      userId,
      materialRevisionId: revision.id,
      query: "números",
      prefixMatching: true,
      limit: 10,
    });
    expect(
      accentedMatches.filter((chunk) => chunk.lexicalScore > 0).map((chunk) => chunk.id),
    ).toContain(accentChunkId);

    const result = await planMaterialSkills({
      userId,
      input: {
        materialId: material.id,
        materialRevisionId: revision.id,
        instruction: "make skills for the reflexive verb rules",
        idempotencyKey: `${runId}_reflexive_retrieval`,
      },
      now: new Date(),
      aiSetup: createAiSetup({ planScope }),
      embeddingGenerator: async () => {
        throw Object.assign(new Error("Not Found"), { status: 404 });
      },
    });

    expect(
      result.status,
      `planning result: ${JSON.stringify(result)}; planner calls: ${planScope.mock.calls.length}`,
    ).toBe("planned");
    const planningInput = planScope.mock.calls[0]?.[0];
    expect(planningInput?.sections.map((section) => section.id)).toEqual([lesson.id]);
    expect(planningInput?.chunks.map((chunk) => chunk.id)).toEqual(
      expect.arrayContaining(teachingChunkIds),
    );
    expect(planningInput?.chunks.every((chunk) => chunk.materialSectionId === lesson.id)).toBe(
      true,
    );
  });

  it("reserves fallback evidence for later sections before truncating ranked chunks", async () => {
    const { material, revision } = await createMaterialWithInitialRevision({
      userId,
      title: "Balanced retrieval fixture",
      kind: StudyMaterialKind.PDF,
    });
    const sectionIds = Array.from(
      { length: 20 },
      (_, index) => `${runId}_balanced_section_${String(index).padStart(2, "0")}`,
    );
    await prisma.materialSection.createMany({
      data: sectionIds.map((id, index) => ({
        id,
        userId,
        materialRevisionId: revision.id,
        ordinal: index,
        level: 1,
        title: `Balanced topic ${index + 1}`,
        normalizedTitle: `balanced topic ${index + 1}`,
        pageStart: index + 1,
        pageEnd: index + 1,
        headingPath: [`Balanced topic ${index + 1}`],
      })),
    });
    const firstSectionChunkIds = Array.from(
      { length: 48 },
      (_, index) => `${runId}_ranked_chunk_${String(index).padStart(2, "0")}`,
    );
    const fallbackChunkIds = sectionIds.slice(1).map(
      (_, index) => `${runId}_fallback_chunk_${String(index).padStart(2, "0")}`,
    );
    await prisma.materialChunk.createMany({
      data: [
        ...firstSectionChunkIds.map((id, index) => ({
          id,
          userId,
          materialRevisionId: revision.id,
          materialSectionId: sectionIds[0],
          ordinal: index,
          text: `Ranked grammar request evidence ${index + 1}.`,
          tokenEstimate: 8,
          contentHash: `sha256:${id}`,
          headingText: "Ranked grammar request",
          locator: { kind: "pdf", pageRange: { start: 1, end: 1 } },
        })),
        ...fallbackChunkIds.map((id, index) => ({
          id,
          userId,
          materialRevisionId: revision.id,
          materialSectionId: sectionIds[index + 1],
          ordinal: firstSectionChunkIds.length + index,
          text: `Fallback evidence for balanced topic ${index + 2}.`,
          tokenEstimate: 8,
          contentHash: `sha256:${id}`,
          headingText: `Balanced topic ${index + 2}`,
          locator: { kind: "pdf", pageRange: { start: index + 2, end: index + 2 } },
        })),
      ],
    });
    await finalizeMaterialRevision({
      userId,
      materialId: material.id,
      materialRevisionId: revision.id,
      contentHash: `sha256:${runId}:balanced-retrieval`,
      byteSize: 16_384,
      pageCount: 20,
      storageBucket: "test-materials",
      storageKey: `${runId}/balanced-retrieval.pdf`,
    });
    const lastChunkId = fallbackChunkIds.at(-1);
    if (!lastChunkId) {
      throw new Error("expected a later fallback chunk");
    }
    const planScope = vi.fn(async () => ({
      resolutionStatus: "resolved" as const,
      resolvedScopeLabel: "Balanced topic 20",
      clarification: null,
      warnings: [],
      items: [
        {
          key: "later-balanced-topic",
          title: "Later balanced topic",
          objective: "Recognize the evidence from the final balanced topic.",
          materialSectionIds: [sectionIds.at(-1)!],
          evidenceChunkIds: [lastChunkId],
        },
      ],
    }));

    const result = await planMaterialSkills({
      userId,
      input: {
        materialId: material.id,
        materialRevisionId: revision.id,
        instruction: "ranked grammar request",
        idempotencyKey: `${runId}_reserved_fallbacks`,
      },
      now: new Date(),
      aiSetup: createAiSetup({ planScope }),
      embeddingGenerator: null,
    });

    expect(result.status).toBe("planned");
    expect(planScope.mock.calls[0]?.[0].chunks.map((chunk) => chunk.id)).toContain(lastChunkId);
  });

  it("keeps a later semantic hit when broad-scope fallbacks fill the planning cap", async () => {
    const { material, revision } = await createMaterialWithInitialRevision({
      userId,
      title: "Large retrieval fixture",
      kind: StudyMaterialKind.PDF,
    });
    const sectionIds = Array.from(
      { length: 61 },
      (_, index) => `${runId}_retrieval_section_${String(index).padStart(2, "0")}`,
    );
    const chunkIds = Array.from(
      { length: 61 },
      (_, index) => `${runId}_retrieval_chunk_${String(index).padStart(2, "0")}`,
    );
    await prisma.materialSection.createMany({
      data: sectionIds.map((id, index) => ({
        id,
        userId,
        materialRevisionId: revision.id,
        ordinal: index,
        level: 1,
        title: `Topic ${index + 1}`,
        normalizedTitle: `topic ${index + 1}`,
        pageStart: index + 1,
        pageEnd: index + 1,
        headingPath: [`Topic ${index + 1}`],
      })),
    });
    await prisma.materialChunk.createMany({
      data: chunkIds.map((id, index) => ({
        id,
        userId,
        materialRevisionId: revision.id,
        materialSectionId: sectionIds[index],
        ordinal: index,
        text:
          index === 60
            ? "The zygomatic conjugation sentinel is the uniquely requested concept."
            : `General grammar overview for topic ${index + 1}.`,
        tokenEstimate: 10,
        contentHash: `sha256:${runId}:retrieval-${index}`,
        headingText: `Topic ${index + 1}`,
        locator: { kind: "pdf", pageRange: { start: index + 1, end: index + 1 } },
      })),
    });
    await finalizeMaterialRevision({
      userId,
      materialId: material.id,
      materialRevisionId: revision.id,
      contentHash: `sha256:${runId}:large-retrieval`,
      byteSize: 16_384,
      pageCount: 61,
      storageBucket: "test-materials",
      storageKey: `${runId}/large-retrieval.pdf`,
    });
    const planScope = vi.fn(async () => ({
      resolutionStatus: "resolved" as const,
      resolvedScopeLabel: "Topic 61",
      clarification: null,
      warnings: [],
      items: [
        {
          key: "later-semantic-hit",
          title: "Zygomatic conjugation sentinel",
          objective: "Recognize the uniquely requested conjugation sentinel concept.",
          materialSectionIds: [sectionIds[60]],
          evidenceChunkIds: [chunkIds[60]],
        },
      ],
    }));

    const result = await planMaterialSkills({
      userId,
      input: {
        materialId: material.id,
        materialRevisionId: revision.id,
        instruction: "zygomatic conjugation sentinel",
        idempotencyKey: `${runId}_later_semantic_hit`,
      },
      now: new Date(),
      aiSetup: createAiSetup({ planScope }),
      embeddingGenerator: null,
    });

    expect(result.status).toBe("planned");
    expect(planScope.mock.calls[0]?.[0].chunks.map((chunk) => chunk.id)).toContain(chunkIds[60]);
  });

  it("keeps a verified draft when a sibling exhausts its bounded regeneration", async () => {
    const planScope = vi.fn(async () => ({
      resolutionStatus: "resolved",
      resolvedScopeLabel: "Chapter 4, pages 90–128",
      clarification: null,
      warnings: [],
      items: [
        {
          key: "pronoun-placement",
          title: "Object pronoun placement",
          objective: "Place an object pronoun correctly before a conjugated Spanish verb.",
          materialSectionIds: [directSectionId],
          evidenceChunkIds: [directChunkId],
        },
        {
          key: "le-versus-les",
          title: "Choosing le versus les",
          objective: "Choose le or les from the number of recipients in a Spanish sentence.",
          materialSectionIds: [indirectSectionId],
          evidenceChunkIds: [indirectChunkId],
        },
      ],
    }));
    const planned = await planMaterialSkills({
      userId,
      input: {
        materialId,
        materialRevisionId,
        instruction: "Make two more skills from chapter four.",
        idempotencyKey: `${runId}_partial_plan`,
      },
      now: new Date(),
      aiSetup: createAiSetup({ planScope }),
      embeddingGenerator: null,
    });
    if (planned.status !== "planned") {
      throw new Error("expected planned batch");
    }
    const events: string[] = [];
    await confirmMaterialPlan({
      userId,
      input: { batchId: planned.batchId, plan: planned.plan },
      now: new Date(),
      eventSender: {
        async sendMaterialDraftItemRequested(payload) {
          events.push(payload.itemId);
        },
      },
    });
    const batch = await getMaterialDraftBatch({ userId, batchId: planned.batchId });
    expect(events).toHaveLength(2);
    const firstItem = batch?.items[0];
    const secondItem = batch?.items[1];
    if (!firstItem || !secondItem) {
      throw new Error("expected two planned items");
    }

    const staleUpdatedAt = new Date(Date.now() - 10 * 60 * 1_000);
    await prisma.skillDraftBatchItem.update({
      where: { id: firstItem.id },
      data: { status: SkillDraftBatchItemStatus.GENERATING, updatedAt: staleUpdatedAt },
    });

    expect(
      await runMaterialDraftItemJob({
        userId,
        batchId: planned.batchId,
        itemId: firstItem.id,
        aiSetup: createAiSetup(),
      }),
    ).toMatchObject({ status: "ready" });

    await prisma.skillDraftBatchItem.update({
      where: { id: secondItem.id },
      data: { status: SkillDraftBatchItemStatus.GENERATING, updatedAt: staleUpdatedAt },
    });
    const recovered = await getMaterialDraftBatch({ userId, batchId: planned.batchId });
    expect(recovered?.items[1]).toMatchObject({
      status: SkillDraftBatchItemStatus.FAILED,
      errorCode: "STALE_GENERATION_CLAIM",
      errorMessage: expect.stringMatching(/retry/i),
    });
    expect(
      await runMaterialDraftItemJob({
        userId,
        batchId: planned.batchId,
        itemId: secondItem.id,
        aiSetup: createAiSetup(),
      }),
    ).toMatchObject({ status: "not-claimed" });
    await retryMaterialDraftItem({
      userId,
      batchId: planned.batchId,
      itemId: secondItem.id,
      now: new Date(),
      eventSender: { async sendMaterialDraftItemRequested() {} },
    });
    expect(
      await runMaterialDraftItemJob({
        userId,
        batchId: planned.batchId,
        itemId: secondItem.id,
        aiSetup: createAiSetup({ rejectTitle: "Choosing le versus les" }),
      }),
    ).toMatchObject({ status: "failed", reason: "verification-rejected" });

    const completed = await getMaterialDraftBatch({ userId, batchId: planned.batchId });
    expect(completed).toMatchObject({
      status: SkillDraftBatchStatus.PARTIAL,
      readyCount: 1,
      failedCount: 1,
    });
    expect(completed?.items[0]).toMatchObject({
      status: SkillDraftBatchItemStatus.READY,
      skill: { status: SkillStatus.DRAFT },
    });
    expect(completed?.items[1]).toMatchObject({
      status: SkillDraftBatchItemStatus.FAILED,
      generationAttempts: 2,
    });
    expect(
      await retryMaterialDraftItem({
        userId,
        batchId: planned.batchId,
        itemId: secondItem.id,
        now: new Date(),
        automatic: true,
        eventSender: { async sendMaterialDraftItemRequested() {} },
      }),
    ).toMatchObject({ status: "not-found" });

    const readySkill = completed?.items[0].skill;
    if (!readySkill) {
      throw new Error("expected a ready material draft");
    }
    let activationSourceContext: string | null = null;
    const activated = await activateSkillDraft({
      userId,
      skillId: readySkill.id,
      now: new Date(),
      model: "fixture-model",
      generateChoiceExercises: async (generationInput) => {
        activationSourceContext = generationInput.sourceContext;
        return {
          exercises: [1, 2, 3].map((number) => ({
            prompt: `Choose the direct object pronoun in example ${number}.`,
            choices: [
              { id: "correct", label: "lo" },
              { id: "wrong-a", label: "le" },
              { id: "wrong-b", label: "les" },
            ],
            correctChoiceId: "correct",
            explanation: "The noun receives the action directly.",
            difficulty: 2,
            expectedSeconds: 30,
          })),
        };
      },
      verifyChoiceExercises: async (verificationInput) => ({
        verifications: verificationInput.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          verdict: "verified",
        })),
      }),
    });
    expect(activated.status).toBe("activated");
    expect(activationSourceContext).toContain("Direct object pronouns replace nouns");
    expect(activationSourceContext).not.toContain("UNRELATED CHAPTER SIX SOURCE TEXT");
    expect(activationSourceContext).not.toContain("Indirect object pronouns identify");
    expect(await getMaterialDraftBatch({ userId, batchId: planned.batchId })).toMatchObject({
      status: SkillDraftBatchStatus.PARTIAL,
      readyCount: 0,
      activatedCount: 1,
      items: [
        { status: SkillDraftBatchItemStatus.ACTIVE },
        { status: SkillDraftBatchItemStatus.FAILED },
      ],
    });

    let refillSourceContext: string | null = null;
    const refilled = await refillChoiceExercisesForSkill({
      userId,
      skillId: readySkill.id,
      now: new Date(),
      model: "fixture-model",
      targetReadyCount: 5,
      generateChoiceExercises: async (generationInput) => {
        refillSourceContext = generationInput.sourceContext;
        return {
          exercises: [4, 5].map((number) => ({
            prompt: `Choose the direct object pronoun in refill example ${number}.`,
            choices: [
              { id: "correct", label: "lo" },
              { id: "wrong-a", label: "le" },
              { id: "wrong-b", label: "les" },
            ],
            correctChoiceId: "correct",
            explanation: "The noun receives the action directly.",
            difficulty: 2,
            expectedSeconds: 30,
          })),
        };
      },
      verifyChoiceExercises: async (verificationInput) => ({
        verifications: verificationInput.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          verdict: "verified",
        })),
      }),
    });
    expect(refilled.status).toBe("refilled");
    expect(refillSourceContext).toContain("Direct object pronouns replace nouns");
    expect(refillSourceContext).not.toContain("UNRELATED CHAPTER SIX SOURCE TEXT");
    expect(refillSourceContext).not.toContain("Indirect object pronouns identify");

    await expect(
      excludeMaterialDraftItem({
        userId,
        batchId: planned.batchId,
        itemId: firstItem.id,
        now: new Date(),
      }),
    ).resolves.toMatchObject({ status: "not-found" });
    expect(
      await prisma.skill.findUniqueOrThrow({
        where: { id: readySkill.id },
        select: { status: true },
      }),
    ).toEqual({ status: SkillStatus.ACTIVE });
  });

  it("repairs a rejected target against its evidence automatically", async () => {
    const planned = await planMaterialSkills({
      userId,
      input: {
        materialId,
        materialRevisionId,
        instruction: "Make one skill for choosing le versus les.",
        idempotencyKey: `${runId}_target_repair`,
      },
      now: new Date(),
      aiSetup: createAiSetup({
        planScope: async () => ({
          resolutionStatus: "resolved",
          resolvedScopeLabel: "Indirect object pronouns",
          clarification: null,
          warnings: [],
          items: [
            {
              key: "le-versus-les-repair",
              title: "Choosing le versus les",
              objective: "Choose le or les and apply an unsupported pluralization rule.",
              includeConcepts: ["choose le or les from the number of recipients"],
              excludeConcepts: ["direct object pronouns"],
              materialSectionIds: [indirectSectionId],
              evidenceChunkIds: [indirectChunkId],
            },
          ],
        }),
      }),
      embeddingGenerator: null,
    });
    if (planned.status !== "planned") {
      throw new Error("expected target repair plan");
    }
    await confirmMaterialPlan({
      userId,
      input: { batchId: planned.batchId, plan: planned.plan },
      now: new Date(),
      eventSender: { async sendMaterialDraftItemRequested() {} },
    });
    const pending = await getMaterialDraftBatch({ userId, batchId: planned.batchId });
    const itemId = pending?.items[0]?.id;
    if (!itemId) {
      throw new Error("expected target repair item");
    }
    const repairTarget = vi.fn().mockResolvedValue({
      status: "repaired",
      title: "Choosing le or les by recipient count",
      objective: "Choose le for one recipient and les for multiple recipients.",
      includeConcepts: ["le for one recipient", "les for multiple recipients"],
      excludeConcepts: ["unsupported pluralization rule"],
      note: "Removed the unsupported rule.",
    });
    expect(
      await runMaterialDraftItemJob({
        userId,
        batchId: planned.batchId,
        itemId,
        aiSetup: createAiSetup({
          rejectTitle: "Choosing le versus les",
          repairTarget,
        }),
      }),
    ).toMatchObject({ status: "ready" });
    expect(repairTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        verificationNote: expect.stringMatching(/fixture rejects/i),
      }),
    );
    expect(await getMaterialDraftBatch({ userId, batchId: planned.batchId })).toMatchObject({
      status: SkillDraftBatchStatus.READY,
      items: [
        {
          status: SkillDraftBatchItemStatus.READY,
          proposedTitle: "Choosing le or les by recipient count",
          proposedObjective: "Choose le for one recipient and les for multiple recipients.",
          generationMetadata: {
            targetRepair: { status: "completed" },
          },
        },
      ],
    });
  });

  it("repairs a contradictory repaired target again before showing a failure", async () => {
    const planned = await planMaterialSkills({
      userId,
      input: {
        materialId,
        materialRevisionId,
        instruction: "Make a skill for cardinal numbers above 29.",
        idempotencyKey: `${runId}_second_target_repair`,
      },
      now: new Date(),
      aiSetup: createAiSetup({
        planScope: async () => ({
          resolutionStatus: "resolved",
          resolvedScopeLabel: "Cardinal numbers above 29",
          clarification: null,
          warnings: [],
          items: [
            {
              key: "cardinals-above-29",
              title: "Spanish cardinal numbers above 29",
              objective: "Form Spanish cardinal numbers from 30 up to millions.",
              includeConcepts: ["cardinal numbers from 30 upward"],
              excludeConcepts: ["ordinal numbers"],
              materialSectionIds: [indirectSectionId],
              evidenceChunkIds: [indirectChunkId],
            },
          ],
        }),
      }),
      embeddingGenerator: null,
    });
    if (planned.status !== "planned") {
      throw new Error("expected second target repair plan");
    }
    await confirmMaterialPlan({
      userId,
      input: { batchId: planned.batchId, plan: planned.plan },
      now: new Date(),
      eventSender: { async sendMaterialDraftItemRequested() {} },
    });
    const pending = await getMaterialDraftBatch({ userId, batchId: planned.batchId });
    const itemId = pending?.items[0]?.id;
    if (!itemId) {
      throw new Error("expected second target repair item");
    }
    const repairTarget = vi
      .fn()
      .mockResolvedValueOnce({
        status: "repaired",
        title: "Spanish cardinal numbers from 30 to 100",
        objective: "Form Spanish cardinal numbers from 30 to 100.",
        includeConcepts: ["cardinal numbers from 30 to 100"],
        excludeConcepts: ["cien and ciento patterns"],
        note: "Narrowed the range to the cited pages.",
      })
      .mockResolvedValueOnce({
        status: "repaired",
        title: "Spanish cardinal numbers from 30 to 99",
        objective: "Form Spanish cardinal numbers from 30 to 99.",
        includeConcepts: ["cardinal numbers from 30 to 99"],
        excludeConcepts: ["100 and higher cardinal numbers"],
        note: "Removed the contradictory endpoint.",
      });
    const verifyDraft = vi.fn(async (verificationInput) => {
      if (verificationInput.target.objective.includes("millions")) {
        return {
          verdict: "rejected",
          reasons: ["unsupported_detail"],
          note: "The cited pages do not support millions.",
        };
      }
      if (verificationInput.target.objective.includes("30 to 100")) {
        return {
          verdict: "rejected",
          reasons: ["too_broad"],
          note: "The draft includes 100 even though the target excludes cien and ciento.",
        };
      }
      return { verdict: "verified", reasons: [], note: null };
    });

    expect(
      await runMaterialDraftItemJob({
        userId,
        batchId: planned.batchId,
        itemId,
        aiSetup: createAiSetup({ repairTarget, verifyDraft }),
      }),
    ).toMatchObject({ status: "ready" });
    expect(repairTarget).toHaveBeenCalledTimes(2);
    expect(repairTarget.mock.calls[1]?.[0]).toMatchObject({
      target: { objective: "Form Spanish cardinal numbers from 30 to 100." },
      verificationNote: expect.stringMatching(/includes 100/i),
    });
    expect(await getMaterialDraftBatch({ userId, batchId: planned.batchId })).toMatchObject({
      status: SkillDraftBatchStatus.READY,
      items: [
        {
          status: SkillDraftBatchItemStatus.READY,
          proposedTitle: "Spanish cardinal numbers from 30 to 99",
          proposedObjective: "Form Spanish cardinal numbers from 30 to 99.",
          generationMetadata: {
            targetRepair: { status: "completed", attempts: 2 },
          },
        },
      ],
    });
  });

  it("does not let a stale worker overwrite a newer successful claim", async () => {
    const planScope = vi.fn(async () => ({
      resolutionStatus: "resolved" as const,
      resolvedScopeLabel: "Chapter 4",
      clarification: null,
      warnings: [],
      items: [
        {
          key: "generation-claim-fence",
          title: "Generation claim fence",
          objective: "Place a direct object pronoun in one claim-fence example.",
          materialSectionIds: [directSectionId],
          evidenceChunkIds: [directChunkId],
        },
      ],
    }));
    const planned = await planMaterialSkills({
      userId,
      input: {
        materialId,
        materialRevisionId,
        instruction: "Make a claim-fence skill from chapter four.",
        idempotencyKey: `${runId}_generation_claim_fence`,
      },
      now: new Date(),
      aiSetup: createAiSetup({ planScope }),
      embeddingGenerator: null,
    });
    if (planned.status !== "planned") {
      throw new Error("expected planned generation claim fence batch");
    }
    await confirmMaterialPlan({
      userId,
      input: { batchId: planned.batchId, plan: planned.plan },
      now: new Date(),
      eventSender: { async sendMaterialDraftItemRequested() {} },
    });
    const item = await prisma.skillDraftBatchItem.findFirstOrThrow({
      where: { batchId: planned.batchId },
    });
    let markSlowWorkerStarted = () => {};
    const slowWorkerStarted = new Promise<void>((resolve) => {
      markSlowWorkerStarted = resolve;
    });
    let releaseSlowWorker = () => {};
    const slowWorkerMayFinish = new Promise<void>((resolve) => {
      releaseSlowWorker = resolve;
    });
    const slowAi = createAiSetup();
    slowAi.generateDraft = async () => {
      markSlowWorkerStarted();
      await slowWorkerMayFinish;
      throw new Error("stale worker failed after its claim was replaced");
    };

    const staleWorker = runMaterialDraftItemJob({
      userId,
      batchId: planned.batchId,
      itemId: item.id,
      now: new Date(),
      aiSetup: slowAi,
    });
    await slowWorkerStarted;
    await prisma.skillDraftBatchItem.update({
      where: { id: item.id },
      data: { updatedAt: new Date(Date.now() - 11 * 60 * 1_000) },
    });
    expect(
      await runMaterialDraftItemJob({
        userId,
        batchId: planned.batchId,
        itemId: item.id,
        now: new Date(),
        aiSetup: createAiSetup(),
      }),
    ).toMatchObject({ status: "ready" });
    releaseSlowWorker();
    expect(await staleWorker).toMatchObject({ status: "not-claimed" });
    expect(
      await prisma.skillDraftBatchItem.findUnique({
        where: { id: item.id },
        select: { status: true, skill: { select: { status: true } } },
      }),
    ).toEqual({ status: SkillDraftBatchItemStatus.READY, skill: { status: SkillStatus.DRAFT } });
  });

  it("recovers a ready batch item after its linked draft skill is deleted", async () => {
    const skill = await prisma.skill.create({
      data: { userId, title: "Deleted batch draft", tags: [], status: SkillStatus.DRAFT },
    });
    const batch = await prisma.skillDraftBatch.create({
      data: {
        userId,
        materialRevisionId,
        instruction: "Deleted ready draft fixture",
        idempotencyKey: `${runId}_deleted_ready_draft`,
        status: SkillDraftBatchStatus.READY,
        requestedCount: 1,
        readyCount: 1,
      },
    });
    const item = await prisma.skillDraftBatchItem.create({
      data: {
        userId,
        batchId: batch.id,
        skillId: skill.id,
        ordinal: 0,
        targetKey: "deleted-ready-draft",
        proposedTitle: "Deleted batch draft replacement",
        proposedObjective: "Place a direct object pronoun in one short sentence.",
        locator: pdfLocator({ materialRevisionId, directSectionId, directChunkId }),
        status: SkillDraftBatchItemStatus.READY,
      },
    });
    await expect(
      deleteSkillPermanently({
        userId,
        skillId: skill.id,
        confirmationTitle: skill.title,
      }),
    ).resolves.toMatchObject({ status: "deleted" });

    await expect(
      runMaterialDraftItemJob({
        userId,
        batchId: batch.id,
        itemId: item.id,
        aiSetup: createAiSetup(),
      }),
    ).resolves.toMatchObject({ status: "failed", reason: "draft-skill-deleted" });
    await expect(
      prisma.skillDraftBatchItem.findUnique({ where: { id: item.id } }),
    ).resolves.toMatchObject({
      status: SkillDraftBatchItemStatus.FAILED,
      skillId: null,
      errorCode: "DRAFT_SKILL_DELETED",
    });

    await retryMaterialDraftItem({
      userId,
      batchId: batch.id,
      itemId: item.id,
      now: new Date(),
      eventSender: { async sendMaterialDraftItemRequested() {} },
    });
    await expect(
      runMaterialDraftItemJob({
        userId,
        batchId: batch.id,
        itemId: item.id,
        aiSetup: createAiSetup(),
      }),
    ).resolves.toMatchObject({ status: "ready", alreadyGenerated: false });
  });

  it("keeps retryable generation failures claimable for the same Inngest event", async () => {
    const batch = await prisma.skillDraftBatch.create({
      data: {
        userId,
        materialRevisionId,
        instruction: "Transient retry fixture",
        idempotencyKey: `${runId}_transient_retry`,
        status: SkillDraftBatchStatus.GENERATING,
        requestedCount: 1,
      },
    });
    const item = await prisma.skillDraftBatchItem.create({
      data: {
        userId,
        batchId: batch.id,
        ordinal: 0,
        targetKey: "transient-retry",
        proposedTitle: "Transient retry draft",
        proposedObjective: "Place a direct object pronoun in one short sentence.",
        locator: pdfLocator({ materialRevisionId, directSectionId, directChunkId }),
        status: SkillDraftBatchItemStatus.PLANNED,
      },
    });
    const requestedAt = new Date().toISOString();
    const failingAi = createAiSetup();
    failingAi.generateDraft = async () => {
      throw new MaterialDraftGenerationError("Temporary provider timeout.", { retryable: true });
    };

    await expect(
      runMaterialDraftItemJob({
        userId,
        batchId: batch.id,
        itemId: item.id,
        requestedAt,
        attempt: 0,
        maxAttempts: 4,
        aiSetup: failingAi,
      }),
    ).rejects.toThrow(/temporary provider timeout/i);
    await expect(
      prisma.skillDraftBatchItem.findUnique({ where: { id: item.id } }),
    ).resolves.toMatchObject({
      status: SkillDraftBatchItemStatus.PLANNED,
      generationClaimId: expect.any(String),
      errorCode: "TRANSIENT_GENERATION_FAILURE",
    });

    await expect(
      runMaterialDraftItemJob({
        userId,
        batchId: batch.id,
        itemId: item.id,
        requestedAt,
        attempt: 1,
        maxAttempts: 4,
        aiSetup: createAiSetup(),
      }),
    ).resolves.toMatchObject({ status: "ready", alreadyGenerated: false });
  });

  it("treats deleted localized evidence as a permanent draft failure", async () => {
    const batch = await prisma.skillDraftBatch.create({
      data: {
        userId,
        materialRevisionId,
        instruction: "Missing localized evidence fixture",
        idempotencyKey: `${runId}_missing_localized_evidence`,
        status: SkillDraftBatchStatus.GENERATING,
        requestedCount: 1,
      },
    });
    const missingChunkId = `${runId}_deleted_evidence_chunk`;
    const item = await prisma.skillDraftBatchItem.create({
      data: {
        userId,
        batchId: batch.id,
        ordinal: 0,
        targetKey: "missing-localized-evidence",
        proposedTitle: "Missing localized evidence",
        proposedObjective: "Use evidence that has been permanently removed.",
        locator: pdfLocator({
          materialRevisionId,
          directSectionId,
          directChunkId: missingChunkId,
        }),
        status: SkillDraftBatchItemStatus.PLANNED,
      },
    });

    await expect(
      runMaterialDraftItemJob({
        userId,
        batchId: batch.id,
        itemId: item.id,
        requestedAt: new Date().toISOString(),
        attempt: 0,
        maxAttempts: 4,
        aiSetup: createAiSetup(),
      }),
    ).rejects.toMatchObject({ retryable: false });
    await expect(
      prisma.skillDraftBatchItem.findUnique({ where: { id: item.id } }),
    ).resolves.toMatchObject({
      status: SkillDraftBatchItemStatus.FAILED,
      generationClaimId: null,
      errorCode: "GENERATION_REJECTED",
      errorMessage: expect.stringMatching(/no longer available/i),
    });
  });

  it("does not save a draft after material deletion wins the generation race", async () => {
    const fixtureTitle = "Deleting generation fixture";
    const { material, revision } = await createMaterialWithInitialRevision({
      userId,
      title: fixtureTitle,
      kind: StudyMaterialKind.PDF,
    });
    const section = await prisma.materialSection.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        ordinal: 0,
        title: "Deletion race section",
        normalizedTitle: "deletion race section",
        pageStart: 1,
        pageEnd: 1,
        headingPath: ["Deletion race section"],
      },
    });
    const chunk = await prisma.materialChunk.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        materialSectionId: section.id,
        ordinal: 0,
        text: "A deletion race must not leave a newly generated draft without its material evidence.",
        tokenEstimate: 14,
        contentHash: `sha256:${runId}:deletion-race`,
        headingText: section.title,
        locator: { kind: "pdf", pageRange: { start: 1, end: 1 } },
      },
    });
    await prisma.sourceFile.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.READY,
        originalName: "deletion-race.pdf",
        mimeType: "application/pdf",
        storageBucket: "test-materials",
        storageKey: `${runId}/deletion-race.pdf`,
      },
    });
    await finalizeMaterialRevision({
      userId,
      materialId: material.id,
      materialRevisionId: revision.id,
      contentHash: `sha256:${runId}:deletion-race`,
      byteSize: 1_024,
      pageCount: 1,
      storageBucket: "test-materials",
      storageKey: `${runId}/deletion-race.pdf`,
    });
    const batch = await prisma.skillDraftBatch.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        instruction: "Deletion race fixture",
        idempotencyKey: `${runId}_deletion_race`,
        status: SkillDraftBatchStatus.GENERATING,
        requestedCount: 1,
      },
    });
    const item = await prisma.skillDraftBatchItem.create({
      data: {
        userId,
        batchId: batch.id,
        ordinal: 0,
        targetKey: "deletion-race",
        proposedTitle: "Deletion race draft",
        proposedObjective: "Recognize the deletion race evidence boundary.",
        locator: pdfLocator({
          materialRevisionId: revision.id,
          directSectionId: section.id,
          directChunkId: chunk.id,
        }),
        status: SkillDraftBatchItemStatus.PLANNED,
      },
    });
    const deletingAi = createAiSetup();
    const generateDraft = deletingAi.generateDraft;
    deletingAi.generateDraft = async (generationInput) => {
      await requestMaterialDeletion({
        userId,
        materialId: material.id,
        confirmationTitle: fixtureTitle,
      });
      return generateDraft(generationInput);
    };

    await expect(
      runMaterialDraftItemJob({
        userId,
        batchId: batch.id,
        itemId: item.id,
        aiSetup: deletingAi,
      }),
    ).resolves.toMatchObject({ status: "not-claimed" });
    await expect(
      prisma.skill.count({ where: { userId, title: "Deletion race draft" } }),
    ).resolves.toBe(0);
  });

  it("blocks exclusion while a linked skill activation job is running", async () => {
    const now = new Date();
    const skill = await prisma.skill.create({
      data: { userId, title: "Activation exclusion fence", tags: [], status: SkillStatus.DRAFT },
    });
    const batch = await prisma.skillDraftBatch.create({
      data: {
        userId,
        materialRevisionId,
        instruction: "Activation exclusion fixture",
        idempotencyKey: `${runId}_activation_exclusion`,
        status: SkillDraftBatchStatus.READY,
        requestedCount: 1,
        readyCount: 1,
      },
    });
    const item = await prisma.skillDraftBatchItem.create({
      data: {
        userId,
        batchId: batch.id,
        skillId: skill.id,
        ordinal: 0,
        targetKey: "activation-exclusion",
        proposedTitle: skill.title,
        proposedObjective: "Block exclusion while activation generates exercises.",
        locator: {},
        status: SkillDraftBatchItemStatus.READY,
      },
    });
    await prisma.generationJob.create({
      data: {
        userId,
        skillId: skill.id,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        status: GenerationJobStatus.RUNNING,
        provider: "gemini",
        model: "fixture-model",
        promptVersion: "fixture-v1",
        requestedCount: 3,
        startedAt: now,
      },
    });

    expect(
      await excludeMaterialDraftItem({
        userId,
        batchId: batch.id,
        itemId: item.id,
        now,
      }),
    ).toMatchObject({ status: "not-excluded", reason: "activation-in-progress" });
    expect(await prisma.skill.count({ where: { id: skill.id } })).toBe(1);
    expect(await prisma.skillDraftBatchItem.findUnique({ where: { id: item.id } })).toMatchObject({
      status: SkillDraftBatchItemStatus.READY,
      skillId: skill.id,
    });

    await prisma.generationJob.updateMany({
      where: { userId, skillId: skill.id, kind: GenerationJobKind.SKILL_ACTIVATION },
      data: { startedAt: new Date(now.getTime() - 10 * 60 * 1_000) },
    });
    await expect(
      excludeMaterialDraftItem({
        userId,
        batchId: batch.id,
        itemId: item.id,
        now,
      }),
    ).resolves.toMatchObject({ status: "excluded" });
    expect(await prisma.skill.count({ where: { id: skill.id } })).toBe(0);
  });

  it("reserves quota once and activates a ready item from its exact stored locator", async () => {
    const ready = await createReadyBatch([
      {
        key: "localized-activation",
        title: "Localized object pronoun practice",
        objective: "Place a direct object pronoun before a conjugated Spanish verb.",
        materialSectionIds: [directSectionId],
        evidenceChunkIds: [directChunkId],
      },
    ]);
    const events: Array<{ itemId: string; generationJobId: string }> = [];
    const queued = await queueMaterialBatchActivation({
      userId,
      input: { batchId: ready.id, itemIds: [ready.items[0].id] },
      now: new Date("2026-07-09T12:00:00.000Z"),
      eventSender: {
        async sendMaterialBatchActivationRequested(payload) {
          events.push(payload);
        },
      },
    });

    expect(queued).toMatchObject({ status: "queued", queuedItemIds: [ready.items[0].id] });
    expect(events).toHaveLength(1);
    expect(await getMaterialDraftBatch({ userId, batchId: ready.id })).toMatchObject({
      status: SkillDraftBatchStatus.ACTIVATING,
      readyCount: 0,
      items: [{ status: SkillDraftBatchItemStatus.ACTIVATING }],
    });
    expect(
      await queueMaterialBatchActivation({
        userId,
        input: { batchId: ready.id, itemIds: [ready.items[0].id] },
        now: new Date("2026-07-09T12:00:30.000Z"),
        eventSender: {
          async sendMaterialBatchActivationRequested(payload) {
            events.push(payload);
          },
        },
      }),
    ).toMatchObject({ status: "already-queued" });
    expect(events).toHaveLength(1);
    await expect(
      prisma.generationJob.findUniqueOrThrow({ where: { id: events[0].generationJobId } }),
    ).resolves.toMatchObject({
      kind: GenerationJobKind.SKILL_ACTIVATION,
      status: GenerationJobStatus.PENDING,
      skillId: ready.items[0].skill?.id,
    });

    let receivedSourceContext: string | null | undefined;
    const activated = await runMaterialBatchActivationJob({
      userId,
      batchId: ready.id,
      itemId: ready.items[0].id,
      generationJobId: events[0].generationJobId,
      now: new Date("2026-07-09T12:01:00.000Z"),
      generateChoiceExercises: async (input) => {
        receivedSourceContext = input.sourceContext;
        return {
          exercises: [
            generatedChoiceExercise(1),
            generatedChoiceExercise(2),
            generatedChoiceExercise(3),
          ],
        };
      },
      verifyChoiceExercises: async (input) => ({
        verifications: input.candidates.map((candidate) => ({
          candidateId: candidate.candidateId,
          verdict: "verified",
        })),
      }),
      model: "fixture-model",
    });

    expect(activated).toMatchObject({ status: "active", alreadyActivated: false });
    expect(receivedSourceContext).toContain("Direct object pronouns replace nouns");
    expect(receivedSourceContext).not.toContain("Indirect object pronouns identify");
    expect(receivedSourceContext).not.toContain("UNRELATED CHAPTER SIX SOURCE TEXT");
    expect(await getMaterialDraftBatch({ userId, batchId: ready.id })).toMatchObject({
      status: SkillDraftBatchStatus.COMPLETE,
      activatedCount: 1,
      items: [{ status: SkillDraftBatchItemStatus.ACTIVE, skill: { status: SkillStatus.ACTIVE } }],
    });

    let refillSourceContext: string | null | undefined;
    const refilled = await refillChoiceExercisesForSkill({
      userId,
      skillId: ready.items[0].skill?.id ?? "missing-skill",
      now: new Date("2026-07-09T12:02:00.000Z"),
      targetReadyCount: 5,
      generateChoiceExercises: async (input) => {
        refillSourceContext = input.sourceContext;
        return {
          exercises: [generatedChoiceExercise(10), generatedChoiceExercise(11)],
        };
      },
      verifyChoiceExercises: acceptAllChoiceExercises,
      model: "fixture-model",
    });
    expect(refilled).toMatchObject({ status: "refilled", exerciseCount: 2 });
    expect(refillSourceContext).toContain("Direct object pronouns replace nouns");
    expect(refillSourceContext).not.toContain("UNRELATED CHAPTER SIX SOURCE TEXT");
  });

  it("reuses an existing activation job instead of inserting a conflicting reservation", async () => {
    const ready = await createReadyBatch([
      {
        key: "existing-activation-job",
        title: "Existing activation job fixture",
        objective: "Choose a direct object pronoun while activation is already running.",
        materialSectionIds: [directSectionId],
        evidenceChunkIds: [directChunkId],
      },
    ]);
    const skillId = ready.items[0].skill?.id;
    if (!skillId) {
      throw new Error("expected an existing activation fixture skill");
    }
    const existingJob = await prisma.generationJob.create({
      data: {
        userId,
        skillId,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        status: GenerationJobStatus.RUNNING,
        provider: "gemini",
        model: "fixture-model",
        promptVersion: "skill-mcq-v0",
        requestedCount: 3,
        startedAt: new Date(),
      },
    });

    await expect(
      queueMaterialBatchActivation({
        userId,
        input: { batchId: ready.id, itemIds: [ready.items[0].id] },
        now: new Date(),
        eventSender: { async sendMaterialBatchActivationRequested() {} },
      }),
    ).resolves.toMatchObject({ status: "already-queued" });
    await expect(
      prisma.generationJob.count({
        where: { userId, skillId, kind: GenerationJobKind.SKILL_ACTIVATION },
      }),
    ).resolves.toBe(1);
    expect(await getMaterialDraftBatch({ userId, batchId: ready.id })).toMatchObject({
      readyCount: 0,
      items: [{ status: SkillDraftBatchItemStatus.ACTIVATING }],
    });

    await prisma.$transaction([
      prisma.generationJob.update({
        where: { id: existingJob.id },
        data: { status: GenerationJobStatus.FAILED, completedAt: new Date() },
      }),
      prisma.skillDraftBatchItem.update({
        where: { id: ready.items[0].id },
        data: {
          status: SkillDraftBatchItemStatus.FAILED,
          errorCode: "ACTIVATION_RETRYABLE_TEST_CLEANUP",
          errorMessage: "released after existing job test",
        },
      }),
    ]);
  });

  it("does not let a stale activation worker overwrite a newer claim", async () => {
    const ready = await createReadyBatch([
      {
        key: "activation-claim-fence",
        title: "Activation claim fence fixture",
        objective: "Choose a direct object pronoun while activation claims race.",
        materialSectionIds: [directSectionId],
        evidenceChunkIds: [directChunkId],
      },
    ]);
    const events: Array<{ itemId: string; generationJobId: string }> = [];
    await queueMaterialBatchActivation({
      userId,
      input: { batchId: ready.id, itemIds: [ready.items[0].id] },
      now: new Date("2026-07-17T12:00:00.000Z"),
      eventSender: {
        async sendMaterialBatchActivationRequested(payload) {
          events.push(payload);
        },
      },
    });
    let markWorkerStarted = () => {};
    const workerStarted = new Promise<void>((resolve) => {
      markWorkerStarted = resolve;
    });
    let releaseWorker = () => {};
    const workerMayFail = new Promise<void>((resolve) => {
      releaseWorker = resolve;
    });
    const staleWorker = runMaterialBatchActivationJob({
      ...events[0],
      now: new Date("2026-07-17T12:01:00.000Z"),
      generateChoiceExercises: async () => {
        markWorkerStarted();
        await workerMayFail;
        throw new Error("stale activation worker failed");
      },
      verifyChoiceExercises: acceptAllChoiceExercises,
      model: "fixture-model",
    });
    await workerStarted;
    await prisma.skillDraftBatchItem.update({
      where: { id: ready.items[0].id },
      data: {
        status: SkillDraftBatchItemStatus.ACTIVATING,
        generationClaimId: "newer-activation-claim",
      },
    });
    releaseWorker();

    await expect(staleWorker).resolves.toMatchObject({ status: "not-claimed" });
    await expect(
      prisma.skillDraftBatchItem.findUnique({ where: { id: ready.items[0].id } }),
    ).resolves.toMatchObject({
      status: SkillDraftBatchItemStatus.ACTIVATING,
      generationClaimId: "newer-activation-claim",
    });
    await prisma.skillDraftBatchItem.update({
      where: { id: ready.items[0].id },
      data: {
        status: SkillDraftBatchItemStatus.FAILED,
        generationClaimId: null,
        errorCode: "ACTIVATION_RETRYABLE_TEST_CLEANUP",
        errorMessage: "released after activation claim test",
      },
    });
  });

  it("recovers stale activation claims when the batch is opened", async () => {
    const ready = await createReadyBatch([
      {
        key: "stale-activation-recovery",
        title: "Stale activation recovery fixture",
        objective: "Choose a direct object pronoun after a stopped activation.",
        materialSectionIds: [directSectionId],
        evidenceChunkIds: [directChunkId],
      },
    ]);
    const skillId = ready.items[0].skill?.id;
    if (!skillId) {
      throw new Error("expected a stale activation fixture skill");
    }
    const staleAt = new Date(Date.now() - 3 * 60 * 1_000);
    const job = await prisma.generationJob.create({
      data: {
        userId,
        skillId,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        status: GenerationJobStatus.RUNNING,
        provider: "gemini",
        model: "fixture-model",
        promptVersion: "skill-mcq-v0",
        requestedCount: 3,
        startedAt: staleAt,
      },
    });
    await prisma.skillDraftBatchItem.update({
      where: { id: ready.items[0].id },
      data: {
        status: SkillDraftBatchItemStatus.ACTIVATING,
        generationClaimId: "abandoned-activation-claim",
        updatedAt: staleAt,
      },
    });

    expect(await getMaterialDraftBatch({ userId, batchId: ready.id })).toMatchObject({
      failedCount: 1,
      readyCount: 0,
      items: [
        {
          status: SkillDraftBatchItemStatus.FAILED,
          errorCode: "ACTIVATION_RETRYABLE_STALE_CLAIM",
        },
      ],
    });
    await expect(
      prisma.skillDraftBatchItem.findUnique({ where: { id: ready.items[0].id } }),
    ).resolves.toMatchObject({ generationClaimId: null });
    await expect(
      prisma.generationJob.findUnique({ where: { id: job.id } }),
    ).resolves.toMatchObject({ status: GenerationJobStatus.FAILED });
  });

  it("keeps successful activations when a sibling fails and retries only the failed item", async () => {
    const ready = await createReadyBatch([
      {
        key: "activation-success",
        title: "Activation success fixture",
        objective: "Choose a direct object pronoun in one short sentence.",
        materialSectionIds: [directSectionId],
        evidenceChunkIds: [directChunkId],
      },
      {
        key: "activation-retry",
        title: "Activation retry fixture",
        objective: "Choose le or les for one recipient phrase.",
        materialSectionIds: [indirectSectionId],
        evidenceChunkIds: [indirectChunkId],
      },
    ]);
    const events: Array<{ itemId: string; generationJobId: string }> = [];
    await queueMaterialBatchActivation({
      userId,
      input: { batchId: ready.id, itemIds: ready.items.map((item) => item.id) },
      now: new Date("2026-07-09T13:00:00.000Z"),
      eventSender: {
        async sendMaterialBatchActivationRequested(payload) {
          events.push(payload);
        },
      },
    });
    const firstEvent = events.find((event) => event.itemId === ready.items[0].id);
    const secondEvent = events.find((event) => event.itemId === ready.items[1].id);
    if (!firstEvent || !secondEvent) {
      throw new Error("expected two activation events");
    }

    await runMaterialBatchActivationJob({
      userId,
      batchId: ready.id,
      itemId: firstEvent.itemId,
      generationJobId: firstEvent.generationJobId,
      now: new Date("2026-07-09T13:01:00.000Z"),
      generateChoiceExercises: async () => ({
        exercises: [
          generatedChoiceExercise(4),
          generatedChoiceExercise(5),
          generatedChoiceExercise(6),
        ],
      }),
      verifyChoiceExercises: acceptAllChoiceExercises,
      model: "fixture-model",
    });
    await expect(
      runMaterialBatchActivationJob({
        userId,
        batchId: ready.id,
        itemId: secondEvent.itemId,
        generationJobId: secondEvent.generationJobId,
        now: new Date("2026-07-09T13:01:00.000Z"),
        generateChoiceExercises: async () => {
          throw new Error("temporary fixture outage");
        },
        verifyChoiceExercises: acceptAllChoiceExercises,
        model: "fixture-model",
      }),
    ).rejects.toBeInstanceOf(MaterialBatchActivationError);

    expect(await getMaterialDraftBatch({ userId, batchId: ready.id })).toMatchObject({
      status: SkillDraftBatchStatus.PARTIAL,
      activatedCount: 1,
      failedCount: 1,
    });
    const retryEvents: typeof events = [];
    expect(
      await retryMaterialBatchActivationItem({
        userId,
        batchId: ready.id,
        itemId: secondEvent.itemId,
        now: new Date("2026-07-09T13:02:00.000Z"),
        eventSender: {
          async sendMaterialBatchActivationRequested(payload) {
            retryEvents.push(payload);
          },
        },
      }),
    ).toMatchObject({ status: "queued" });
    expect(retryEvents).toEqual([
      expect.objectContaining({
        itemId: secondEvent.itemId,
        generationJobId: secondEvent.generationJobId,
      }),
    ]);

    await runMaterialBatchActivationJob({
      ...retryEvents[0],
      now: new Date("2026-07-09T13:03:00.000Z"),
      generateChoiceExercises: async () => ({
        exercises: [
          generatedChoiceExercise(7),
          generatedChoiceExercise(8),
          generatedChoiceExercise(9),
        ],
      }),
      verifyChoiceExercises: acceptAllChoiceExercises,
      model: "fixture-model",
    });
    expect(await getMaterialDraftBatch({ userId, batchId: ready.id })).toMatchObject({
      status: SkillDraftBatchStatus.COMPLETE,
      activatedCount: 2,
      failedCount: 0,
    });
    await expect(
      prisma.generationJob.count({
        where: {
          userId,
          skillId: ready.items[1].skill?.id,
          kind: GenerationJobKind.SKILL_ACTIVATION,
        },
      }),
    ).resolves.toBe(1);
  });

  it("keeps queued siblings when one activation event cannot be sent", async () => {
    const ready = await createReadyBatch([
      {
        key: "event-success",
        title: "Activation event success fixture",
        objective: "Choose a direct object pronoun after an event is queued.",
        materialSectionIds: [directSectionId],
        evidenceChunkIds: [directChunkId],
      },
      {
        key: "event-failure",
        title: "Activation event failure fixture",
        objective: "Choose an indirect object pronoun after an event retry.",
        materialSectionIds: [indirectSectionId],
        evidenceChunkIds: [indirectChunkId],
      },
    ]);
    const result = await queueMaterialBatchActivation({
      userId,
      input: { batchId: ready.id, itemIds: ready.items.map((item) => item.id) },
      now: new Date("2026-07-09T13:30:00.000Z"),
      eventSender: {
        async sendMaterialBatchActivationRequested(payload) {
          if (payload.itemId === ready.items[1].id) {
            throw new Error("fixture event transport failure");
          }
        },
      },
    });

    expect(result).toMatchObject({
      status: "partial",
      queuedItemIds: [ready.items[0].id],
      failedItemIds: [ready.items[1].id],
    });
    const batch = await getMaterialDraftBatch({ userId, batchId: ready.id });
    expect(batch).toMatchObject({
      status: SkillDraftBatchStatus.ACTIVATING,
      failedCount: 1,
      items: [
        { status: SkillDraftBatchItemStatus.ACTIVATING },
        {
          status: SkillDraftBatchItemStatus.FAILED,
          errorCode: "ACTIVATION_EVENT_SEND_FAILED",
        },
      ],
    });
    const jobs = await prisma.generationJob.findMany({
      where: {
        userId,
        skillId: { in: ready.items.flatMap((item) => (item.skill ? [item.skill.id] : [])) },
        kind: GenerationJobKind.SKILL_ACTIVATION,
      },
    });
    const statusBySkillId = new Map(jobs.map((job) => [job.skillId, job.status]));
    expect(statusBySkillId.get(ready.items[0].skill?.id ?? "missing")).toBe(
      GenerationJobStatus.PENDING,
    );
    expect(statusBySkillId.get(ready.items[1].skill?.id ?? "missing")).toBe(
      GenerationJobStatus.FAILED,
    );
  });

  it("serializes concurrent batch reservations so the daily quota cannot be oversubscribed", async () => {
    const first = await createReadyBatch([
      {
        key: "quota-first",
        title: "Quota boundary first fixture",
        objective: "Choose one direct object pronoun at the quota boundary.",
        materialSectionIds: [directSectionId],
        evidenceChunkIds: [directChunkId],
      },
    ]);
    const second = await createReadyBatch([
      {
        key: "quota-second",
        title: "Quota boundary second fixture",
        objective: "Choose one indirect object pronoun at the quota boundary.",
        materialSectionIds: [indirectSectionId],
        evidenceChunkIds: [indirectChunkId],
      },
    ]);
    expect(
      await queueMaterialBatchActivation({
        userId: otherUserId,
        input: { batchId: first.id, itemIds: [first.items[0].id] },
        now: new Date("2026-07-09T14:00:00.000Z"),
        eventSender: { async sendMaterialBatchActivationRequested() {} },
      }),
    ).toMatchObject({ status: "not-found" });

    const dayStart = new Date("2026-07-09T00:00:00.000Z");
    const existingCount = await prisma.generationJob.count({
      where: {
        userId,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        createdAt: { gte: dayStart },
      },
    });
    for (let index = existingCount; index < 9; index += 1) {
      const skill = await prisma.skill.create({
        data: {
          userId,
          title: `Quota reservation fixture ${index}`,
          tags: [],
          status: SkillStatus.DRAFT,
        },
      });
      await prisma.generationJob.create({
        data: {
          userId,
          skillId: skill.id,
          kind: GenerationJobKind.SKILL_ACTIVATION,
          status: GenerationJobStatus.FAILED,
          provider: "google",
          model: "fixture-model",
          promptVersion: "skill-mcq-v0",
          requestedCount: 5,
          errorMessage: "quota fixture",
          createdAt: new Date(`2026-07-09T10:${String(index).padStart(2, "0")}:00.000Z`),
        },
      });
    }

    const results = await Promise.all([
      queueMaterialBatchActivation({
        userId,
        input: { batchId: first.id, itemIds: [first.items[0].id] },
        now: new Date("2026-07-09T14:00:00.000Z"),
        eventSender: { async sendMaterialBatchActivationRequested() {} },
      }),
      queueMaterialBatchActivation({
        userId,
        input: { batchId: second.id, itemIds: [second.items[0].id] },
        now: new Date("2026-07-09T14:00:00.000Z"),
        eventSender: { async sendMaterialBatchActivationRequested() {} },
      }),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(["limited", "queued"]);
    await expect(
      prisma.generationJob.count({
        where: {
          userId,
          kind: GenerationJobKind.SKILL_ACTIVATION,
          createdAt: { gte: dayStart },
        },
      }),
    ).resolves.toBe(10);
  });

  it("skips a ready batch item whose skill was already activated elsewhere", async () => {
    const ready = await createReadyBatch([
      {
        key: "already-active-selection",
        title: "Already active selection fixture",
        objective: "Choose a direct object pronoun in one short sentence.",
        materialSectionIds: [directSectionId],
        evidenceChunkIds: [directChunkId],
      },
      {
        key: "remaining-ready-selection",
        title: "Remaining ready selection fixture",
        objective: "Choose an indirect object pronoun in one short sentence.",
        materialSectionIds: [indirectSectionId],
        evidenceChunkIds: [indirectChunkId],
      },
    ]);
    const activeSkillId = ready.items[0].skill?.id;
    if (!activeSkillId) {
      throw new Error("expected the first batch skill");
    }
    await prisma.skill.update({
      where: { id: activeSkillId },
      data: { status: SkillStatus.ACTIVE },
    });
    const events: Array<{ itemId: string; generationJobId: string }> = [];

    const result = await queueMaterialBatchActivation({
      userId,
      input: { batchId: ready.id, itemIds: ready.items.map((item) => item.id) },
      now: new Date("2026-07-10T12:00:00.000Z"),
      eventSender: {
        async sendMaterialBatchActivationRequested(payload) {
          events.push(payload);
        },
      },
    });

    expect(result).toMatchObject({
      status: "queued",
      queuedItemIds: [ready.items[1].id],
    });
    expect(events).toEqual([
      expect.objectContaining({ itemId: ready.items[1].id }),
    ]);
    expect(await getMaterialDraftBatch({ userId, batchId: ready.id })).toMatchObject({
      activatedCount: 1,
      items: [
        { status: SkillDraftBatchItemStatus.ACTIVE },
        { status: SkillDraftBatchItemStatus.ACTIVATING },
      ],
    });

    await prisma.$transaction([
      prisma.skillDraftBatchItem.update({
        where: { id: ready.items[1].id },
        data: {
          status: SkillDraftBatchItemStatus.FAILED,
          errorCode: "ACTIVATION_RETRYABLE_TEST_CLEANUP",
          errorMessage: "released after selection test",
        },
      }),
      prisma.generationJob.update({
        where: { id: events[0].generationJobId },
        data: { status: GenerationJobStatus.FAILED, completedAt: new Date() },
      }),
    ]);
  });

  it("rechecks active-skill capacity before consuming a queued reservation", async () => {
    const ready = await createReadyBatch([
      {
        key: "queued-slot-recheck",
        title: "Queued slot recheck fixture",
        objective: "Choose a direct object pronoun after a queued slot is rechecked.",
        materialSectionIds: [directSectionId],
        evidenceChunkIds: [directChunkId],
      },
    ]);
    const events: Array<{ itemId: string; generationJobId: string }> = [];
    expect(
      await queueMaterialBatchActivation({
        userId,
        input: { batchId: ready.id, itemIds: [ready.items[0].id] },
        now: new Date("2026-07-12T12:00:00.000Z"),
        eventSender: {
          async sendMaterialBatchActivationRequested(payload) {
            events.push(payload);
          },
        },
      }),
    ).toMatchObject({ status: "queued" });
    const activeSkillCount = await prisma.skill.count({
      where: { userId, status: { in: [SkillStatus.ACTIVE, SkillStatus.PAUSED] } },
    });
    const fillerPrefix = `Queued slot recheck filler ${randomUUID()}`;
    await prisma.skill.createMany({
      data: Array.from({ length: Math.max(0, ALPHA_ACTIVE_SKILLS - activeSkillCount) }, (_, index) => ({
        userId,
        title: `${fillerPrefix} ${index}`,
        tags: [],
        status: SkillStatus.ACTIVE,
      })),
    });
    const generateChoiceExercises = vi.fn(async () => ({
      exercises: [generatedChoiceExercise(31), generatedChoiceExercise(32), generatedChoiceExercise(33)],
    }));

    await expect(
      runMaterialBatchActivationJob({
        userId,
        batchId: ready.id,
        itemId: ready.items[0].id,
        generationJobId: events[0].generationJobId,
        now: new Date("2026-07-12T12:01:00.000Z"),
        generateChoiceExercises,
        verifyChoiceExercises: acceptAllChoiceExercises,
        model: "fixture-model",
      }),
    ).rejects.toBeInstanceOf(MaterialBatchActivationError);
    expect(generateChoiceExercises).not.toHaveBeenCalled();
    expect(await getMaterialDraftBatch({ userId, batchId: ready.id })).toMatchObject({
      failedCount: 1,
      items: [{ status: SkillDraftBatchItemStatus.FAILED }],
    });
    await prisma.skill.deleteMany({ where: { userId, title: { startsWith: fillerPrefix } } });
  });

  it("reserves active-skill slots for queued activations and retry attempts", async () => {
    const first = await createReadyBatch([
      {
        key: "active-slot-first",
        title: "Active slot first fixture",
        objective: "Choose a direct object pronoun at the active-skill boundary.",
        materialSectionIds: [directSectionId],
        evidenceChunkIds: [directChunkId],
      },
    ]);
    const second = await createReadyBatch([
      {
        key: "active-slot-second",
        title: "Active slot second fixture",
        objective: "Choose an indirect object pronoun at the active-skill boundary.",
        materialSectionIds: [indirectSectionId],
        evidenceChunkIds: [indirectChunkId],
      },
    ]);
    await prisma.skillDraftBatchItem.updateMany({
      where: { userId, status: SkillDraftBatchItemStatus.ACTIVATING },
      data: {
        status: SkillDraftBatchItemStatus.FAILED,
        errorCode: "ACTIVATION_RETRYABLE_TEST_CLEANUP",
        errorMessage: "released before active-slot test",
      },
    });
    const activeSkillCount = await prisma.skill.count({
      where: { userId, status: { in: [SkillStatus.ACTIVE, SkillStatus.PAUSED] } },
    });
    await prisma.skill.createMany({
      data: Array.from(
        { length: Math.max(0, ALPHA_ACTIVE_SKILLS - 1 - activeSkillCount) },
        (_, index) => ({
          userId,
          title: `Active slot filler ${index}`,
          tags: [],
          status: SkillStatus.ACTIVE,
        }),
      ),
    });
    const firstEvents: Array<{ itemId: string; generationJobId: string }> = [];
    expect(
      await queueMaterialBatchActivation({
        userId,
        input: { batchId: first.id, itemIds: [first.items[0].id] },
        now: new Date("2026-07-11T12:00:00.000Z"),
        eventSender: {
          async sendMaterialBatchActivationRequested(payload) {
            firstEvents.push(payload);
          },
        },
      }),
    ).toMatchObject({ status: "queued" });

    expect(
      await queueMaterialBatchActivation({
        userId,
        input: { batchId: second.id, itemIds: [second.items[0].id] },
        now: new Date("2026-07-11T12:01:00.000Z"),
        eventSender: { async sendMaterialBatchActivationRequested() {} },
      }),
    ).toMatchObject({ status: "limited", code: "active-skill-limit" });

    await prisma.skillDraftBatchItem.update({
      where: { id: first.items[0].id },
      data: {
        status: SkillDraftBatchItemStatus.FAILED,
        errorCode: "ACTIVATION_RETRYABLE_TEST_FAILURE",
        errorMessage: "retry fixture",
      },
    });
    expect(
      await queueMaterialBatchActivation({
        userId,
        input: { batchId: second.id, itemIds: [second.items[0].id] },
        now: new Date("2026-07-11T12:02:00.000Z"),
        eventSender: { async sendMaterialBatchActivationRequested() {} },
      }),
    ).toMatchObject({ status: "queued" });
    expect(
      await retryMaterialBatchActivationItem({
        userId,
        batchId: first.id,
        itemId: first.items[0].id,
        now: new Date("2026-07-11T12:03:00.000Z"),
        eventSender: { async sendMaterialBatchActivationRequested() {} },
      }),
    ).toMatchObject({ status: "limited" });
    expect(firstEvents).toHaveLength(1);

    const generateChoiceExercises = vi.fn(async () => ({
      exercises: [generatedChoiceExercise(21), generatedChoiceExercise(22), generatedChoiceExercise(23)],
    }));
    await expect(
      runMaterialBatchActivationJob({
        userId,
        batchId: first.id,
        itemId: first.items[0].id,
        generationJobId: firstEvents[0].generationJobId,
        now: new Date("2026-07-11T12:04:00.000Z"),
        generateChoiceExercises,
        verifyChoiceExercises: acceptAllChoiceExercises,
        model: "fixture-model",
      }),
    ).rejects.toBeInstanceOf(MaterialBatchActivationError);
    expect(generateChoiceExercises).not.toHaveBeenCalled();
    expect(
      await prisma.skillDraftBatchItem.findUnique({
        where: { id: first.items[0].id },
        select: { status: true, skill: { select: { status: true } } },
      }),
    ).toEqual({
      status: SkillDraftBatchItemStatus.FAILED,
      skill: { status: SkillStatus.DRAFT },
    });
  });

  it("resynchronizes a failed batch item whose skill became active elsewhere", async () => {
    const ready = await createReadyBatch([
      {
        key: "failed-active-resync",
        title: "Failed active resync fixture",
        objective: "Choose a direct object pronoun after external activation.",
        materialSectionIds: [directSectionId],
        evidenceChunkIds: [directChunkId],
      },
    ]);
    const skillId = ready.items[0].skill?.id;
    if (!skillId) {
      throw new Error("expected failed active resync skill");
    }
    await prisma.$transaction([
      prisma.skillDraftBatchItem.update({
        where: { id: ready.items[0].id },
        data: {
          status: SkillDraftBatchItemStatus.FAILED,
          errorCode: "ACTIVATION_RETRYABLE_FIXTURE",
          errorMessage: "fixture failure before external activation",
        },
      }),
      prisma.skill.update({
        where: { id: skillId },
        data: { status: SkillStatus.ACTIVE },
      }),
    ]);

    expect(await getMaterialDraftBatch({ userId, batchId: ready.id })).toMatchObject({
      activatedCount: 1,
      failedCount: 0,
      items: [{ status: SkillDraftBatchItemStatus.ACTIVE }],
    });
  });

  async function createReadyBatch(
    targets: Array<{
      key: string;
      title: string;
      objective: string;
      materialSectionIds: string[];
      evidenceChunkIds: string[];
    }>,
  ) {
    const planned = await planMaterialSkills({
      userId,
      input: {
        materialId,
        materialRevisionId,
        instruction: "Make focused skills from chapter four.",
        idempotencyKey: `${runId}_${randomUUID()}`,
      },
      now: new Date(),
      aiSetup: createAiSetup({
        planScope: async () => ({
          resolutionStatus: "resolved",
          resolvedScopeLabel: "Chapter 4",
          clarification: null,
          warnings: [],
          items: targets,
        }),
      }),
      embeddingGenerator: null,
    });
    if (planned.status !== "planned") {
      throw new Error("expected activation fixture plan");
    }
    await confirmMaterialPlan({
      userId,
      input: { batchId: planned.batchId, plan: planned.plan },
      now: new Date(),
      eventSender: { async sendMaterialDraftItemRequested() {} },
    });
    const pending = await getMaterialDraftBatch({ userId, batchId: planned.batchId });
    if (!pending) {
      throw new Error("expected activation fixture batch");
    }
    for (const item of pending.items) {
      const result = await runMaterialDraftItemJob({
        userId,
        batchId: planned.batchId,
        itemId: item.id,
        aiSetup: createAiSetup(),
      });
      if (result.status !== "ready") {
        throw new Error("expected activation fixture draft");
      }
    }
    const ready = await getMaterialDraftBatch({ userId, batchId: planned.batchId });
    if (!ready || ready.items.some((item) => item.status !== SkillDraftBatchItemStatus.READY)) {
      throw new Error("expected ready activation fixture items");
    }
    return ready;
  }
});

const generatedChoiceExercise = (id: number) => ({
  prompt: `Choose the grounded answer for item ${id}.`,
  choices: [
    { id: "correct", label: "Correct" },
    { id: "close", label: "Close" },
    { id: "wrong", label: "Wrong" },
  ],
  correctChoiceId: "correct",
  explanation: "This answer follows the cited material.",
  difficulty: 2,
  expectedSeconds: 30,
});

const acceptAllChoiceExercises = async (input: {
  candidates: Array<{ candidateId: string }>;
}) => ({
  verifications: input.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    verdict: "verified",
  })),
});

function pdfLocator(input: {
  materialRevisionId: string;
  directSectionId: string;
  directChunkId: string;
}) {
  return {
    version: 1,
    materialRevisionId: input.materialRevisionId,
    materialSectionIds: [input.directSectionId],
    evidenceChunkIds: [input.directChunkId],
    source: { kind: "pdf", pageRanges: [{ start: 1, end: 1 }] },
  };
}

function createAiSetup(input: {
  planScope?: MaterialDraftAiSetup["planScope"];
  reviewScope?: MaterialDraftAiSetup["reviewScope"];
  repairTarget?: MaterialDraftAiSetup["repairTarget"];
  verifyDraft?: MaterialDraftAiSetup["verifyDraft"];
  rejectTitle?: string;
} = {}): MaterialDraftAiSetup {
  return {
    model: "fixture-model",
    planScope:
      input.planScope ??
      (async () => ({
        resolutionStatus: "ambiguous",
        resolvedScopeLabel: "Fixture",
        clarification: "Clarify the fixture.",
        warnings: [],
        items: [],
      })),
    ...(input.reviewScope ? { reviewScope: input.reviewScope } : {}),
    ...(input.repairTarget ? { repairTarget: input.repairTarget } : {}),
    async generateDraft(draftInput) {
      const title = draftInput.focusNote?.match(/Create exactly this target: ([^.]+(?:\.)?)/)?.[1]
        ?.replace(/\.$/, "")
        .trim() || "Object pronoun placement";
      return {
        drafts: [
          {
            title,
            objective:
              title === "Choosing le versus les"
                ? "Choose le or les from the number of recipients in a Spanish sentence."
                : "Place an object pronoun correctly before a conjugated Spanish verb.",
            rules: ["Place the pronoun before a conjugated verb."],
            examples: ["Veo el libro. → Lo veo."],
            exerciseConstraints: "Use short sentences with one unambiguous recipient or object.",
            tags: ["spanish", "pronouns"],
          },
        ],
      };
    },
    verifyDraft: input.verifyDraft ?? (async (verificationInput) => {
      return verificationInput.target.title === input.rejectTitle
        ? {
            verdict: "rejected",
            reasons: ["not_grounded"],
            note: "The fixture rejects this target.",
          }
        : { verdict: "verified", reasons: [], note: null };
    }),
  };
}
