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
  let materialRevisionId = "";
  let materialSectionId = "";
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
    materialRevisionId = revision.id;
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
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("OCRs selected scanned pages in bounded cached groups and creates retrievable chunks", async () => {
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
    ).resolves.toBe(8);

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

    const chunk = await prisma.materialChunk.findFirstOrThrow({
      where: { userId, materialRevisionId },
      orderBy: { ordinal: "asc" },
    });
    const evidence = await loadLocalizedMaterialEvidence({
      userId,
      storage,
      sourceRefs: [
        {
          locator: {
            version: 1,
            materialRevisionId,
            materialSectionIds: [materialSectionId],
            evidenceChunkIds: [chunk.id],
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
