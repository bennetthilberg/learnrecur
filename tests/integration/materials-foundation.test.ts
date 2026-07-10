import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MaterialRevisionStatus,
  SkillStatus,
  SourceFileKind,
  SourceFileStatus,
  StudyMaterialKind,
  StudyMaterialStatus,
} from "@/generated/prisma/client";
import { MATERIAL_LOCATOR_VERSION } from "@/lib/materials/contracts";
import {
  createIdempotentDraftBatch,
  createMaterialWithInitialRevision,
  createNextMaterialRevision,
  finalizeMaterialRevision,
  requestMaterialDeletion,
} from "@/lib/materials/lifecycle";
import {
  MATERIAL_EMBEDDING_DIMENSIONS,
  searchMaterialChunks,
  storeMaterialChunkEmbedding,
} from "@/lib/materials/retrieval";
import { getPrisma } from "@/lib/prisma";
import { getUserDataExport } from "@/lib/settings/data-export";
import { deleteSkillPermanently } from "@/lib/skills/delete";
import { getSkillsLibrary } from "@/lib/skills/library";
import { getSkillCreationSourceRecoveryItems } from "@/lib/skills/source-recovery";
import { removeSkillSource } from "@/lib/skills/sources";
import {
  completeSourceUploadDrafts,
  dismissFailedSourceUpload,
  requeueSourceUploadDraft,
  runQueuedSourceUploadDraftJob,
  type SourceUploadStorage,
} from "@/lib/skills/uploads";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `materials_foundation_${randomUUID()}`;

