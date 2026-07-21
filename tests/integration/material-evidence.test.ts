import { randomUUID } from "node:crypto";

import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  MaterialPageTextStatus,
  SourceFileKind,
  SourceFileStatus,
  StudyMaterialKind,
  type SourceFile,
} from "@/generated/prisma/client";
import {
  ensureMaterialPageOcr,
  loadLocalizedMaterialEvidence,
} from "@/lib/materials/evidence";
import { planMaterialSkills } from "@/lib/materials/batches";
import {
  createMaterialWithInitialRevision,
  finalizeMaterialRevision,
} from "@/lib/materials/lifecycle";
import { getPrisma } from "@/lib/prisma";
import type { SourceObjectStorage } from "@/lib/storage/s3";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `material_evidence_${randomUUID()}`;

describeDatabase("localized material OCR evidence", () => {
  const prisma = getPrisma();
  const userId = `${runId}_owner`;
  let materialId = "";
  let materialRevisionId = "";
  let materialSectionId = "";
  let seedChunkId = "";
  let sourceFile: SourceFile;
  let pdfBytes = Buffer.alloc(0);

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
    const document = await PDFDocument.create();
    for (let page = 0; page < 10; page += 1) {
      document.addPage([500 + page, 700]);
    }
    pdfBytes = Buffer.from(await document.save());
    const { material, revision } = await createMaterialWithInitialRevision({
      userId,
      title: "Scanned grammar workbook",
      kind: StudyMaterialKind.PDF,
    });
    materialId = material.id;
    materialRevisionId = revision.id;
    const section = await prisma.materialSection.create({
      data: {
        userId,
        materialRevisionId,
        ordinal: 0,
        level: 1,
        title: "Document",
        normalizedTitle: "document",
        pageStart: 1,
        pageEnd: 10,
        headingPath: ["Document"],
      },
    });
    materialSectionId = section.id;
    sourceFile = await prisma.sourceFile.create({
      data: {
        userId,
        materialRevisionId,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.READY,
        originalName: "scanned.pdf",
        mimeType: "application/pdf",
        storageBucket: "test-materials",
        storageKey: `${runId}/scanned.pdf`,
      },
    });
    await prisma.materialPage.createMany({
      data: Array.from({ length: 10 }, (_, index) => ({
        userId,
        materialRevisionId,
        pageNumber: index + 1,
        textStatus: MaterialPageTextStatus.NEEDS_OCR,
        contentHash: `visual:${index + 1}`,
      })),
    });
    const seedChunk = await prisma.materialChunk.create({
      data: {
        userId,
        materialRevisionId,
        materialSectionId,
        sourceFileId: sourceFile.id,
        ordinal: 0,
        text: "The selected scanned pages contain the visual grammar evidence.",
        tokenEstimate: 12,
        contentHash: `seed:${runId}`,
        headingText: "Document",
        locator: { version: 1, kind: "pdf", pageRange: { start: 1, end: 10 } },
      },
    });
    seedChunkId = seedChunk.id;
    await finalizeMaterialRevision({
      userId,
      materialId: material.id,
      materialRevisionId,
      contentHash: `sha256:${runId}`,
      byteSize: pdfBytes.byteLength,
      pageCount: 10,
      storageBucket: "test-materials",
      storageKey: `${runId}/scanned.pdf`,
    });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("OCRs selected scanned pages in bounded cached groups without mutating snapshot chunks", async () => {
    const generator = vi.fn(async ({ pageNumbers }: { pageNumbers: number[] }) => ({
      pages: pageNumbers.map((pageNumber) => ({
        pageNumber,
        text: `Scanned page ${pageNumber} explains a grounded grammar concept.`,
      })),
    }));
    const storage = createStorage(pdfBytes);
    const first = await ensureMaterialPageOcr({
      userId,
      materialRevisionId,
      sourceFile,
      pageRanges: [{ start: 1, end: 10 }],
      storage,
      ocrGenerator: generator,
      now: new Date("2026-07-09T15:00:00.000Z"),
    });

    expect(first).toMatchObject({ status: "processed", processedPageCount: 8 });
    expect(generator.mock.calls[0][0].pageNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(
      prisma.materialPage.count({
        where: { userId, materialRevisionId, textStatus: MaterialPageTextStatus.OCR_READY },
      }),
    ).resolves.toBe(8);
    await expect(
      prisma.materialChunk.count({ where: { userId, materialRevisionId } }),
    ).resolves.toBe(1);

    const second = await ensureMaterialPageOcr({
      userId,
      materialRevisionId,
      sourceFile,
      pageRanges: [{ start: 1, end: 10 }],
      storage,
      ocrGenerator: generator,
      now: new Date("2026-07-09T15:01:00.000Z"),
    });
    expect(second).toMatchObject({ status: "processed", processedPageCount: 2 });
    expect(generator.mock.calls[1][0].pageNumbers).toEqual([9, 10]);

    const evidence = await loadLocalizedMaterialEvidence({
      userId,
      storage,
      sourceRefs: [
        {
          locator: {
            version: 1,
            materialRevisionId,
            materialSectionIds: [materialSectionId],
            evidenceChunkIds: [seedChunkId],
            source: { kind: "pdf", pageRanges: [{ start: 1, end: 2 }] },
          },
          sourceFile,
        },
      ],
    });
    expect(evidence.sourceContext).toContain("Scanned page 1 explains");
    expect(evidence.sourceContext).toContain("Visual page 2");
    expect(evidence.sourceMedia).toHaveLength(1);
    await expect(PDFDocument.load(evidence.sourceMedia[0].bytes)).resolves.toHaveProperty(
      "getPageCount",
    );
    expect((await PDFDocument.load(evidence.sourceMedia[0].bytes)).getPageCount()).toBe(2);

    const pageTwo = await prisma.materialPage.findFirstOrThrow({
      where: { userId, materialRevisionId, pageNumber: 2 },
      select: { id: true },
    });
    const pageEvidenceId = `material-page:${pageTwo.id}`;
    const planScope = vi.fn(async (planningInput: { chunks: Array<{ id: string; text: string }> }) => {
      const ocrChunk = planningInput.chunks.find((chunk) => chunk.id === pageEvidenceId);
      expect(ocrChunk?.text).toContain("Scanned page 2 explains");
      return {
        resolutionStatus: "resolved" as const,
        resolvedScopeLabel: "Scanned page 2",
        clarification: null,
        warnings: [],
        items: [
          {
            key: "scanned-page-two",
            title: "Scanned page two grammar",
            objective: "Apply the grammar concept explained on scanned page two.",
            materialSectionIds: [materialSectionId],
            evidenceChunkIds: [pageEvidenceId],
          },
        ],
      };
    });
    const planned = await planMaterialSkills({
      userId,
      input: {
        materialId,
        materialRevisionId,
        instruction: "Make a skill from the grammar concept on scanned page 2.",
        idempotencyKey: `${runId}_ocr_planning`,
      },
      now: new Date("2026-07-09T15:02:00.000Z"),
      aiSetup: {
        model: "fixture-model",
        planScope,
        async generateDraft() {
          throw new Error("not used");
        },
        async verifyDraft() {
          throw new Error("not used");
        },
      },
      embeddingGenerator: null,
      ocrGenerator: null,
    });
    expect(planned).toMatchObject({
      status: "planned",
      plan: {
        items: [
          {
            evidenceChunkIds: [pageEvidenceId],
            locator: { source: { kind: "pdf", pageRanges: [{ start: 2, end: 2 }] } },
          },
        ],
      },
    });

    const pageEvidence = await loadLocalizedMaterialEvidence({
      userId,
      storage,
      sourceRefs: [
        {
          locator: {
            version: 1,
            materialRevisionId,
            materialSectionIds: [materialSectionId],
            evidenceChunkIds: [pageEvidenceId],
            source: { kind: "pdf", pageRanges: [{ start: 2, end: 2 }] },
          },
          sourceFile,
        },
      ],
    });
    expect(pageEvidence.sourceContext).toContain("Scanned page 2 explains");
  });

  it("lets only one concurrent worker claim each OCR page", async () => {
    await prisma.materialPage.updateMany({
      where: { userId, materialRevisionId, pageNumber: { in: [1, 2] } },
      data: {
        textStatus: MaterialPageTextStatus.NEEDS_OCR,
        ocrText: null,
        metadata: {},
      },
    });
    const requestedPages: number[] = [];
    const generator = vi.fn(async ({ pageNumbers }: { pageNumbers: number[] }) => {
      requestedPages.push(...pageNumbers);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        pages: pageNumbers.map((pageNumber) => ({
          pageNumber,
          text: `Concurrent OCR page ${pageNumber}.`,
        })),
      };
    });
    const input = {
      userId,
      materialRevisionId,
      sourceFile,
      pageRanges: [{ start: 1, end: 2 }],
      storage: createStorage(pdfBytes),
      ocrGenerator: generator,
      now: new Date("2026-07-09T16:00:00.000Z"),
    };

    const results = await Promise.all([
      ensureMaterialPageOcr(input),
      ensureMaterialPageOcr(input),
    ]);

    expect(results.some((result) => result.status === "processed")).toBe(true);
    expect(requestedPages.sort((left, right) => left - right)).toEqual([1, 2]);
    await expect(
      prisma.materialPage.count({
        where: {
          userId,
          materialRevisionId,
          pageNumber: { in: [1, 2] },
          textStatus: MaterialPageTextStatus.OCR_READY,
        },
      }),
    ).resolves.toBe(2);
    await expect(
      prisma.materialChunk.count({ where: { userId, materialRevisionId } }),
    ).resolves.toBe(1);
  });
});

function createStorage(bytes: Buffer): SourceObjectStorage {
  return {
    bucketName: "test-materials",
    async createPresignedUploadUrl() {
      throw new Error("not used");
    },
    async headObject() {
      return { byteSize: bytes.byteLength, mimeType: "application/pdf" };
    },
    async getObjectBytes() {
      return bytes;
    },
    async listObjects() {
      return [];
    },
    async deleteObject() {},
  };
}
