import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { StudyMaterialKind } from "@/generated/prisma/client";
import { createMaterialWithInitialRevision } from "@/lib/materials/lifecycle";
import { searchMaterialChunksLexical } from "@/lib/materials/retrieval";
import { getPrisma } from "@/lib/prisma";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `material_retrieval_${randomUUID()}`;

describeDatabase("material retrieval", () => {
  const prisma = getPrisma();
  const userId = `${runId}_owner`;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("keeps instructional index topics while excluding an actual book index", async () => {
    const { revision } = await createMaterialWithInitialRevision({
      userId,
      title: "Database systems handbook",
      kind: StudyMaterialKind.PDF,
    });
    const [lesson, bookIndex] = await Promise.all([
      prisma.materialSection.create({
        data: {
          userId,
          materialRevisionId: revision.id,
          ordinal: 0,
          title: "Database indexing",
          normalizedTitle: "database indexing",
          pageStart: 40,
          pageEnd: 45,
          headingPath: ["Database indexing"],
        },
      }),
      prisma.materialSection.create({
        data: {
          userId,
          materialRevisionId: revision.id,
          ordinal: 1,
          title: "Index",
          normalizedTitle: "index",
          pageStart: 300,
          pageEnd: 310,
          headingPath: ["Index"],
        },
      }),
    ]);
    const lessonChunkId = `${runId}_lesson`;
    const indexChunkId = `${runId}_book_index`;
    await prisma.materialChunk.createMany({
      data: [
        {
          id: lessonChunkId,
          userId,
          materialRevisionId: revision.id,
          materialSectionId: lesson.id,
          ordinal: 0,
          text: "A database index speeds queries by keeping lookup keys in a searchable order.",
          tokenEstimate: 14,
          contentHash: `sha256:${runId}:lesson`,
          headingText: lesson.title,
          locator: { kind: "pdf", pageRange: { start: 40, end: 40 } },
        },
        {
          id: indexChunkId,
          userId,
          materialRevisionId: revision.id,
          materialSectionId: bookIndex.id,
          ordinal: 1,
          text: "Database indexes, 40; query planning, 82.",
          tokenEstimate: 8,
          contentHash: `sha256:${runId}:book-index`,
          headingText: bookIndex.title,
          locator: { kind: "pdf", pageRange: { start: 300, end: 300 } },
        },
      ],
    });

    const matches = await searchMaterialChunksLexical({
      userId,
      materialRevisionId: revision.id,
      query: "database index",
      prefixMatching: true,
      prefixOperator: "or",
      minimumSectionPrefixMatches: 2,
      excludeLikelyBackMatter: true,
    });

    expect(matches.map((chunk) => chunk.id)).toContain(lessonChunkId);
    expect(matches.map((chunk) => chunk.id)).not.toContain(indexChunkId);
  });

  it("does not count answer-key chunks toward instructional section coverage", async () => {
    const { revision } = await createMaterialWithInitialRevision({
      userId,
      title: "Mixed-outline Spanish handbook",
      kind: StudyMaterialKind.PDF,
    });
    const mixedSection = await prisma.materialSection.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        ordinal: 0,
        title: "Part II",
        normalizedTitle: "part ii",
        pageStart: 20,
        pageEnd: 300,
        headingPath: ["Part II"],
      },
    });
    const teachingChunkId = `${runId}_mixed_ser_teaching`;
    await prisma.materialChunk.createMany({
      data: [
        {
          id: teachingChunkId,
          userId,
          materialRevisionId: revision.id,
          materialSectionId: mixedSection.id,
          ordinal: 0,
          text: "Ser identifies an essential characteristic.",
          tokenEstimate: 7,
          contentHash: `sha256:${runId}:mixed-ser`,
          headingText: mixedSection.title,
          locator: { kind: "pdf", pageRange: { start: 30, end: 30 } },
        },
        {
          id: `${runId}_mixed_answer_key`,
          userId,
          materialRevisionId: revision.id,
          materialSectionId: mixedSection.id,
          ordinal: 1,
          text: "Answer Key: estar exercise responses.",
          tokenEstimate: 7,
          contentHash: `sha256:${runId}:mixed-answer`,
          headingText: mixedSection.title,
          locator: { kind: "pdf", pageRange: { start: 290, end: 290 } },
        },
      ],
    });

    const matches = await searchMaterialChunksLexical({
      userId,
      materialRevisionId: revision.id,
      query: "ser estar",
      prefixMatching: true,
      prefixOperator: "or",
      minimumSectionPrefixMatches: 2,
      excludeLikelyBackMatter: true,
    });

    expect(matches.map((chunk) => chunk.id)).not.toContain(teachingChunkId);
    expect(matches).toEqual([]);
  });

  it("matches recovery alternatives without double-counting one topic concept", async () => {
    const { revision } = await createMaterialWithInitialRevision({
      userId,
      title: "Compatibility recovery handbook",
      kind: StudyMaterialKind.PDF,
    });
    const [ordinalLesson, oneConceptDecoy, matrixLesson] = await Promise.all([
      prisma.materialSection.create({
        data: {
          userId,
          materialRevisionId: revision.id,
          ordinal: 0,
          title: "Numeros ordinales",
          normalizedTitle: "numeros ordinales",
          pageStart: 10,
          pageEnd: 11,
          headingPath: ["Numeros ordinales"],
        },
      }),
      prisma.materialSection.create({
        data: {
          userId,
          materialRevisionId: revision.id,
          ordinal: 1,
          title: "Number forms",
          normalizedTitle: "number forms",
          pageStart: 20,
          pageEnd: 20,
          headingPath: ["Number forms"],
        },
      }),
      prisma.materialSection.create({
        data: {
          userId,
          materialRevisionId: revision.id,
          ordinal: 2,
          title: "Matrix index",
          normalizedTitle: "matrix index",
          pageStart: 30,
          pageEnd: 31,
          headingPath: ["Matrix index"],
        },
      }),
    ]);
    const ordinalChunkId = `${runId}_unaccented_ordinals`;
    const matrixChunkId = `${runId}_singular_index`;
    await prisma.materialChunk.createMany({
      data: [
        {
          id: ordinalChunkId,
          userId,
          materialRevisionId: revision.id,
          materialSectionId: ordinalLesson.id,
          ordinal: 0,
          text: "Numeros ordinales identify position in an ordered sequence.",
          tokenEstimate: 9,
          contentHash: `sha256:${runId}:unaccented-ordinals`,
          headingText: ordinalLesson.title,
          locator: { kind: "pdf", pageRange: { start: 10, end: 10 } },
        },
        {
          id: `${runId}_accent_decoy`,
          userId,
          materialRevisionId: revision.id,
          materialSectionId: oneConceptDecoy.id,
          ordinal: 1,
          text: "Número and numero are accented and unaccented spellings of one term.",
          tokenEstimate: 10,
          contentHash: `sha256:${runId}:accent-decoy`,
          headingText: oneConceptDecoy.title,
          locator: { kind: "pdf", pageRange: { start: 20, end: 20 } },
        },
        {
          id: matrixChunkId,
          userId,
          materialRevisionId: revision.id,
          materialSectionId: matrixLesson.id,
          ordinal: 2,
          text: "A matrix index identifies one position in the matrix.",
          tokenEstimate: 9,
          contentHash: `sha256:${runId}:matrix-index`,
          headingText: matrixLesson.title,
          locator: { kind: "pdf", pageRange: { start: 30, end: 30 } },
        },
      ],
    });

    const accentedMatches = await searchMaterialChunksLexical({
      userId,
      materialRevisionId: revision.id,
      query: "número|numero ordinal",
      prefixMatching: true,
      prefixOperator: "or",
      minimumSectionPrefixMatches: 2,
      excludeLikelyBackMatter: true,
    });
    expect(accentedMatches.map((chunk) => chunk.id)).toEqual([ordinalChunkId]);

    const irregularPluralMatches = await searchMaterialChunksLexical({
      userId,
      materialRevisionId: revision.id,
      query: "matrix index|indice",
      prefixMatching: true,
      prefixOperator: "or",
      minimumSectionPrefixMatches: 2,
      excludeLikelyBackMatter: true,
    });
    expect(irregularPluralMatches.map((chunk) => chunk.id)).toEqual([matrixChunkId]);
  });
});
