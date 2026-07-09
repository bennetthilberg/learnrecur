import { randomUUID } from "node:crypto";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MaterialRevisionStatus,
  SkillStatus,
  SourceFileStatus,
} from "@/generated/prisma/client";
import { queueMaterialDeletion, runMaterialCleanupJob } from "@/lib/materials/cleanup";
import {
  prepareMaterialPdf,
  queueMaterialPdfIngestion,
  queueWebsiteMaterialImport,
  queueWebsiteMaterialRefresh,
  runMaterialIngestionJob,
} from "@/lib/materials/ingestion";
import { getMaterialDetail, getMaterialLibrary } from "@/lib/materials/library";
import { MATERIAL_EMBEDDING_DIMENSIONS } from "@/lib/materials/retrieval";
import { getPrisma } from "@/lib/prisma";
import type { SourceObjectStorage } from "@/lib/storage/s3";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `material_ingestion_${randomUUID()}`;

describeDatabase("material ingestion", () => {
  const prisma = getPrisma();
  const userId = `${runId}_owner`;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("prepares, verifies, and indexes a PDF while caching pages that need OCR", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    document.addPage([612, 792]).drawText(
      "Chapter 4 Direct object pronouns replace nouns receiving an action in a sentence.",
      { x: 48, y: 720, size: 12, font },
    );
    document.addPage([612, 792]);
    const bytes = Buffer.from(await document.save());
    const storage = createMemoryStorage();

    const prepared = await prepareMaterialPdf({
      userId,
      now: new Date(),
      storage,
      input: {
        title: "Practical Spanish Grammar",
        originalName: "spanish-grammar.pdf",
        mimeType: "application/pdf",
        byteSize: bytes.byteLength,
      },
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") {
      throw new Error("expected prepared upload");
    }
    storage.objects.set(storage.lastPreparedKey, bytes);

    const sentEvents: string[] = [];
    const queued = await queueMaterialPdfIngestion({
      userId,
      materialRevisionId: prepared.materialRevisionId,
      now: new Date(),
      storage,
      eventSender: {
        async sendMaterialIngestionRequested(payload) {
          sentEvents.push(payload.materialRevisionId);
        },
      },
    });
    expect(queued.status).toBe("queued");
    expect(sentEvents).toEqual([prepared.materialRevisionId]);

    const result = await runMaterialIngestionJob({
      userId,
      materialRevisionId: prepared.materialRevisionId,
      storage,
      embeddingGenerator: async ({ texts }) =>
        texts.map((_, textIndex) =>
          Array.from({ length: MATERIAL_EMBEDDING_DIMENSIONS }, (_, index) =>
            index === textIndex % MATERIAL_EMBEDDING_DIMENSIONS ? 1 : 0,
          ),
        ),
    });
    expect(result).toMatchObject({ status: "ready", pageCount: 2 });

    const revision = await prisma.materialRevision.findUniqueOrThrow({
      where: { id: prepared.materialRevisionId },
      include: { chunks: true, sections: true, pages: true, sourceFiles: true },
    });
    expect(revision.status).toBe(MaterialRevisionStatus.READY);
    expect(revision.sections.length).toBeGreaterThan(0);
    expect(revision.chunks.length).toBeGreaterThan(0);
    expect(revision.pages).toEqual([
      expect.objectContaining({ pageNumber: 2, textStatus: "NEEDS_OCR" }),
    ]);
    expect(revision.sourceFiles[0].status).toBe(SourceFileStatus.READY);
  });

  it("snapshots selected same-origin website pages and builds URL locators", async () => {
    const storage = createMemoryStorage();
    const sentEvents: string[] = [];
    const queued = await queueWebsiteMaterialImport({
      userId,
      now: new Date(),
      storage,
      eventSender: {
        async sendMaterialIngestionRequested(payload) {
          sentEvents.push(payload.materialRevisionId);
        },
      },
      input: {
        title: "Open Grammar",
        sourceUrl: "https://books.example/open-grammar",
        selectedUrls: [
          "https://books.example/chapter-1",
          "https://books.example/chapter-2",
        ],
      },
    });
    expect(queued.status).toBe("queued");
    if (queued.status !== "queued") {
      throw new Error("expected queued website import");
    }

    const result = await runMaterialIngestionJob({
      userId,
      materialRevisionId: queued.materialRevisionId,
      storage,
      resolveHostname: async () => ["93.184.216.34"],
      fetchResource: async (url) => ({
        url,
        contentType: "text/html",
        bytes: Buffer.from(`
          <html><head><title>Open Grammar</title></head><body>
            <main><h1 id="topic">${url.endsWith("1") ? "Noun agreement" : "Verb agreement"}</h1>
            <p>Agreement rules connect grammatical forms in complete sentences. This chapter
            provides several concrete examples and short explanations for practice.</p></main>
          </body></html>`),
      }),
      embeddingGenerator: null,
    });
    expect(result).toMatchObject({ status: "ready", pageCount: 2 });
    expect(sentEvents).toEqual([queued.materialRevisionId]);
    expect(storage.puts).toHaveLength(1);

    const revision = await prisma.materialRevision.findUniqueOrThrow({
      where: { id: queued.materialRevisionId },
      include: { chunks: true, sections: true },
    });
    expect(revision.status).toBe(MaterialRevisionStatus.READY);
    expect(revision.sections.map((section) => section.url)).toEqual([
      "https://books.example/chapter-1",
      "https://books.example/chapter-2",
    ]);
    expect(revision.chunks[0].locator).toMatchObject({
      kind: "web",
      url: "https://books.example/chapter-1",
    });
  });

  it("refreshes a website into a new immutable revision without moving existing links", async () => {
    const material = await prisma.studyMaterial.findFirstOrThrow({
      where: { userId, title: "Open Grammar" },
      include: { activeRevision: { include: { sourceFiles: true } } },
    });
    const activeRevisionId = material.activeRevisionId;
    const sourceFile = material.activeRevision?.sourceFiles[0];
    if (!activeRevisionId || !sourceFile) {
      throw new Error("expected active website revision");
    }
    const skill = await prisma.skill.create({
      data: { userId, title: "Web revision link", tags: [], status: SkillStatus.DRAFT },
    });
    await prisma.skillSourceRef.create({
      data: { userId, skillId: skill.id, sourceFileId: sourceFile.id },
    });
    const refreshed = await queueWebsiteMaterialRefresh({
      userId,
      materialId: material.id,
      now: new Date(),
      storage: createMemoryStorage(),
      eventSender: { async sendMaterialIngestionRequested() {} },
    });
    expect(refreshed).toMatchObject({ status: "queued" });
    if (refreshed.status !== "queued") {
      throw new Error("expected queued refresh");
    }
    const revisions = await prisma.materialRevision.findMany({
      where: { materialId: material.id },
      orderBy: { revisionNumber: "asc" },
    });
    expect(revisions.map((revision) => revision.revisionNumber)).toEqual([1, 2]);
    const detail = await getMaterialDetail({ userId, materialId: material.id });
    expect(detail?.activeRevision?.id).toBe(activeRevisionId);
    expect(detail?.currentRevision).toMatchObject({
      id: refreshed.materialRevisionId,
      status: MaterialRevisionStatus.QUEUED,
    });
    expect(
      (await getMaterialLibrary({ userId })).find((item) => item.id === material.id),
    ).toMatchObject({
      revisionNumber: 2,
      revisionStatus: MaterialRevisionStatus.QUEUED,
      linkedSkillCount: 1,
    });
    expect(
      await prisma.skillSourceRef.findFirstOrThrow({
        where: { skillId: skill.id },
        select: { sourceFile: { select: { materialRevisionId: true } } },
      }),
    ).toEqual({ sourceFile: { materialRevisionId: activeRevisionId } });
  });

  it("deletes material objects and source links idempotently without deleting linked skills", async () => {
    const material = await prisma.studyMaterial.findFirstOrThrow({
      where: { userId, title: "Open Grammar" },
      include: { activeRevision: { include: { sourceFiles: true } } },
    });
    const sourceFile = material.activeRevision?.sourceFiles[0];
    if (!sourceFile) {
      throw new Error("expected material source");
    }
    const skill = await prisma.skill.create({
      data: { userId, title: "Agreement rules", tags: [], status: SkillStatus.ACTIVE },
    });
    await prisma.skillSourceRef.create({
      data: { userId, skillId: skill.id, sourceFileId: sourceFile.id },
    });
    const storage = createMemoryStorage();
    const cleanupEvents: Array<{ materialId: string; cleanupJobId: string }> = [];
    const queued = await queueMaterialDeletion({
      userId,
      materialId: material.id,
      confirmationTitle: material.title,
      now: new Date(),
      eventSender: {
        async sendMaterialCleanupRequested(payload) {
          cleanupEvents.push(payload);
        },
      },
    });
    expect(queued.status).toBe("queued");
    if (queued.status !== "queued") {
      throw new Error("expected queued cleanup");
    }

    expect(
      await runMaterialCleanupJob({
        userId,
        materialId: material.id,
        cleanupJobId: queued.cleanupJobId,
        storage,
      }),
    ).toMatchObject({ status: "deleted" });
    expect(await prisma.skill.count({ where: { id: skill.id } })).toBe(1);
    expect(await prisma.skillSourceRef.count({ where: { skillId: skill.id } })).toBe(0);
    expect(
      await runMaterialCleanupJob({
        userId,
        materialId: material.id,
        cleanupJobId: queued.cleanupJobId,
        storage,
      }),
    ).toEqual({ status: "already-clean" });
  });

});

