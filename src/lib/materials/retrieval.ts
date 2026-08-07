import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";

export const MATERIAL_EMBEDDING_DIMENSIONS = 768;

const STRONG_BACK_MATTER_SQL_PATTERN =
  "(^|[^[:alnum:]_])(answer[[:space:]]+key|answers?[[:space:]]+will[[:space:]]+vary|solutions?[[:space:]]+(key|manual)|front[[:space:]]+matter|table[[:space:]]+of[[:space:]]+contents)([^[:alnum:]_]|$)";
const GENERIC_BACK_MATTER_HEADING_SQL_PATTERN =
  "^[[:space:][:punct:]]*(contents|index|glossary|bibliography|references)[[:space:][:punct:]]*$";

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
  prefixMatching?: boolean;
  prefixOperator?: "and" | "or";
  minimumPrefixMatches?: number;
  minimumSectionPrefixMatches?: number;
  excludeLikelyBackMatter?: boolean;
}): Promise<MaterialChunkSearchResult[]> {
  const prisma = getPrisma();
  const limit = Math.max(1, Math.min(input.limit ?? 24, 80));
  const sectionFilter = input.materialSectionIds?.length
    ? Prisma.sql`AND "materialSectionId" IN (${Prisma.join(input.materialSectionIds)})`
    : Prisma.empty;
  const prefixQuery = input.prefixMatching
    ? toSimplePrefixTsQuery(input.query, input.prefixOperator)
    : null;
  const minimumPrefixGroups =
    input.prefixMatching &&
    (input.minimumPrefixMatches || input.minimumSectionPrefixMatches)
      ? simplePrefixTermGroups(input.query).map((group) =>
          group.map((token) => `${token}:*`).join(" | "),
        )
      : [];
  const minimumPrefixFilter = input.minimumPrefixMatches
    ? minimumPrefixGroups.length >= input.minimumPrefixMatches
      ? Prisma.sql`AND (
          SELECT COUNT(*)
          FROM unnest(ARRAY[${Prisma.join(minimumPrefixGroups)}]::text[]) AS recovery_group(query)
          WHERE "searchText" @@ to_tsquery('simple', recovery_group.query)
        ) >= ${input.minimumPrefixMatches}`
      : Prisma.sql`AND FALSE`
    : Prisma.empty;
  const sectionBackMatterFilter = input.excludeLikelyBackMatter
    ? Prisma.sql`AND NOT (
        COALESCE(section_chunk."headingText", '') ~* ${STRONG_BACK_MATTER_SQL_PATTERN}
        OR COALESCE(section_chunk."headingText", '') ~* ${GENERIC_BACK_MATTER_HEADING_SQL_PATTERN}
        OR LEFT(section_chunk."text", 800) ~* ${STRONG_BACK_MATTER_SQL_PATTERN}
      )`
    : Prisma.empty;
  const minimumSectionPrefixFilter = input.minimumSectionPrefixMatches
    ? minimumPrefixGroups.length >= input.minimumSectionPrefixMatches
      ? Prisma.sql`AND (
          SELECT COUNT(*)
          FROM unnest(ARRAY[${Prisma.join(minimumPrefixGroups)}]::text[]) AS recovery_group(query)
          WHERE EXISTS (
            SELECT 1
            FROM "material_chunks" AS section_chunk
            WHERE section_chunk."userId" = ${input.userId}
              AND section_chunk."materialRevisionId" = ${input.materialRevisionId}
              AND section_chunk."materialSectionId" = "material_chunks"."materialSectionId"
              ${sectionBackMatterFilter}
              AND section_chunk."searchText" @@ to_tsquery(
                'simple',
                recovery_group.query
              )
          )
        ) >= ${input.minimumSectionPrefixMatches}`
      : Prisma.sql`AND FALSE`
    : Prisma.empty;
  const backMatterFilter = input.excludeLikelyBackMatter
    ? Prisma.sql`AND NOT (
        COALESCE("headingText", '') ~* ${STRONG_BACK_MATTER_SQL_PATTERN}
        OR COALESCE("headingText", '') ~* ${GENERIC_BACK_MATTER_HEADING_SQL_PATTERN}
        OR LEFT("text", 800) ~* ${STRONG_BACK_MATTER_SQL_PATTERN}
      )`
    : Prisma.empty;
  const textQuery = prefixQuery
    ? Prisma.sql`to_tsquery('simple', ${prefixQuery})`
    : Prisma.sql`websearch_to_tsquery('simple', ${input.query})`;

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
        WHEN ${textQuery} @@ "searchText"
        THEN ts_rank_cd("searchText", ${textQuery})::double precision
        ELSE 0::double precision
      END AS "lexicalScore",
      CASE
        WHEN ${textQuery} @@ "searchText"
        THEN LEAST(ts_rank_cd("searchText", ${textQuery}), 1)::double precision
        ELSE 0::double precision
      END AS "score"
    FROM "material_chunks"
    WHERE "userId" = ${input.userId}
      AND "materialRevisionId" = ${input.materialRevisionId}
      ${sectionFilter}
      ${minimumPrefixFilter}
      ${minimumSectionPrefixFilter}
      ${backMatterFilter}
    ORDER BY "score" DESC, "ordinal" ASC
    LIMIT ${limit}
  `;
}

export function toSimplePrefixTsQuery(query: string, operator: "and" | "or" = "and") {
  return simplePrefixTermGroups(query)
    .map((group) => {
      const query = group.map((token) => `${token}:*`).join(" | ");
      return group.length > 1 ? `(${query})` : query;
    })
    .join(operator === "or" ? " | " : " & ");
}

function simplePrefixTermGroups(query: string) {
  return query
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\u0307/gu, "")
    .normalize("NFKC")
    .split(/\s+/u)
    .flatMap((segment) => {
      if (segment.includes("|")) {
        const alternatives = segment
          .split("|")
          .flatMap((part) => part.match(/[\p{L}\p{N}]+/gu) ?? []);
        return alternatives.length > 0 ? [[...new Set(alternatives)]] : [];
      }
      return (segment.match(/[\p{L}\p{N}]+/gu) ?? []).map((token) => [token]);
    });
}
