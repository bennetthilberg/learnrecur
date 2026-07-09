import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
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
  planMaterialSkills,
  runMaterialDraftItemJob,
} from "@/lib/materials/batches";
import {
  createMaterialWithInitialRevision,
  finalizeMaterialRevision,
} from "@/lib/materials/lifecycle";
import { getPrisma } from "@/lib/prisma";
import { activateSkillDraft } from "@/lib/skills";

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

    await expect(
      excludeMaterialDraftItem({
        userId,
        batchId: planned.batchId,
        itemId: firstItem.id,
        now: new Date(),
      }),
    ).resolves.toMatchObject({
      status: "not-excluded",
      reason: "skill-not-draft",
    });
    expect(
      await prisma.skill.findUniqueOrThrow({
        where: { id: readySkill.id },
        select: { status: true },
      }),
    ).toEqual({ status: SkillStatus.ACTIVE });
  });
});

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
