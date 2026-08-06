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
});
