import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  GenerationJobKind,
  GenerationJobStatus,
  SkillDraftBatchItemStatus,
  SkillDraftBatchStatus,
  SkillStatus,
  SourceFileKind,
  SourceFileStatus,
  StudyMaterialKind,
} from "@/generated/prisma/client";
import type { MaterialDraftAiSetup } from "@/lib/materials/ai";
import {
  confirmMaterialPlan,
  excludeMaterialDraftItem,
  getMaterialDraftBatch,
  MaterialDraftGenerationError,
  planMaterialSkills,
  retryMaterialDraftItem,
  runMaterialDraftItemJob,
} from "@/lib/materials/batches";
import {
  createMaterialWithInitialRevision,
  finalizeMaterialRevision,
  requestMaterialDeletion,
} from "@/lib/materials/lifecycle";
import { getPrisma } from "@/lib/prisma";
import { activateSkillDraft, refillChoiceExercisesForSkill } from "@/lib/skills";
import { deleteSkillPermanently } from "@/lib/skills/delete";

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
    async verifyDraft(verificationInput) {
      return verificationInput.target.title === input.rejectTitle
        ? {
            verdict: "rejected",
            reasons: ["not_grounded"],
            note: "The fixture rejects this target.",
          }
        : { verdict: "verified", reasons: [], note: null };
    },
  };
}
