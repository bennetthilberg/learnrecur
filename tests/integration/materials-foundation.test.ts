import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
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
import { removeSkillSource } from "@/lib/skills/sources";

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

    await finalizeMaterialRevision({
      userId,
      materialId: material.id,
      materialRevisionId: revision.id,
      contentHash: "sha256:spanish-revision-one",
      byteSize: 4_096,
      pageCount: 120,
      storageBucket: "private-materials",
      storageKey: `${userId}/${revision.id}/original.pdf`,
      processingMetadata: { parser: "fixture", storageKey: "must-not-export" },
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
      source: { kind: "pdf", pageRanges: [{ start: 48, end: 51 }] },
    } as const;
    const chunks = await Promise.all([
      prisma.materialChunk.create({
        data: {
          userId,
          materialRevisionId: revision.id,
          materialSectionId: section.id,
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
    expect(exported.export.materialChunks).toHaveLength(2);
    expect(JSON.stringify(exported.export)).not.toContain("must-not-export");
    expect(JSON.stringify(exported.export)).not.toContain("private-materials");
  });

  it("makes draft batches idempotent and rejects key reuse for a different request", async () => {
    const material = await prisma.studyMaterial.findFirstOrThrow({ where: { userId } });
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

  it("does not delete a reusable material source when a skill is unlinked or deleted", async () => {
    const material = await prisma.studyMaterial.findFirstOrThrow({ where: { userId } });
    const revision = await prisma.materialRevision.findFirstOrThrow({
      where: { materialId: material.id, userId },
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
    const material = await prisma.studyMaterial.findFirstOrThrow({ where: { userId } });
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
});
