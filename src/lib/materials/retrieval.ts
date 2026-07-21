import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";

export const MATERIAL_EMBEDDING_DIMENSIONS = 768;

export type MaterialChunkSearchResult = {
  id: string;
  materialRevisionId: string;
  materialSectionId: string | null;
  sourceFileId: string | null;
  ordinal: number;
  text: string;
  tokenEstimate: number;
  locator: Prisma.JsonValue;
  headingText: string | null;
  vectorScore: number;
  lexicalScore: number;
  score: number;
};

export function toPgVectorLiteral(embedding: readonly number[]): string {
  if (embedding.length !== MATERIAL_EMBEDDING_DIMENSIONS) {
    throw new Error(`Material embeddings must contain ${MATERIAL_EMBEDDING_DIMENSIONS} values.`);
  }

  if (embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("Material embeddings must contain only finite values.");
  }

  return `[${embedding.join(",")}]`;
}

export async function storeMaterialChunkEmbedding(input: {
  userId: string;
  materialRevisionId: string;
  chunkId: string;
  embedding: readonly number[];
}): Promise<boolean> {
  const prisma = getPrisma();
  const vector = toPgVectorLiteral(input.embedding);
  const updated = await prisma.$executeRaw`
    UPDATE "material_chunks"
    SET "embedding" = ${vector}::vector
    WHERE "id" = ${input.chunkId}
      AND "userId" = ${input.userId}
      AND "materialRevisionId" = ${input.materialRevisionId}
  `;

  return updated === 1;
}

export async function searchMaterialChunks(input: {
  userId: string;
  materialRevisionId: string;
  embedding: readonly number[];
  query: string;
  materialSectionIds?: readonly string[];
  limit?: number;
}): Promise<MaterialChunkSearchResult[]> {
  const prisma = getPrisma();
  const vector = toPgVectorLiteral(input.embedding);
  const limit = Math.max(1, Math.min(input.limit ?? 12, 50));
  const sectionFilter = input.materialSectionIds?.length
    ? Prisma.sql`AND "materialSectionId" IN (${Prisma.join(input.materialSectionIds)})`
    : Prisma.empty;

  return prisma.$queryRaw<MaterialChunkSearchResult[]>`
    WITH scored AS (
      SELECT
        "id",
        "materialRevisionId",
        "materialSectionId",
        "sourceFileId",
        "ordinal",
        "text",
        "tokenEstimate",
        "locator",
        "headingText",
        COALESCE(1 - ("embedding" <=> ${vector}::vector), 0)::double precision AS "vectorScore",
        CASE
          WHEN websearch_to_tsquery('simple', ${input.query}) @@ "searchText"
          THEN ts_rank_cd("searchText", websearch_to_tsquery('simple', ${input.query}))::double precision
          ELSE 0::double precision
        END AS "lexicalScore"
      FROM "material_chunks"
      WHERE "userId" = ${input.userId}
        AND "materialRevisionId" = ${input.materialRevisionId}
        ${sectionFilter}
    )
    SELECT
      *,
      ("vectorScore" * 0.8 + LEAST("lexicalScore", 1) * 0.2)::double precision AS "score"
    FROM scored
    ORDER BY "score" DESC, "ordinal" ASC
    LIMIT ${limit}
  `;
}

export async function searchMaterialChunksLexical(input: {
  userId: string;
  materialRevisionId: string;
  query: string;
  materialSectionIds?: readonly string[];
  limit?: number;
}): Promise<MaterialChunkSearchResult[]> {
  const prisma = getPrisma();
  const limit = Math.max(1, Math.min(input.limit ?? 24, 80));
  const sectionFilter = input.materialSectionIds?.length
    ? Prisma.sql`AND "materialSectionId" IN (${Prisma.join(input.materialSectionIds)})`
    : Prisma.empty;

  return prisma.$queryRaw<MaterialChunkSearchResult[]>`
    SELECT
      "id",
      "materialRevisionId",
      "materialSectionId",
      "sourceFileId",
      "ordinal",
      "text",
      "tokenEstimate",
      "locator",
      "headingText",
      0::double precision AS "vectorScore",
      CASE
        WHEN websearch_to_tsquery('simple', ${input.query}) @@ "searchText"
        THEN ts_rank_cd("searchText", websearch_to_tsquery('simple', ${input.query}))::double precision
        ELSE 0::double precision
      END AS "lexicalScore",
      CASE
        WHEN websearch_to_tsquery('simple', ${input.query}) @@ "searchText"
        THEN LEAST(ts_rank_cd("searchText", websearch_to_tsquery('simple', ${input.query})), 1)::double precision
        ELSE 0::double precision
      END AS "score"
    FROM "material_chunks"
    WHERE "userId" = ${input.userId}
      AND "materialRevisionId" = ${input.materialRevisionId}
      ${sectionFilter}
    ORDER BY "score" DESC, "ordinal" ASC
    LIMIT ${limit}
  `;
}