type MemoryStorage = SourceObjectStorage & {
  objects: Map<string, Buffer>;
  puts: Array<{ key: string; bytes: Buffer }>;
  deleted: string[];
  lastPreparedKey: string;
};

function createMemoryStorage(): MemoryStorage {
  const objects = new Map<string, Buffer>();
  const puts: Array<{ key: string; bytes: Buffer }> = [];
  const deleted: string[] = [];
  const storage: MemoryStorage = {
    bucketName: "test-materials",
    objects,
    puts,
    deleted,
    lastPreparedKey: "",
    async createPresignedUploadUrl({ key }) {
      storage.lastPreparedKey = key;
      return `https://uploads.example/${encodeURIComponent(key)}`;
    },
    async headObject({ key }) {
      const bytes = objects.get(key);
      return { byteSize: bytes?.byteLength ?? null, mimeType: bytes ? "application/pdf" : null };
    },
    async getObjectBytes({ key }) {
      const bytes = objects.get(key);
      if (!bytes) {
        throw new Error("missing test object");
      }
      return bytes;
    },
    async putObject({ key, bytes }) {
      objects.set(key, bytes);
      puts.push({ key, bytes });
    },
    async listObjects() {
      return [...objects.keys()];
    },
    async deleteObject({ key }) {
      objects.delete(key);
      deleted.push(key);
    },
  };
  return storage;
}
