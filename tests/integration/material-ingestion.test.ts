import { randomUUID } from "node:crypto";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MaterialRevisionStatus,
  SkillStatus,
  SourceFileKind,
  SourceFileStatus,
  StudyMaterialKind,
} from "@/generated/prisma/client";
import { queueMaterialDeletion, runMaterialCleanupJob } from "@/lib/materials/cleanup";
import {
  discardPreparedMaterialPdf,
  prepareMaterialPdf,
  queueMaterialPdfIngestion,
  queueWebsiteMaterialImport,
  queueWebsiteMaterialRefresh,
  retryMaterialIngestion,
  runMaterialIngestionJob,
} from "@/lib/materials/ingestion";
import { MATERIAL_QUEUE_STALE_AFTER_MS } from "@/lib/materials/ingestion-status";
import { getMaterialDetail, getMaterialLibrary } from "@/lib/materials/library";
import { MATERIAL_EMBEDDING_DIMENSIONS } from "@/lib/materials/retrieval";
import { getPrisma } from "@/lib/prisma";
import { prepareSourceUpload, queueSourceUploadDrafts } from "@/lib/skills/uploads";
import type { SourceObjectStorage } from "@/lib/storage/s3";
import { ALPHA_SOURCE_UPLOADS_PER_DAY, ALPHA_STORED_SOURCE_BYTES } from "@/lib/usage-limits";

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
        byteSize: String(bytes.byteLength),
      },
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") {
      throw new Error("expected prepared upload");
    }
    expect(storage.lastPreparedKey).toMatch(
      new RegExp(`^source-uploads/materials/${userId}/`),
    );
    expect(prepared.headers).toEqual({ "Content-Type": "application/pdf" });
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

  it("discards a prepared PDF when the direct upload does not finish", async () => {
    const storage = createMemoryStorage();
    const prepared = await prepareMaterialPdf({
      userId,
      now: new Date(),
      storage,
      input: {
        title: "Interrupted PDF upload",
        originalName: "interrupted.pdf",
        mimeType: "application/pdf",
        byteSize: "2048",
      },
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") {
      throw new Error("expected prepared upload");
    }

    await expect(
      discardPreparedMaterialPdf({
        userId,
        materialId: prepared.materialId,
        materialRevisionId: prepared.materialRevisionId,
        storage,
      }),
    ).resolves.toEqual({ status: "discarded" });
    expect(storage.deleted).toContain(storage.lastPreparedKey);
    expect(await prisma.studyMaterial.count({ where: { id: prepared.materialId } })).toBe(0);
  });

  it("requeues a stalled revision without requiring another upload", async () => {
    const now = new Date("2026-07-10T18:00:00.000Z");
    const material = await prisma.studyMaterial.create({
      data: {
        userId,
        title: "Stalled reusable PDF",
        kind: StudyMaterialKind.PDF,
        revisions: {
          create: {
            revisionNumber: 1,
            status: MaterialRevisionStatus.QUEUED,
            updatedAt: new Date(now.getTime() - MATERIAL_QUEUE_STALE_AFTER_MS),
          },
        },
      },
      include: { revisions: true },
    });
    const revision = material.revisions[0];
    const sentRevisionIds: string[] = [];

    const result = await retryMaterialIngestion({
      userId,
      materialRevisionId: revision.id,
      now,
      eventSender: {
        async sendMaterialIngestionRequested(payload) {
          sentRevisionIds.push(payload.materialRevisionId);
        },
      },
    });

    expect(result).toMatchObject({
      status: "queued",
      materialId: material.id,
      materialRevisionId: revision.id,
    });
    expect(sentRevisionIds).toEqual([revision.id]);
    await expect(
      prisma.materialRevision.findUniqueOrThrow({
        where: { id: revision.id },
        select: { status: true, updatedAt: true },
      }),
    ).resolves.toMatchObject({
      status: MaterialRevisionStatus.QUEUED,
      updatedAt: now,
    });
  });

  it("does not requeue a revision that is still within the worker pickup window", async () => {
    const now = new Date("2026-07-10T18:00:00.000Z");
    const material = await prisma.studyMaterial.create({
      data: {
        userId,
        title: "Fresh queued reusable PDF",
        kind: StudyMaterialKind.PDF,
        revisions: {
          create: {
            revisionNumber: 1,
            status: MaterialRevisionStatus.QUEUED,
            updatedAt: new Date(now.getTime() - MATERIAL_QUEUE_STALE_AFTER_MS + 1),
          },
        },
      },
      include: { revisions: true },
    });
    let eventCount = 0;

    await expect(
      retryMaterialIngestion({
        userId,
        materialRevisionId: material.revisions[0].id,
        now,
        eventSender: {
          async sendMaterialIngestionRequested() {
            eventCount += 1;
          },
        },
      }),
    ).resolves.toMatchObject({ status: "not-found" });
    expect(eventCount).toBe(0);
  });

  it("applies reusable PDF storage limits without consuming the quick-upload daily quota", async () => {
    const now = new Date();
    const quickUploadPrefix = `${runId}_quick_upload_`;
    await prisma.sourceFile.createMany({
      data: Array.from({ length: ALPHA_SOURCE_UPLOADS_PER_DAY }, (_, index) => ({
        userId,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.DRAFT,
        originalName: `${quickUploadPrefix}${index + 1}.pdf`,
        mimeType: "application/pdf",
        byteSize: 1,
        createdAt: now,
      })),
    });

    const storage = createMemoryStorage();
    try {
      const prepared = await prepareMaterialPdf({
        userId,
        now,
        storage,
        input: {
          title: "Reusable PDF after quick uploads",
          originalName: "reusable.pdf",
          mimeType: "application/pdf",
          byteSize: "2048",
        },
      });
      expect(prepared.status).toBe("prepared");
      if (prepared.status !== "prepared") {
        throw new Error("expected reusable PDF preparation");
      }
      await discardPreparedMaterialPdf({
        userId,
        materialId: prepared.materialId,
        materialRevisionId: prepared.materialRevisionId,
        storage,
      });
    } finally {
      await prisma.sourceFile.deleteMany({
        where: { userId, originalName: { startsWith: quickUploadPrefix } },
      });
    }

    const quotaMaterial = await prisma.studyMaterial.create({
      data: {
        userId,
        title: "Stored reusable PDF quota fixture",
        kind: StudyMaterialKind.PDF,
        revisions: {
          create: {
            revisionNumber: 1,
            sourceFiles: {
              create: {
                kind: SourceFileKind.PDF,
                status: SourceFileStatus.UPLOADED,
                originalName: "stored-material.pdf",
                mimeType: "application/pdf",
                byteSize: ALPHA_STORED_SOURCE_BYTES,
                storageBucket: "test-materials",
                storageKey: `materials/${userId}/stored-material.pdf`,
              },
            },
          },
        },
      },
    });

    try {
      await expect(
        prepareMaterialPdf({
          userId,
          now,
          storage,
          input: {
            title: "Over reusable storage quota",
            originalName: "over-quota.pdf",
            mimeType: "application/pdf",
            byteSize: "1",
          },
        }),
      ).resolves.toMatchObject({
        status: "not-prepared",
        message: expect.stringMatching(/250 MB/),
      });
    } finally {
      await prisma.studyMaterial.delete({ where: { id: quotaMaterial.id } });
    }
  });

  it("rejects a long PDF in quick create on the server", async () => {
    const document = await PDFDocument.create();
    for (let page = 0; page < 21; page += 1) {
      document.addPage();
    }
    const bytes = Buffer.from(await document.save());
    const storage = createMemoryStorage();
    const prepared = await prepareSourceUpload({
      userId,
      now: new Date(),
      storage,
      input: {
        originalName: "long-quick-create.pdf",
        mimeType: "application/pdf",
        byteSize: String(bytes.byteLength),
      },
    });
    expect(prepared.status).toBe("prepared");
    if (prepared.status !== "prepared") {
      throw new Error("expected prepared quick upload");
    }
    storage.objects.set(storage.lastPreparedKey, bytes);

    await expect(
      queueSourceUploadDrafts({
        userId,
        sourceFileId: prepared.sourceFileId,
        now: new Date(),
        storage,
        eventSender: { async sendSourceUploadDraftRequested() {} },
      }),
    ).resolves.toMatchObject({
      status: "not-queued",
      reason: "invalid-upload",
      message: expect.stringMatching(/over 20 pages.*Materials/i),
    });
    expect(await prisma.sourceFile.count({ where: { id: prepared.sourceFileId } })).toBe(0);
    expect(storage.deleted).toContain(prepared.objectKey);
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

  it("fetches large website selections in bounded concurrent groups", async () => {
    const storage = createMemoryStorage();
    const selectedUrls = Array.from(
      { length: 20 },
      (_, index) => `https://books.example/concurrent-chapter-${index + 1}`,
    );
    const queued = await queueWebsiteMaterialImport({
      userId,
      now: new Date(),
      storage,
      eventSender: { async sendMaterialIngestionRequested() {} },
      input: {
        title: "Concurrent website import",
        sourceUrl: "https://books.example/concurrent-book",
        selectedUrls,
      },
    });
    expect(queued.status).toBe("queued");
    if (queued.status !== "queued") {
      throw new Error("expected queued website import");
    }

    let inFlight = 0;
    let maximumInFlight = 0;
    const result = await runMaterialIngestionJob({
      userId,
      materialRevisionId: queued.materialRevisionId,
      storage,
      resolveHostname: async () => ["93.184.216.34"],
      fetchResource: async (url, options) => {
        expect(options?.maximumBytes).toBe(5 * 1024 * 1024);
        inFlight += 1;
        maximumInFlight = Math.max(maximumInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight -= 1;
        return {
          url,
          contentType: "text/html",
          bytes: Buffer.from(
            `<html><body><main><h1>${url.split("-").at(-1)}</h1><p>This chapter contains enough readable textbook content for a stable, bounded website import fixture.</p></main></body></html>`,
          ),
        };
      },
      embeddingGenerator: null,
    });

    expect(result).toMatchObject({ status: "ready", pageCount: 20 });
    expect(maximumInFlight).toBe(10);
    expect(
      (
        await prisma.materialSection.findMany({
          where: { materialRevisionId: queued.materialRevisionId },
          orderBy: { ordinal: "asc" },
          select: { url: true },
        })
      ).map((section) => section.url),
    ).toEqual(selectedUrls);
  });

  it("removes a website snapshot written after deletion begins", async () => {
    const storage = createMemoryStorage();
    const title = "Deleted during website snapshot";
    const queued = await queueWebsiteMaterialImport({
      userId,
      now: new Date(),
      storage,
      eventSender: { async sendMaterialIngestionRequested() {} },
      input: {
        title,
        sourceUrl: "https://books.example/deleted-book",
        selectedUrls: ["https://books.example/deleted-chapter"],
      },
    });
    expect(queued.status).toBe("queued");
    if (queued.status !== "queued") {
      throw new Error("expected queued website import");
    }

    const putObject = storage.putObject?.bind(storage);
    if (!putObject) {
      throw new Error("expected snapshot storage");
    }
    let writtenKey = "";
    storage.putObject = async (putInput) => {
      writtenKey = putInput.key;
      await queueMaterialDeletion({
        userId,
        materialId: queued.materialId,
        confirmationTitle: title,
        now: new Date(),
        eventSender: { async sendMaterialCleanupRequested() {} },
      });
      await putObject(putInput);
    };

    await expect(
      runMaterialIngestionJob({
        userId,
        materialRevisionId: queued.materialRevisionId,
        storage,
        resolveHostname: async () => ["93.184.216.34"],
        fetchResource: async (url) => ({
          url,
          contentType: "text/html",
          bytes: Buffer.from(
            "<html><body><main><h1>Deleted chapter</h1><p>This readable page is deleted while its private snapshot is being stored.</p></main></body></html>",
          ),
        }),
        embeddingGenerator: null,
      }),
    ).rejects.toThrow(/deleted/i);
    expect(writtenKey).not.toBe("");
    expect(storage.objects.has(writtenKey)).toBe(false);
    expect(storage.deleted).toContain(writtenKey);
  });

  it("does not create a website refresh revision when Inngest is unavailable", async () => {
    const material = await prisma.studyMaterial.findFirstOrThrow({
      where: { userId, title: "Open Grammar" },
    });
    const revisionCount = await prisma.materialRevision.count({
      where: { materialId: material.id },
    });
    const previousEnv = {
      NODE_ENV: process.env.NODE_ENV,
      INNGEST_DEV: process.env.INNGEST_DEV,
      INNGEST_EVENT_KEY: process.env.INNGEST_EVENT_KEY,
      INNGEST_SIGNING_KEY: process.env.INNGEST_SIGNING_KEY,
    };
    process.env.NODE_ENV = "production";
    delete process.env.INNGEST_DEV;
    delete process.env.INNGEST_EVENT_KEY;
    delete process.env.INNGEST_SIGNING_KEY;

    try {
      await expect(
        queueWebsiteMaterialRefresh({
          userId,
          materialId: material.id,
          now: new Date(),
          storage: createMemoryStorage(),
        }),
      ).resolves.toMatchObject({ status: "not-queued", message: expect.stringMatching(/Inngest/) });
      await expect(
        prisma.materialRevision.count({ where: { materialId: material.id } }),
      ).resolves.toBe(revisionCount);
    } finally {
      restoreEnv("NODE_ENV", previousEnv.NODE_ENV);
      restoreEnv("INNGEST_DEV", previousEnv.INNGEST_DEV);
      restoreEnv("INNGEST_EVENT_KEY", previousEnv.INNGEST_EVENT_KEY);
      restoreEnv("INNGEST_SIGNING_KEY", previousEnv.INNGEST_SIGNING_KEY);
    }
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

  it("restores a material when cleanup event delivery fails", async () => {
    const material = await prisma.studyMaterial.findFirstOrThrow({
      where: { userId, title: "Practical Spanish Grammar" },
      include: { activeRevision: true },
    });
    const activeRevision = material.activeRevision;
    if (!activeRevision) {
      throw new Error("expected active PDF revision");
    }

    await expect(
      queueMaterialDeletion({
        userId,
        materialId: material.id,
        confirmationTitle: material.title,
        now: new Date(),
        eventSender: {
          async sendMaterialCleanupRequested() {
            throw new Error("Inngest unavailable");
          },
        },
      }),
    ).resolves.toMatchObject({ status: "not-deleted", reason: "queue-unavailable" });
    await expect(
      prisma.studyMaterial.findUniqueOrThrow({
        where: { id: material.id },
        select: { status: true, activeRevisionId: true, cleanupJob: true },
      }),
    ).resolves.toMatchObject({
      status: material.status,
      activeRevisionId: activeRevision.id,
      cleanupJob: null,
    });
    await expect(
      prisma.materialRevision.findUniqueOrThrow({
        where: { id: activeRevision.id },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: activeRevision.status });
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

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
