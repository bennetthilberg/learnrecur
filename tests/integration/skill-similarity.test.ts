import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SkillStatus } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  SKILL_SIMILARITY_EMBEDDING_DIMENSIONS,
  findSimilarSkillsForUser,
  invalidateSkillSimilarityCache,
  type SkillSimilarityEmbeddingGenerator,
} from "@/lib/skills/similarity";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `skill_similarity_${randomUUID()}`;

describeDatabase("skill similarity persistence", () => {
  const prisma = getPrisma();
  const ownedUserIds: string[] = [];

  async function createUser(label: string) {
    const userId = `${runId}_${label}`;
    ownedUserIds.push(userId);
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.user.create({
      data: {
        id: userId,
        email: `${runId}_${label}@example.com`,
      },
    });
    return userId;
  }

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    if (ownedUserIds.length > 0) {
      await prisma.user.deleteMany({
        where: { id: { in: ownedUserIds } },
      });
    }
    await prisma.$disconnect();
  });

  it("keeps matches user-scoped and persists and invalidates cached vectors", async () => {
    const userId = await createUser("owner");
    const otherUserId = await createUser("other");
    const collection = await prisma.collection.create({
      data: {
        userId,
        name: "Biology",
      },
    });
    const matchingSkill = await prisma.skill.create({
      data: {
        userId,
        collectionId: collection.id,
        title: "Cellular respiration",
        objective: "Trace energy through glycolysis and the citric acid cycle",
        tags: ["biology", "cells"],
        status: SkillStatus.ACTIVE,
      },
    });
    await prisma.skill.create({
      data: {
        userId,
        title: "French verb conjugation",
        objective: "Conjugate common verbs in the present tense",
        tags: ["french"],
        status: SkillStatus.ARCHIVED,
      },
    });
    const otherUserSkill = await prisma.skill.create({
      data: {
        userId: otherUserId,
        title: "Energy release in cells",
        objective: "Explain how nutrients become usable cellular energy",
        tags: ["biology"],
        status: SkillStatus.PAUSED,
      },
    });
    const generator: SkillSimilarityEmbeddingGenerator = async ({ texts }) =>
      texts.map((text) => {
        const values = Array<number>(
          SKILL_SIMILARITY_EMBEDDING_DIMENSIONS,
        ).fill(0);
        values[text.includes("French verb conjugation") ? 1 : 0] = 1;
        return values;
      });

    const result = await findSimilarSkillsForUser({
      userId,
      candidates: [
        {
          key: "candidate",
          title: "How cells release usable energy",
          objective: "Explain ATP production from nutrients",
        },
      ],
      embeddingGenerator: generator,
      embeddingModel: "gemini-embedding-2",
      prisma,
    });

    expect(result.semanticStatus).toBe("used");
    expect(result.candidates[0]?.bestMatch).toMatchObject({
      confidence: "likely",
      skill: {
        id: matchingSkill.id,
        status: SkillStatus.ACTIVE,
        collectionName: "Biology",
        tags: ["biology", "cells"],
      },
    });
    expect(
      result.candidates[0]?.matches.some(
        (match) => match.skill.id === otherUserSkill.id,
      ),
    ).toBe(false);

    const cachedRows = await prisma.$queryRaw<
      Array<{
        id: string;
        model: string | null;
        fingerprint: string | null;
        hasEmbedding: boolean;
      }>
    >`
      SELECT
        "id",
        "similarityEmbeddingModel" AS "model",
        "similarityEmbeddingFingerprint" AS "fingerprint",
        ("similarityEmbedding" IS NOT NULL) AS "hasEmbedding"
      FROM "skills"
      WHERE "id" IN (${matchingSkill.id}, ${otherUserSkill.id})
      ORDER BY "id"
    `;
    const ownerCache = cachedRows.find(
      (row) => row.id === matchingSkill.id,
    );
    const otherUserCache = cachedRows.find(
      (row) => row.id === otherUserSkill.id,
    );
    expect(ownerCache).toMatchObject({
      model: "gemini-embedding-2",
      hasEmbedding: true,
    });
    expect(ownerCache?.fingerprint).toHaveLength(64);
    expect(otherUserCache).toMatchObject({
      model: null,
      fingerprint: null,
      hasEmbedding: false,
    });

    await expect(
      invalidateSkillSimilarityCache({
        userId: otherUserId,
        skillId: matchingSkill.id,
        prisma,
      }),
    ).resolves.toBe(false);
    await expect(
      invalidateSkillSimilarityCache({
        userId,
        skillId: matchingSkill.id,
        prisma,
      }),
    ).resolves.toBe(true);

    const invalidated = await prisma.$queryRaw<
      Array<{
        model: string | null;
        fingerprint: string | null;
        hasEmbedding: boolean;
      }>
    >`
      SELECT
        "similarityEmbeddingModel" AS "model",
        "similarityEmbeddingFingerprint" AS "fingerprint",
        ("similarityEmbedding" IS NOT NULL) AS "hasEmbedding"
      FROM "skills"
      WHERE "id" = ${matchingSkill.id}
    `;
    expect(invalidated).toEqual([
      {
        model: null,
        fingerprint: null,
        hasEmbedding: false,
      },
    ]);
  });
});