describeDatabase("persistent material foundation", () => {
  const prisma = getPrisma();
  const userId = `${runId}_owner`;
  const otherUserId = `${runId}_other`;

  beforeAll(async () => {
    await prisma.user.createMany({
      data: [
        { id: userId, email: `${userId}@example.com` },
        { id: otherUserId, email: `${otherUserId}@example.com` },
      ],
      skipDuplicates: true,
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } });
    await prisma.$disconnect();
  });

  it("keeps finalized revisions immutable, retrieves exact vectors within ownership, and exports v2", async () => {
    const { material, revision } = await createMaterialWithInitialRevision({
      userId,
      title: "Practical Spanish Grammar",
      kind: StudyMaterialKind.PDF,
      sourceUrl: "https://books.example/spanish.pdf",
    });

    const sourceFile = await prisma.sourceFile.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.READY,
        originalName: "spanish.pdf",
        mimeType: "application/pdf",
        storageBucket: "private-materials",
        storageKey: `${userId}/${revision.id}/original.pdf`,
      },
    });
    const section = await prisma.materialSection.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        ordinal: 0,
        level: 1,
        title: "Chapter 4: Direct object pronouns",
        normalizedTitle: "chapter 4 direct object pronouns",
        pageStart: 48,
        pageEnd: 56,
        headingPath: ["Chapter 4", "Direct object pronouns"],
      },
    });
    const locator = {
      version: MATERIAL_LOCATOR_VERSION,
      materialRevisionId: revision.id,
      materialSectionIds: [section.id],
      evidenceChunkIds: ["placeholder"],
      storageKey: "chunk-private-key",
      source: { kind: "pdf", pageRanges: [{ start: 48, end: 51 }] },
    } as const;
    const chunks = await Promise.all([
      prisma.materialChunk.create({
        data: {
          userId,
          materialRevisionId: revision.id,
          materialSectionId: section.id,
          sourceFileId: sourceFile.id,
          ordinal: 0,
          text: "Direct object pronouns replace nouns that receive an action.",
          tokenEstimate: 11,
          contentHash: "sha256:chunk-a",
          locator,
          headingText: "Direct object pronouns",
        },
      }),
      prisma.materialChunk.create({
        data: {
          userId,
          materialRevisionId: revision.id,
          materialSectionId: section.id,
          sourceFileId: sourceFile.id,
          ordinal: 1,
          text: "The preterite describes completed past actions.",
          tokenEstimate: 8,
          contentHash: "sha256:chunk-b",
          locator: { ...locator, source: { kind: "pdf", pageRanges: [{ start: 54, end: 56 }] } },
          headingText: "Preterite review",
        },
      }),
    ]);

    const directObjectVector = Array.from(
      { length: MATERIAL_EMBEDDING_DIMENSIONS },
      (_, index) => (index === 0 ? 1 : 0),
    );
    const preteriteVector = Array.from(
      { length: MATERIAL_EMBEDDING_DIMENSIONS },
      (_, index) => (index === 1 ? 1 : 0),
    );
    await storeMaterialChunkEmbedding({
      userId,
      materialRevisionId: revision.id,
      chunkId: chunks[0].id,
      embedding: directObjectVector,
    });
    await storeMaterialChunkEmbedding({
      userId,
      materialRevisionId: revision.id,
      chunkId: chunks[1].id,
      embedding: preteriteVector,
    });

    await finalizeMaterialRevision({
      userId,
      materialId: material.id,
      materialRevisionId: revision.id,
      contentHash: "sha256:spanish-revision-one",
      byteSize: 4_096,
      pageCount: 120,
      summary: "A practical Spanish grammar guide. It covers pronouns and verb tenses.",
      storageBucket: "private-materials",
      storageKey: `${userId}/${revision.id}/original.pdf`,
      processingMetadata: { parser: "fixture", storageKey: "must-not-export" },
    });

    const results = await searchMaterialChunks({
      userId,
      materialRevisionId: revision.id,
      embedding: directObjectVector,
      query: "direct object pronouns",
      materialSectionIds: [section.id],
      limit: 2,
    });
    expect(results.map((result) => result.id)).toEqual([chunks[0].id, chunks[1].id]);
    expect(
      await searchMaterialChunks({
        userId: otherUserId,
        materialRevisionId: revision.id,
        embedding: directObjectVector,
        query: "direct object pronouns",
      }),
    ).toEqual([]);

    const foreignMaterial = await createMaterialWithInitialRevision({
      userId,
      title: "A different book",
      kind: StudyMaterialKind.PDF,
    });
    await expect(
      prisma.studyMaterial.update({
        where: { id: foreignMaterial.material.id },
        data: { activeRevisionId: revision.id },
      }),
    ).rejects.toThrow(/same material and user/i);

    await expect(
      prisma.materialRevision.update({
        where: { id: revision.id },
        data: { sourceUrl: "https://books.example/replaced.pdf" },
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      prisma.materialRevision.update({
        where: { id: revision.id },
        data: { finalizedAt: null },
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      prisma.materialRevision.update({
        where: { id: revision.id },
        data: { summary: "A rewritten material summary." },
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      prisma.materialSection.update({
        where: { id: section.id },
        data: { title: "Rewritten chapter" },
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      prisma.materialChunk.update({
        where: { id: chunks[0].id },
        data: { text: "Rewritten evidence" },
      }),
    ).rejects.toThrow(/immutable/i);
    await expect(
      prisma.sourceFile.update({
        where: { id: sourceFile.id },
        data: { extractedText: "Rewritten source" },
      }),
    ).rejects.toThrow(/immutable/i);

    const exportBatch = await prisma.skillDraftBatch.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        instruction: "Export fixture",
        idempotencyKey: `${runId}_export_fixture`,
        confirmedPlan: {
          storageBucket: "confirmed-plan-private-bucket",
          nested: { publicUrl: "https://storage.example/private-plan" },
        },
      },
    });
    await prisma.skillDraftBatchItem.create({
      data: {
        userId,
        batchId: exportBatch.id,
        ordinal: 0,
        targetKey: "export-item",
        proposedTitle: "Export item",
        proposedObjective: "Verify private locator fields are removed.",
        locator: { storageKey: "item-private-key", safe: "retained" },
      },
    });

    const exported = await getUserDataExport({
      userId,
      generatedAt: new Date("2026-07-09T12:00:00.000Z"),
    });
    expect(exported.status).toBe("ready");
    if (exported.status !== "ready") {
      throw new Error("expected a ready export");
    }
    expect(exported.export.exportVersion).toBe(2);
    expect(exported.export.studyMaterials.map((entry) => entry.id)).toContain(material.id);
    expect(exported.export.materialRevisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: revision.id,
          summary: "A practical Spanish grammar guide. It covers pronouns and verb tenses.",
        }),
      ]),
    );
    expect(exported.export.materialChunks).toHaveLength(2);
    expect(JSON.stringify(exported.export)).not.toContain("must-not-export");
    expect(JSON.stringify(exported.export)).not.toContain("private-materials");
    expect(JSON.stringify(exported.export)).not.toContain("chunk-private-key");
    expect(JSON.stringify(exported.export)).not.toContain("confirmed-plan-private-bucket");
    expect(JSON.stringify(exported.export)).not.toContain("item-private-key");
    expect(JSON.stringify(exported.export)).toContain("retained");
  });

  it("keeps the newest finalized revision active when ingestion completes out of order", async () => {
    const { material, revision: firstRevision } = await createMaterialWithInitialRevision({
      userId,
      title: "Out-of-order finalization fixture",
      kind: StudyMaterialKind.PDF,
    });
    const secondRevision = await createNextMaterialRevision({
      userId,
      materialId: material.id,
    });
    if (!secondRevision) {
      throw new Error("expected a second material revision");
    }

    await finalizeMaterialRevision({
      userId,
      materialId: material.id,
      materialRevisionId: secondRevision.id,
      contentHash: "sha256:newer",
      byteSize: 2,
      pageCount: 2,
      storageBucket: "private-materials",
      storageKey: `${userId}/${secondRevision.id}/newer.pdf`,
    });
    await finalizeMaterialRevision({
      userId,
      materialId: material.id,
      materialRevisionId: firstRevision.id,
      contentHash: "sha256:older",
      byteSize: 1,
      pageCount: 1,
      storageBucket: "private-materials",
      storageKey: `${userId}/${firstRevision.id}/older.pdf`,
    });

    expect(
      await prisma.studyMaterial.findUnique({
        where: { id: material.id },
        select: { activeRevisionId: true },
      }),
    ).toEqual({ activeRevisionId: secondRevision.id });
  });

  it("does not transfer a finalized revision when its material owner changes", async () => {
    const { material, revision } = await createMaterialWithInitialRevision({
      userId,
      title: "Finalized owner immutability fixture",
      kind: StudyMaterialKind.PDF,
    });
    await finalizeMaterialRevision({
      userId,
      materialId: material.id,
      materialRevisionId: revision.id,
      contentHash: "sha256:finalized-owner",
      byteSize: 1,
      pageCount: 1,
      storageBucket: "private-materials",
      storageKey: `${userId}/${revision.id}/owner.pdf`,
    });
    await prisma.studyMaterial.update({
      where: { id: material.id },
      data: { activeRevisionId: null },
    });

    await expect(
      prisma.studyMaterial.update({
        where: { id: material.id },
        data: { userId: otherUserId },
      }),
    ).rejects.toThrow(/immutable/i);
    expect(
      await prisma.materialRevision.findUnique({
        where: { id: revision.id },
        select: { userId: true },
      }),
    ).toEqual({ userId });
  });

  it("enforces revision-local hierarchy, evidence ownership, and batch limits in Postgres", async () => {
    const first = await createMaterialWithInitialRevision({
      userId,
      title: "First constraint fixture",
      kind: StudyMaterialKind.PDF,
    });
    const second = await createMaterialWithInitialRevision({
      userId,
      title: "Second constraint fixture",
      kind: StudyMaterialKind.PDF,
    });
    const firstSection = await prisma.materialSection.create({
      data: {
        userId,
        materialRevisionId: first.revision.id,
        ordinal: 0,
        title: "First section",
        normalizedTitle: "first section",
        headingPath: ["First section"],
      },
    });
    const firstSource = await prisma.sourceFile.create({
      data: {
        userId,
        materialRevisionId: first.revision.id,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.READY,
        originalName: "first.pdf",
      },
    });
    await prisma.studyMaterial.update({
      where: { id: first.material.id },
      data: { activeRevisionId: first.revision.id },
    });
    const emptyTargetMaterial = await prisma.studyMaterial.create({
      data: {
        userId,
        title: "Empty ownership target",
        kind: StudyMaterialKind.PDF,
      },
    });
    await expect(
      prisma.materialRevision.update({
        where: { id: first.revision.id },
        data: { materialId: emptyTargetMaterial.id },
      }),
    ).rejects.toThrow(/ownership/i);

    await expect(
      prisma.materialSection.create({
        data: {
          userId,
          materialRevisionId: second.revision.id,
          parentId: firstSection.id,
          ordinal: 0,
          title: "Cross-revision child",
          normalizedTitle: "cross revision child",
          headingPath: ["Cross-revision child"],
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.materialSection.create({
        data: {
          userId,
          materialRevisionId: second.revision.id,
          ordinal: 1,
          title: "Partial page range",
          normalizedTitle: "partial page range",
          pageStart: 2,
          pageEnd: null,
          headingPath: ["Partial page range"],
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.materialChunk.create({
        data: {
          userId,
          materialRevisionId: second.revision.id,
          materialSectionId: firstSection.id,
          ordinal: 0,
          text: "Cross-revision section evidence",
          tokenEstimate: 4,
          contentHash: "sha256:cross-section",
          locator: {},
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.materialChunk.create({
        data: {
          userId,
          materialRevisionId: second.revision.id,
          sourceFileId: firstSource.id,
          ordinal: 1,
          text: "Cross-revision source evidence",
          tokenEstimate: 4,
          contentHash: "sha256:cross-source",
          locator: {},
        },
      }),
    ).rejects.toThrow();

    const batch = await prisma.skillDraftBatch.create({
      data: {
        userId,
        materialRevisionId: second.revision.id,
        instruction: "Create ten skills",
        idempotencyKey: `${runId}_constraint_batch`,
        requestedCount: 10,
      },
    });
    const otherSkill = await prisma.skill.create({
      data: { userId: otherUserId, title: "Foreign skill", tags: [] },
    });
    await expect(
      prisma.skillDraftBatchItem.create({
        data: {
          userId,
          batchId: batch.id,
          skillId: otherSkill.id,
          ordinal: 0,
          targetKey: "foreign-skill",
          proposedTitle: "Foreign skill",
          proposedObjective: "Must be rejected",
          locator: {},
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.skillDraftBatchItem.create({
        data: {
          userId,
          batchId: batch.id,
          ordinal: 10,
          targetKey: "eleventh-skill",
          proposedTitle: "Eleventh skill",
          proposedObjective: "Must be rejected",
          locator: {},
        },
      }),
    ).rejects.toThrow();

    const ownedSkill = await prisma.skill.create({
      data: { userId, title: "Owned skill", tags: [] },
    });
    const ownedItem = await prisma.skillDraftBatchItem.create({
      data: {
        userId,
        batchId: batch.id,
        skillId: ownedSkill.id,
        ordinal: 9,
        targetKey: "owned-skill",
        proposedTitle: "Owned skill",
        proposedObjective: "Remains after skill deletion",
        locator: {},
      },
    });
    await expect(
      prisma.skill.update({
        where: { id: ownedSkill.id },
        data: { userId: otherUserId },
      }),
    ).rejects.toThrow();
    await prisma.skill.delete({ where: { id: ownedSkill.id } });
    expect(
      await prisma.skillDraftBatchItem.findUnique({
        where: { id: ownedItem.id },
        select: { skillId: true },
      }),
    ).toEqual({ skillId: null });
  });

  it("keeps material-owned files out of quick-upload recovery and controls", async () => {
    const { revision } = await createMaterialWithInitialRevision({
      userId,
      title: "Recovery isolation fixture",
      kind: StudyMaterialKind.PDF,
    });
    const now = new Date("2026-07-09T12:00:00.000Z");
    const sourceFile = await prisma.sourceFile.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.FAILED,
        originalName: "material-owned.pdf",
        storageBucket: "private-materials",
        storageKey: `${userId}/${revision.id}/original.pdf`,
        metadata: { errorMessage: "Fixture failure" },
      },
    });

    expect(await getSkillCreationSourceRecoveryItems({ userId, now })).not.toContainEqual(
      expect.objectContaining({ id: sourceFile.id }),
    );
    expect((await getSkillsLibrary({ userId, now })).sourceProcessing).not.toContainEqual(
      expect.objectContaining({ id: sourceFile.id }),
    );
    await expect(
      requeueSourceUploadDraft({ userId, sourceFileId: sourceFile.id, now }),
    ).resolves.toMatchObject({ status: "not-found" });
    await expect(
      dismissFailedSourceUpload({ userId, sourceFileId: sourceFile.id, now }),
    ).resolves.toMatchObject({ status: "not-found" });
  });

  it("keeps material-owned files out of quick-upload batch queue and worker paths", async () => {
    const { revision } = await createMaterialWithInitialRevision({
      userId,
      title: "Batch upload isolation fixture",
      kind: StudyMaterialKind.PDF,
    });
    const deletedKeys: string[] = [];
    const storage: SourceUploadStorage = {
      bucketName: "private-materials",
      async createPresignedUploadUrl() {
        throw new Error("not used");
      },
      async headObject() {
        throw new Error("fixture object is unavailable");
      },
      async getObjectBytes() {
        throw new Error("fixture object is unavailable");
      },
      async listObjects() {
        return [];
      },
      async deleteObject({ key }) {
        deletedKeys.push(key);
      },
    };
    const materialSource = await prisma.sourceFile.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.DRAFT,
        originalName: "reusable-material.pdf",
        mimeType: "application/pdf",
        storageBucket: storage.bucketName,
        storageKey: `${userId}/${revision.id}/material.pdf`,
      },
    });
    const quickSource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.DRAFT,
        originalName: "quick-source.pdf",
        mimeType: "application/pdf",
        storageBucket: storage.bucketName,
        storageKey: `${userId}/quick-source.pdf`,
      },
    });

    await expect(
      completeSourceUploadDrafts({
        userId,
        sourceFileId: quickSource.id,
        sourceFileIds: [quickSource.id, materialSource.id],
        now: new Date("2026-07-09T13:00:00.000Z"),
        storage,
      }),
    ).resolves.toMatchObject({ status: "not-found" });
    expect(await prisma.sourceFile.findUnique({ where: { id: materialSource.id } })).toMatchObject({
      status: SourceFileStatus.DRAFT,
      storageKey: materialSource.storageKey,
    });
    expect(deletedKeys).not.toContain(materialSource.storageKey);

    const workerQuickSource = await prisma.sourceFile.create({
      data: {
        userId,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.UPLOADED,
        originalName: "queued-quick-source.pdf",
        mimeType: "application/pdf",
        storageBucket: storage.bucketName,
        storageKey: `${userId}/queued-quick-source.pdf`,
      },
    });
    await prisma.sourceFile.update({
      where: { id: materialSource.id },
      data: { status: SourceFileStatus.UPLOADED },
    });
    await expect(
      runQueuedSourceUploadDraftJob({
        userId,
        sourceFileId: workerQuickSource.id,
        sourceFileIds: [workerQuickSource.id, materialSource.id],
        now: new Date("2026-07-09T13:01:00.000Z"),
        storage,
      }),
    ).resolves.toMatchObject({ status: "not-found" });
    expect(await prisma.sourceFile.findUnique({ where: { id: materialSource.id } })).toMatchObject({
      status: SourceFileStatus.UPLOADED,
      storageKey: materialSource.storageKey,
    });
    expect(deletedKeys).not.toContain(materialSource.storageKey);
  });

  it("makes draft batches idempotent and rejects key reuse for a different request", async () => {
    const material = await prisma.studyMaterial.findFirstOrThrow({
      where: { userId, title: "Practical Spanish Grammar" },
    });
    const revision = await prisma.materialRevision.findFirstOrThrow({
      where: { materialId: material.id, userId },
    });
    const input = {
      userId,
      materialRevisionId: revision.id,
      instruction: "Make the first concept in chapter four.",
      idempotencyKey: `${runId}_batch_request_1`,
    };

    const first = await createIdempotentDraftBatch(input);
    const retry = await createIdempotentDraftBatch(input);
    expect(retry.id).toBe(first.id);

    await expect(
      createIdempotentDraftBatch({
        ...input,
        instruction: "Make the second concept in chapter four.",
      }),
    ).rejects.toThrow(/different material request/i);
  });

  it("rejects draft batches for revisions that are not ready", async () => {
    const pending = await createMaterialWithInitialRevision({
      userId,
      title: "Pending batch fixture",
      kind: StudyMaterialKind.PDF,
    });

    await expect(
      createIdempotentDraftBatch({
        userId,
        materialRevisionId: pending.revision.id,
        instruction: "Create a skill from this unfinished revision.",
        idempotencyKey: `${runId}_pending_batch`,
      }),
    ).rejects.toThrow(/ready/i);
  });

  it("does not delete a reusable material source when a skill is unlinked or deleted", async () => {
    const material = await prisma.studyMaterial.findFirstOrThrow({
      where: { userId, title: "Practical Spanish Grammar" },
    });
    const revision = await prisma.materialRevision.findFirstOrThrow({
      where: { materialId: material.id, userId },
    });
    const sourceFile = await prisma.sourceFile.findFirstOrThrow({
      where: {
        userId,
        materialRevisionId: revision.id,
      },
    });
    const firstSkill = await prisma.skill.create({
      data: { userId, title: "Direct object pronouns", tags: [], status: SkillStatus.DRAFT },
    });
    const firstRef = await prisma.skillSourceRef.create({
      data: { userId, skillId: firstSkill.id, sourceFileId: sourceFile.id },
    });
    const deletedObjects: string[] = [];

    const unlinked = await removeSkillSource({
      userId,
      skillId: firstSkill.id,
      sourceRefId: firstRef.id,
      deleteStoredObject: async ({ key }) => {
        deletedObjects.push(key);
      },
    });
    expect(unlinked).toMatchObject({ status: "removed", sourceFileDeleted: false });
    expect(deletedObjects).toEqual([]);
    expect(await prisma.sourceFile.count({ where: { id: sourceFile.id } })).toBe(1);

    const secondSkill = await prisma.skill.create({
      data: { userId, title: "Pronoun placement", tags: [], status: SkillStatus.DRAFT },
    });
    await prisma.skillSourceRef.create({
      data: { userId, skillId: secondSkill.id, sourceFileId: sourceFile.id },
    });
    const deleted = await deleteSkillPermanently({
      userId,
      skillId: secondSkill.id,
      confirmationTitle: secondSkill.title,
      deleteStoredObject: async ({ key }) => {
        deletedObjects.push(key);
      },
    });
    expect(deleted).toMatchObject({ status: "deleted", deletedSourceFileIds: [] });
    expect(deletedObjects).toEqual([]);
    expect(await prisma.sourceFile.count({ where: { id: sourceFile.id } })).toBe(1);
  });

  it("creates one deletion tombstone per owned material and preserves linked skills", async () => {
    const material = await prisma.studyMaterial.findFirstOrThrow({
      where: { userId, title: "Practical Spanish Grammar" },
    });
    const revision = await prisma.materialRevision.findFirstOrThrow({
      where: { materialId: material.id, userId },
    });
    const sourceFile = await prisma.sourceFile.findFirstOrThrow({
      where: { materialRevisionId: revision.id, userId },
    });
    const linkedSkill = await prisma.skill.create({
      data: { userId, title: "Chapter four review", tags: [], status: SkillStatus.ACTIVE },
    });
    await prisma.skillSourceRef.create({
      data: { userId, skillId: linkedSkill.id, sourceFileId: sourceFile.id },
    });

    expect(
      await requestMaterialDeletion({
        userId: otherUserId,
        materialId: material.id,
        confirmationTitle: material.title,
      }),
    ).toMatchObject({ status: "not-found" });

    const queued = await requestMaterialDeletion({
      userId,
      materialId: material.id,
      confirmationTitle: material.title,
    });
    const retry = await requestMaterialDeletion({
      userId,
      materialId: material.id,
      confirmationTitle: material.title,
    });
    expect(queued).toMatchObject({ status: "queued", alreadyQueued: false });
    expect(retry).toMatchObject({ status: "queued", alreadyQueued: true });
    if (queued.status !== "queued" || retry.status !== "queued") {
      throw new Error("expected queued deletion results");
    }
    expect(retry.cleanupJobId).toBe(queued.cleanupJobId);
    expect(
      await prisma.studyMaterial.findUnique({ where: { id: material.id }, select: { status: true } }),
    ).toEqual({ status: StudyMaterialStatus.DELETING });
    expect(await prisma.skill.count({ where: { id: linkedSkill.id } })).toBe(1);
  });

  it.each([
    MaterialRevisionStatus.PENDING_UPLOAD,
    MaterialRevisionStatus.QUEUED,
    MaterialRevisionStatus.PROCESSING,
    MaterialRevisionStatus.READY,
    MaterialRevisionStatus.FAILED,
  ])("allows deletion while a material revision is %s", async (revisionStatus) => {
    const material = await prisma.studyMaterial.create({
      data: {
        userId,
        title: `Delete ${revisionStatus.toLowerCase()} material`,
        kind: StudyMaterialKind.PDF,
        revisions: {
          create: {
            revisionNumber: 1,
            status: revisionStatus,
          },
        },
      },
      include: { revisions: true },
    });

    await expect(
      requestMaterialDeletion({
        userId,
        materialId: material.id,
        confirmationTitle: material.title,
      }),
    ).resolves.toMatchObject({ status: "queued", alreadyQueued: false });
    await expect(
      prisma.materialRevision.findUniqueOrThrow({
        where: { id: material.revisions[0].id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: MaterialRevisionStatus.DELETING });
  });

  it("blocks direct deletion of active finalized revisions and their materials", async () => {
    const { material, revision } = await createMaterialWithInitialRevision({
      userId,
      title: "Protected finalized snapshot fixture",
      kind: StudyMaterialKind.PDF,
    });
    await finalizeMaterialRevision({
      userId,
      materialId: material.id,
      materialRevisionId: revision.id,
      contentHash: "sha256:protected-finalized-snapshot",
      byteSize: 1_024,
      pageCount: 1,
      storageBucket: "private-materials",
      storageKey: `${userId}/${revision.id}/protected.pdf`,
    });

    await expect(
      prisma.materialRevision.delete({ where: { id: revision.id } }),
    ).rejects.toThrow(/deletion workflow/i);
    await expect(
      prisma.studyMaterial.delete({ where: { id: material.id } }),
    ).rejects.toThrow(/deletion workflow/i);
    expect(await prisma.materialRevision.count({ where: { id: revision.id } })).toBe(1);
    expect(await prisma.studyMaterial.count({ where: { id: material.id } })).toBe(1);
  });

  it("allows account deletion to cascade through finalized material snapshots", async () => {
    const cascadeUserId = `${runId}_cascade_owner`;
    await prisma.user.create({
      data: { id: cascadeUserId, email: `${cascadeUserId}@example.com` },
    });
    const { material, revision } = await createMaterialWithInitialRevision({
      userId: cascadeUserId,
      title: "Cascade cleanup fixture",
      kind: StudyMaterialKind.PDF,
    });
    const source = await prisma.sourceFile.create({
      data: {
        userId: cascadeUserId,
        materialRevisionId: revision.id,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.READY,
        originalName: "cascade.pdf",
      },
    });
    const section = await prisma.materialSection.create({
      data: {
        userId: cascadeUserId,
        materialRevisionId: revision.id,
        ordinal: 0,
        title: "Cascade section",
        normalizedTitle: "cascade section",
        headingPath: ["Cascade section"],
      },
    });
    await prisma.materialChunk.create({
      data: {
        userId: cascadeUserId,
        materialRevisionId: revision.id,
        materialSectionId: section.id,
        sourceFileId: source.id,
        ordinal: 0,
        text: "Cascade evidence remains immutable until its owner is deleted.",
        tokenEstimate: 9,
        contentHash: "sha256:cascade-evidence",
        locator: {},
      },
    });
    await finalizeMaterialRevision({
      userId: cascadeUserId,
      materialId: material.id,
      materialRevisionId: revision.id,
      contentHash: "sha256:cascade-revision",
      byteSize: 1_024,
      pageCount: 1,
      storageBucket: "private-materials",
      storageKey: `${cascadeUserId}/${revision.id}/cascade.pdf`,
    });

    await expect(prisma.user.delete({ where: { id: cascadeUserId } })).resolves.toBeDefined();
    expect(await prisma.studyMaterial.count({ where: { id: material.id } })).toBe(0);
  });
});
