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
  MaterialBatchActivationError,
  confirmMaterialPlan,
  getMaterialDraftBatch,
  planMaterialSkills,
  queueMaterialBatchActivation,
  retryMaterialBatchActivationItem,
  runMaterialBatchActivationJob,
  runMaterialDraftItemJob,
} from "@/lib/materials/batches";
import {
  createMaterialWithInitialRevision,
  finalizeMaterialRevision,
} from "@/lib/materials/lifecycle";
import { getPrisma } from "@/lib/prisma";
import { refillChoiceExercisesForSkill } from "@/lib/skills";

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
          ordinal: 1,
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
      },
    });
    sourceFileId = sourceFile.id;
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
    ).rejects.toThrow(/same user/i);
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

    expect(
      await runMaterialDraftItemJob({
        userId,
        batchId: planned.batchId,
        itemId: firstItem.id,
        aiSetup: createAiSetup(),
      }),
    ).toMatchObject({ status: "ready" });
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
    await prisma.sourceFile.update({
      where: { id: sourceFileId },
      data: { extractedText: "WHOLE TEXTBOOK SENTINEL that must never reach activation." },
    });
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
    expect(receivedSourceContext).not.toContain("WHOLE TEXTBOOK SENTINEL");
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
    expect(refillSourceContext).not.toContain("WHOLE TEXTBOOK SENTINEL");
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
