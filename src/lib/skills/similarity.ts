import "server-only";

import { createHash } from "node:crypto";

import { GoogleGenAI } from "@google/genai";

import {
  Prisma,
  type SkillStatus,
} from "@/generated/prisma/client";
import { getGeminiEnv, type GeminiEnv } from "@/lib/env";
import {
  getGeminiErrorLogDetails,
  type GeminiApiMode,
} from "@/lib/gemini";
import {
  resolveMaterialEmbeddingRuntimeConfigs,
} from "@/lib/materials/embeddings";
import { toPgVectorLiteral } from "@/lib/materials/retrieval";
import { getPrisma } from "@/lib/prisma";

export const SKILL_SIMILARITY_EMBEDDING_DIMENSIONS = 768;
export const SKILL_SIMILARITY_FINGERPRINT_VERSION = "skill-similarity-v1";
export const SKILL_DUPLICATE_CANDIDATE_FINGERPRINT_VERSION =
  "skill-duplicate-candidate-v1";
export const SKILL_DUPLICATE_REVIEW_FINGERPRINT_VERSION =
  "skill-duplicate-review-v1";
export const SKILL_DUPLICATE_LIBRARY_FINGERPRINT_VERSION =
  "skill-duplicate-library-v1";
export const SKILL_SIMILARITY_EMBEDDING_BATCH_SIZE = 32;
export const SKILL_SIMILARITY_CACHE_WRITE_BATCH_SIZE = 8;
const SKILL_SIMILARITY_EMBEDDING_TIMEOUT_MS = 10_000;

export const SKILL_SIMILARITY_THRESHOLDS = Object.freeze({
  likelyLexical: 0.9,
  possibleLexical: 0.75,
  likelySemantic: 0.94,
  possibleSemantic: 0.88,
  likelyObjectiveWithExactTitle: 0.82,
});

export type SkillSimilarityConfidence = "exact" | "likely" | "possible";

export type SkillSimilarityReason =
  | "normalized-title-objective"
  | "normalized-title"
  | "lexical-overlap"
  | "semantic-overlap";

export type SkillSimilarityComparable = {
  title: string;
  objective?: string | null;
};

export type SkillDuplicateCandidateSnapshot = SkillSimilarityComparable & {
  id: string;
  collectionId?: string | null;
  rules?: unknown;
  examples?: unknown;
  exerciseConstraints?: unknown;
  tags?: readonly string[];
};

export type SkillDuplicateReviewSnapshot =
  SkillDuplicateCandidateSnapshot & {
    status?: SkillStatus | string | null;
  };

export type SkillDuplicateLibrarySnapshot = SkillSimilarityComparable & {
  id: string;
};

export type SkillSimilarityCandidate = SkillSimilarityComparable & {
  key: string;
  skillId?: string | null;
};

export type SkillSimilarityPreview = {
  id: string;
  title: string;
  objective: string | null;
  status: SkillStatus;
  collectionName: string | null;
  tags: string[];
  contentFingerprint: string;
};

export type SkillSimilarityComparison = {
  confidence: SkillSimilarityConfidence;
  score: number;
  lexicalScore: number;
  semanticScore: number | null;
  reasons: SkillSimilarityReason[];
};

export type SkillSimilarityMatch = SkillSimilarityComparison & {
  skill: SkillSimilarityPreview;
};

export type SkillSimilarityCandidateResult = {
  key: string;
  bestMatch: SkillSimilarityMatch | null;
  matches: SkillSimilarityMatch[];
};

export type SkillSimilarityBulkResult = {
  candidates: SkillSimilarityCandidateResult[];
  duplicateLibraryFingerprint: string | null;
  semanticStatus: "used" | "unavailable" | "skipped";
};

export type SkillSimilarityEmbeddingGenerator = (input: {
  texts: string[];
}) => Promise<number[][]>;

export type SkillSimilarityClient = Pick<
  Prisma.TransactionClient,
  "$executeRaw" | "$queryRaw"
>;

type StoredSkillSimilarityRow = Omit<
  SkillSimilarityPreview,
  "contentFingerprint"
> & {
  collectionId: string | null;
  rules: Prisma.JsonValue | null;
  examples: Prisma.JsonValue | null;
  exerciseConstraints: Prisma.JsonValue | null;
  similarityEmbeddingModel: string | null;
  similarityEmbeddingFingerprint: string | null;
  hasSimilarityEmbedding: boolean;
};

type SkillSemanticScoreRow = {
  id: string;
  semanticScore: number;
};

type EmbeddingTarget = SkillSimilarityComparable & {
  fingerprint: string;
};

const confidenceRank: Record<SkillSimilarityConfidence, number> = {
  exact: 3,
  likely: 2,
  possible: 1,
};

export function normalizeSkillSimilarityText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function normalizeSkillSimilarityLexicalText(value: string): string {
  return normalizeSkillSimilarityText(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function buildSkillSimilarityFingerprint(
  input: SkillSimilarityComparable,
): string {
  return createHash("sha256")
    .update(SKILL_SIMILARITY_FINGERPRINT_VERSION)
    .update("\u0000")
    .update(input.title.trim())
    .update("\u0000")
    .update(input.objective?.trim() ?? "")
    .digest("hex");
}

export function buildSkillDuplicateCandidateFingerprint(
  input: SkillDuplicateCandidateSnapshot,
): string {
  return createHash("sha256")
    .update(SKILL_DUPLICATE_CANDIDATE_FINGERPRINT_VERSION)
    .update("\u0000")
    .update(
      JSON.stringify({
        id: input.id,
        title: input.title.trim(),
        objective: input.objective?.trim() ?? "",
        collectionId: input.collectionId ?? null,
        rules: canonicalizeFingerprintValue(input.rules),
        examples: canonicalizeFingerprintValue(input.examples),
        exerciseConstraints: canonicalizeFingerprintValue(
          input.exerciseConstraints,
        ),
        tags: [...(input.tags ?? [])],
      }),
    )
    .digest("hex");
}

export function buildSkillDuplicateReviewFingerprint(
  input: SkillDuplicateReviewSnapshot,
): string {
  return createHash("sha256")
    .update(SKILL_DUPLICATE_REVIEW_FINGERPRINT_VERSION)
    .update("\u0000")
    .update(buildSkillDuplicateCandidateFingerprint(input))
    .digest("hex");
}

export function buildSkillDuplicateLibraryFingerprint(
  skills: readonly SkillDuplicateLibrarySnapshot[],
): string {
  const content = skills
    .map((skill) => ({
      id: skill.id,
      fingerprint: buildSkillSimilarityFingerprint(skill),
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));

  return createHash("sha256")
    .update(SKILL_DUPLICATE_LIBRARY_FINGERPRINT_VERSION)
    .update("\u0000")
    .update(JSON.stringify(content))
    .digest("hex");
}

export function buildSkillSimilarityEmbeddingText(
  input: SkillSimilarityComparable,
  model: string,
): string {
  const skillText = [
    `Skill title: ${input.title.trim()}`,
    `Skill objective: ${input.objective?.trim() || "none"}`,
  ].join("\n");

  return isEmbedding001Model(model)
    ? skillText
    : `task: sentence similarity | query: ${skillText}`;
}

export function buildSkillSimilarityEmbeddingConfig(
  model: string,
  apiMode: GeminiApiMode,
) {
  return {
    ...(isEmbedding001Model(model)
      ? { taskType: "SEMANTIC_SIMILARITY" as const }
      : {}),
    outputDimensionality: SKILL_SIMILARITY_EMBEDDING_DIMENSIONS,
    ...(apiMode === "enterprise-agent-platform"
      ? { autoTruncate: true }
      : {}),
    httpOptions: {
      timeout: SKILL_SIMILARITY_EMBEDDING_TIMEOUT_MS,
      retryOptions: {
        attempts: 1,
      },
    },
  };
}

export function normalizeSkillSimilarityEmbedding(
  values: readonly number[],
): number[] {
  if (values.length !== SKILL_SIMILARITY_EMBEDDING_DIMENSIONS) {
    throw new Error(
      `Skill similarity embeddings must contain ${SKILL_SIMILARITY_EMBEDDING_DIMENSIONS} values.`,
    );
  }
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("Skill similarity embeddings must contain only finite values.");
  }

  const magnitude = Math.sqrt(
    values.reduce((sum, value) => sum + value * value, 0),
  );
  if (!Number.isFinite(magnitude) || magnitude === 0) {
    throw new Error("Skill similarity embeddings must have a finite magnitude.");
  }

  return values.map((value) => value / magnitude);
}

export function createGeminiSkillSimilarityEmbeddingGenerator(
  env: GeminiEnv = getGeminiEnv(),
): SkillSimilarityEmbeddingGenerator {
  const runtimeConfigs = resolveMaterialEmbeddingRuntimeConfigs(env);

  return async ({ texts }) => {
    if (texts.length === 0) {
      return [];
    }

    for (const [index, config] of runtimeConfigs.entries()) {
      const startedAt = Date.now();
      console.info("[ai] skill similarity embedding request started", {
        provider: "google",
        apiMode: config.apiMode,
        endpoint: config.endpoint,
        model: config.model,
        count: texts.length,
        inputCharacters: texts.reduce(
          (total, text) => total + text.length,
          0,
        ),
      });

      try {
        const ai = new GoogleGenAI(config.clientOptions);
        const response = await ai.models.embedContent({
          model: config.model,
          contents: texts.map((text) => ({
            role: "user",
            parts: [{ text }],
          })),
          config: buildSkillSimilarityEmbeddingConfig(
            config.model,
            config.apiMode,
          ),
        });
        const embeddings = response.embeddings ?? [];
        if (embeddings.length !== texts.length) {
          throw new Error(
            "Gemini returned the wrong number of skill similarity embeddings.",
          );
        }

        const normalized = embeddings.map((embedding) =>
          normalizeSkillSimilarityEmbedding(embedding.values ?? []),
        );
        console.info("[ai] skill similarity embedding request succeeded", {
          provider: "google",
          apiMode: config.apiMode,
          endpoint: config.endpoint,
          model: config.model,
          count: normalized.length,
          elapsedMs: Date.now() - startedAt,
        });
        return normalized;
      } catch (error) {
        const details = getGeminiErrorLogDetails(error);
        const willFallback =
          index < runtimeConfigs.length - 1 &&
          (details.code === 404 || details.status === "NOT_FOUND");
        const log = willFallback ? console.warn : console.error;
        log("[ai] skill similarity embedding request failed", {
          provider: "google",
          apiMode: config.apiMode,
          endpoint: config.endpoint,
          model: config.model,
          count: texts.length,
          inputCharacters: texts.reduce(
            (total, text) => total + text.length,
            0,
          ),
          elapsedMs: Date.now() - startedAt,
          code: details.code,
          status: details.status,
          fallbackApiMode: willFallback
            ? runtimeConfigs[index + 1]?.apiMode
            : undefined,
        });
        if (!willFallback) {
          throw error;
        }
      }
    }

    throw new Error("No Gemini skill similarity embedding runtime is available.");
  };
}

export function compareSkillSimilarity(
  left: SkillSimilarityComparable,
  right: SkillSimilarityComparable,
  semanticScore: number | null = null,
): SkillSimilarityComparison | null {
  const leftTitle = normalizeSkillSimilarityText(left.title);
  const rightTitle = normalizeSkillSimilarityText(right.title);
  const leftObjective = normalizeSkillSimilarityText(left.objective ?? "");
  const rightObjective = normalizeSkillSimilarityText(right.objective ?? "");
  const exactTitle = leftTitle.length > 0 && leftTitle === rightTitle;
  const exactObjective = leftObjective === rightObjective;
  const titleScore = tokenJaccard(
    normalizeSkillSimilarityLexicalText(left.title),
    normalizeSkillSimilarityLexicalText(right.title),
  );
  const objectiveScore = tokenJaccard(
    normalizeSkillSimilarityLexicalText(left.objective ?? ""),
    normalizeSkillSimilarityLexicalText(right.objective ?? ""),
  );
  const hasTwoObjectives =
    leftObjective.length > 0 && rightObjective.length > 0;
  const lexicalScore = hasTwoObjectives
    ? titleScore * 0.45 + objectiveScore * 0.55
    : titleScore;
  const finiteSemanticScore =
    semanticScore !== null && Number.isFinite(semanticScore)
      ? clampScore(semanticScore)
      : null;
  const reasons: SkillSimilarityReason[] = [];

  if (exactTitle && exactObjective) {
    reasons.push("normalized-title-objective", "normalized-title");
    return {
      confidence: "exact",
      score: 1,
      lexicalScore: 1,
      semanticScore: finiteSemanticScore,
      reasons,
    };
  }

  if (exactTitle) {
    reasons.push("normalized-title");
  }
  if (lexicalScore >= SKILL_SIMILARITY_THRESHOLDS.possibleLexical) {
    reasons.push("lexical-overlap");
  }
  if (
    finiteSemanticScore !== null &&
    finiteSemanticScore >= SKILL_SIMILARITY_THRESHOLDS.possibleSemantic
  ) {
    reasons.push("semantic-overlap");
  }

  const likelyLexical =
    (hasTwoObjectives &&
      lexicalScore >= SKILL_SIMILARITY_THRESHOLDS.likelyLexical) ||
    (exactTitle &&
      hasTwoObjectives &&
      objectiveScore >=
        SKILL_SIMILARITY_THRESHOLDS.likelyObjectiveWithExactTitle);
  const likelySemantic =
    finiteSemanticScore !== null &&
    finiteSemanticScore >= SKILL_SIMILARITY_THRESHOLDS.likelySemantic;
  const possibleLexical =
    exactTitle ||
    lexicalScore >= SKILL_SIMILARITY_THRESHOLDS.possibleLexical;
  const possibleSemantic =
    finiteSemanticScore !== null &&
    finiteSemanticScore >= SKILL_SIMILARITY_THRESHOLDS.possibleSemantic;

  if (!likelyLexical && !likelySemantic && !possibleLexical && !possibleSemantic) {
    return null;
  }

  return {
    confidence:
      likelyLexical || likelySemantic ? "likely" : "possible",
    score: Math.max(lexicalScore, finiteSemanticScore ?? 0),
    lexicalScore,
    semanticScore: finiteSemanticScore,
    reasons,
  };
}

export function rankSkillSimilarityMatches(input: {
  candidate: SkillSimilarityComparable;
  skills: readonly SkillSimilarityPreview[];
  semanticScores?: ReadonlyMap<string, number>;
  limit?: number;
}): SkillSimilarityMatch[] {
  const limit = clampLimit(input.limit);

  return input.skills
    .flatMap((skill) => {
      const comparison = compareSkillSimilarity(
        input.candidate,
        skill,
        input.semanticScores?.get(skill.id) ?? null,
      );
      return comparison ? [{ skill, ...comparison }] : [];
    })
    .toSorted(compareMatches)
    .slice(0, limit);
}

export async function findSimilarSkillsForUser(input: {
  userId: string;
  candidates: readonly SkillSimilarityCandidate[];
  limitPerCandidate?: number;
  embeddingGenerator?: SkillSimilarityEmbeddingGenerator | null;
  embeddingModel?: string;
  prisma?: SkillSimilarityClient;
}): Promise<SkillSimilarityBulkResult> {
  const candidates = normalizeCandidates(input.candidates);
  if (candidates.length === 0) {
    return {
      candidates: [],
      duplicateLibraryFingerprint: null,
      semanticStatus: "skipped",
    };
  }

  const prisma = input.prisma ?? getPrisma();
  const storedSkills = await readStoredSkills(prisma, input.userId);
  const duplicateLibraryFingerprint =
    buildSkillDuplicateLibraryFingerprint(storedSkills);
  const previewById = new Map(
    storedSkills.map((skill) => [skill.id, toPreview(skill)]),
  );
  const lexicalResults = buildCandidateResults({
    candidates,
    previewById,
    limit: input.limitPerCandidate,
  });
  const lexicalConfidenceByKey = new Map(
    lexicalResults.map((result) => [
      result.key,
      result.bestMatch?.confidence ?? null,
    ]),
  );
  const semanticCandidates = candidates.filter((candidate) => {
    const confidence = lexicalConfidenceByKey.get(candidate.key);
    return (
      confidence !== "exact" &&
      confidence !== "likely" &&
      storedSkills.some((skill) => skill.id !== candidate.skillId)
    );
  });

  if (
    storedSkills.length === 0 ||
    semanticCandidates.length === 0 ||
    input.embeddingGenerator === null
  ) {
    return {
      candidates: lexicalResults,
      duplicateLibraryFingerprint,
      semanticStatus: "skipped",
    };
  }

  let embeddingGenerator = input.embeddingGenerator;
  let embeddingModel = input.embeddingModel?.trim() || null;
  if (!embeddingGenerator) {
    try {
      const env = getGeminiEnv();
      embeddingModel = env.GEMINI_EMBEDDING_MODEL;
      embeddingGenerator =
        createGeminiSkillSimilarityEmbeddingGenerator(env);
    } catch {
      return {
        candidates: lexicalResults,
        duplicateLibraryFingerprint,
        semanticStatus: "unavailable",
      };
    }
  }
  embeddingModel ??= "custom-skill-similarity-v1";

  try {
    const semanticScores = await prepareSemanticScores({
      userId: input.userId,
      candidates: semanticCandidates,
      storedSkills,
      embeddingGenerator,
      embeddingModel,
      prisma,
    });
    const semanticResults = buildCandidateResults({
      candidates,
      previewById,
      limit: input.limitPerCandidate,
      semanticScores,
    });
    return {
      candidates: semanticResults,
      duplicateLibraryFingerprint,
      semanticStatus: "used",
    };
  } catch (error) {
    const { code, status } = getGeminiErrorLogDetails(error);
    console.warn("[ai] skill semantic similarity unavailable", {
      candidateCount: semanticCandidates.length,
      storedSkillCount: storedSkills.length,
      embeddingModel,
      errorName: error instanceof Error ? error.name : "UnknownError",
      code,
      status,
    });
    return {
      candidates: lexicalResults,
      duplicateLibraryFingerprint,
      semanticStatus: "unavailable",
    };
  }
}

export async function invalidateSkillSimilarityCache(input: {
  userId: string;
  skillId: string;
  prisma?: SkillSimilarityClient;
}): Promise<boolean> {
  const prisma = input.prisma ?? getPrisma();
  const updated = await prisma.$executeRaw`
    UPDATE "skills"
    SET
      "similarityEmbedding" = NULL,
      "similarityEmbeddingModel" = NULL,
      "similarityEmbeddingFingerprint" = NULL
    WHERE "id" = ${input.skillId}
      AND "userId" = ${input.userId}
  `;
  return updated === 1;
}

async function prepareSemanticScores(input: {
  userId: string;
  candidates: readonly SkillSimilarityCandidate[];
  storedSkills: readonly StoredSkillSimilarityRow[];
  embeddingGenerator: SkillSimilarityEmbeddingGenerator;
  embeddingModel: string;
  prisma: SkillSimilarityClient;
}) {
  const expectedFingerprintBySkillId = new Map(
    input.storedSkills.map((skill) => [
      skill.id,
      buildSkillSimilarityFingerprint(skill),
    ]),
  );
  const validStoredSkillIds = new Set(
    input.storedSkills
      .filter(
        (skill) =>
          skill.hasSimilarityEmbedding &&
          skill.similarityEmbeddingModel === input.embeddingModel &&
          skill.similarityEmbeddingFingerprint ===
            expectedFingerprintBySkillId.get(skill.id),
      )
      .map((skill) => skill.id),
  );
  const targets = new Map<string, EmbeddingTarget>();

  for (const skill of input.storedSkills) {
    if (validStoredSkillIds.has(skill.id)) {
      continue;
    }
    const fingerprint = expectedFingerprintBySkillId.get(skill.id);
    if (fingerprint) {
      targets.set(fingerprint, {
        title: skill.title,
        objective: skill.objective,
        fingerprint,
      });
    }
  }
  for (const candidate of input.candidates) {
    const fingerprint = buildSkillSimilarityFingerprint(candidate);
    if (
      !candidate.skillId ||
      !validStoredSkillIds.has(candidate.skillId) ||
      expectedFingerprintBySkillId.get(candidate.skillId) !== fingerprint
    ) {
      targets.set(fingerprint, {
        title: candidate.title,
        objective: candidate.objective,
        fingerprint,
      });
    }
  }

  const generatedByFingerprint = await generateEmbeddings({
    targets: [...targets.values()],
    embeddingGenerator: input.embeddingGenerator,
    embeddingModel: input.embeddingModel,
  });

  const skillsNeedingCacheWrite = input.storedSkills.filter(
    (skill) => !validStoredSkillIds.has(skill.id),
  );
  for (
    let start = 0;
    start < skillsNeedingCacheWrite.length;
    start += SKILL_SIMILARITY_CACHE_WRITE_BATCH_SIZE
  ) {
    const batch = skillsNeedingCacheWrite.slice(
      start,
      start + SKILL_SIMILARITY_CACHE_WRITE_BATCH_SIZE,
    );
    const storedIds = await Promise.all(
      batch.map(async (skill) => {
        const fingerprint = expectedFingerprintBySkillId.get(skill.id);
        const embedding = fingerprint
          ? generatedByFingerprint.get(fingerprint)
          : undefined;
        if (!fingerprint || !embedding) {
          return null;
        }
        return (await storeSkillSimilarityEmbedding({
          prisma: input.prisma,
          userId: input.userId,
          skill,
          embedding,
          model: input.embeddingModel,
          fingerprint,
        }))
          ? skill.id
          : null;
      }),
    );
    for (const skillId of storedIds) {
      if (skillId) {
        validStoredSkillIds.add(skillId);
      }
    }
  }

  const validSkillIds = [...validStoredSkillIds];
  const scoresByCandidateKey = new Map<string, Map<string, number>>();
  if (validSkillIds.length === 0) {
    return scoresByCandidateKey;
  }

  for (const candidate of input.candidates) {
    const fingerprint = buildSkillSimilarityFingerprint(candidate);
    const generatedEmbedding = generatedByFingerprint.get(fingerprint);
    const canUseCachedCandidate =
      Boolean(candidate.skillId) &&
      validStoredSkillIds.has(candidate.skillId ?? "") &&
      expectedFingerprintBySkillId.get(candidate.skillId ?? "") === fingerprint;
    if (!generatedEmbedding && !canUseCachedCandidate) {
      continue;
    }

    const rows = await querySemanticScores({
      prisma: input.prisma,
      userId: input.userId,
      candidateSkillId:
        canUseCachedCandidate ? candidate.skillId ?? null : null,
      candidateEmbedding: generatedEmbedding,
      embeddingModel: input.embeddingModel,
      validSkillIds,
      excludeSkillId: candidate.skillId ?? null,
    });
    scoresByCandidateKey.set(
      candidate.key,
      new Map(
        rows
          .filter((row) => Number.isFinite(row.semanticScore))
          .map((row) => [row.id, clampScore(row.semanticScore)]),
      ),
    );
  }

  return scoresByCandidateKey;
}

async function generateEmbeddings(input: {
  targets: readonly EmbeddingTarget[];
  embeddingGenerator: SkillSimilarityEmbeddingGenerator;
  embeddingModel: string;
}) {
  const generated = new Map<string, number[]>();
  for (
    let start = 0;
    start < input.targets.length;
    start += SKILL_SIMILARITY_EMBEDDING_BATCH_SIZE
  ) {
    const batch = input.targets.slice(
      start,
      start + SKILL_SIMILARITY_EMBEDDING_BATCH_SIZE,
    );
    const embeddings = await input.embeddingGenerator({
      texts: batch.map((target) =>
        buildSkillSimilarityEmbeddingText(
          target,
          input.embeddingModel,
        ),
      ),
    });
    if (embeddings.length !== batch.length) {
      throw new Error(
        "Skill similarity embedding generator returned an incomplete batch.",
      );
    }
    batch.forEach((target, index) => {
      const embedding = embeddings[index];
      if (!embedding) {
        throw new Error("Skill similarity embedding was missing.");
      }
      generated.set(
        target.fingerprint,
        normalizeSkillSimilarityEmbedding(embedding),
      );
    });
  }
  return generated;
}

async function readStoredSkills(
  prisma: SkillSimilarityClient,
  userId: string,
): Promise<StoredSkillSimilarityRow[]> {
  return prisma.$queryRaw<StoredSkillSimilarityRow[]>`
    SELECT
      skill."id",
      skill."title",
      skill."objective",
      skill."status",
      skill."collectionId",
      collection."name" AS "collectionName",
      skill."rules",
      skill."examples",
      skill."exerciseConstraints",
      skill."tags",
      skill."similarityEmbeddingModel",
      skill."similarityEmbeddingFingerprint",
      (skill."similarityEmbedding" IS NOT NULL) AS "hasSimilarityEmbedding"
    FROM "skills" AS skill
    LEFT JOIN "collections" AS collection
      ON collection."id" = skill."collectionId"
      AND collection."userId" = skill."userId"
    WHERE skill."userId" = ${userId}
  `;
}

async function storeSkillSimilarityEmbedding(input: {
  prisma: SkillSimilarityClient;
  userId: string;
  skill: StoredSkillSimilarityRow;
  embedding: readonly number[];
  model: string;
  fingerprint: string;
}) {
  const vector = toPgVectorLiteral(input.embedding);
  const updated = await input.prisma.$executeRaw`
    UPDATE "skills"
    SET
      "similarityEmbedding" = ${vector}::vector,
      "similarityEmbeddingModel" = ${input.model},
      "similarityEmbeddingFingerprint" = ${input.fingerprint}
    WHERE "id" = ${input.skill.id}
      AND "userId" = ${input.userId}
      AND "title" = ${input.skill.title}
      AND "objective" IS NOT DISTINCT FROM ${input.skill.objective}
  `;
  return updated === 1;
}

async function querySemanticScores(input: {
  prisma: SkillSimilarityClient;
  userId: string;
  candidateSkillId: string | null;
  candidateEmbedding?: readonly number[];
  embeddingModel: string;
  validSkillIds: readonly string[];
  excludeSkillId: string | null;
}): Promise<SkillSemanticScoreRow[]> {
  const candidateVector = input.candidateEmbedding
    ? Prisma.sql`${toPgVectorLiteral(input.candidateEmbedding)}::vector`
    : Prisma.sql`(
        SELECT candidate."similarityEmbedding"
        FROM "skills" AS candidate
        WHERE candidate."id" = ${input.candidateSkillId}
          AND candidate."userId" = ${input.userId}
          AND candidate."similarityEmbeddingModel" = ${input.embeddingModel}
      )`;
  const excludeSelf = input.excludeSkillId
    ? Prisma.sql`AND skill."id" <> ${input.excludeSkillId}`
    : Prisma.empty;

  return input.prisma.$queryRaw<SkillSemanticScoreRow[]>`
    SELECT
      skill."id",
      (
        1 - (skill."similarityEmbedding" <=> ${candidateVector})
      )::double precision AS "semanticScore"
    FROM "skills" AS skill
    WHERE skill."userId" = ${input.userId}
      AND skill."id" IN (${Prisma.join(input.validSkillIds)})
      AND skill."similarityEmbeddingModel" = ${input.embeddingModel}
      AND skill."similarityEmbedding" IS NOT NULL
      ${excludeSelf}
  `;
}

function buildCandidateResults(input: {
  candidates: readonly SkillSimilarityCandidate[];
  previewById: ReadonlyMap<string, SkillSimilarityPreview>;
  limit?: number;
  semanticScores?: ReadonlyMap<string, ReadonlyMap<string, number>>;
}): SkillSimilarityCandidateResult[] {
  return input.candidates.map((candidate) => {
    const skills = [...input.previewById.values()].filter(
      (skill) => skill.id !== candidate.skillId,
    );
    const matches = rankSkillSimilarityMatches({
      candidate,
      skills,
      semanticScores: input.semanticScores?.get(candidate.key),
      limit: input.limit,
    });
    return {
      key: candidate.key,
      bestMatch: matches[0] ?? null,
      matches,
    };
  });
}

function normalizeCandidates(
  candidates: readonly SkillSimilarityCandidate[],
): SkillSimilarityCandidate[] {
  const seenKeys = new Set<string>();
  return candidates.flatMap((candidate) => {
    const key = candidate.key.trim();
    const title = candidate.title.trim();
    if (!key || !title || seenKeys.has(key)) {
      return [];
    }
    seenKeys.add(key);
    return [
      {
        key,
        skillId: candidate.skillId?.trim() || null,
        title,
        objective: candidate.objective?.trim() || null,
      },
    ];
  });
}

function toPreview(
  skill: StoredSkillSimilarityRow,
): SkillSimilarityPreview {
  return {
    id: skill.id,
    title: skill.title,
    objective: skill.objective,
    status: skill.status,
    collectionName: skill.collectionName,
    tags: skill.tags,
    contentFingerprint: buildSkillDuplicateReviewFingerprint(skill),
  };
}

function compareMatches(
  left: SkillSimilarityMatch,
  right: SkillSimilarityMatch,
) {
  return (
    confidenceRank[right.confidence] - confidenceRank[left.confidence] ||
    right.score - left.score ||
    left.skill.title.localeCompare(right.skill.title) ||
    left.skill.id.localeCompare(right.skill.id)
  );
}

function canonicalizeFingerprintValue(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeFingerprintValue);
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [
          key,
          canonicalizeFingerprintValue(child),
        ]),
    );
  }
  return value;
}

function tokenJaccard(left: string, right: string) {
  const leftTokens = new Set(left.split(" ").filter(Boolean));
  const rightTokens = new Set(right.split(" ").filter(Boolean));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }
  const intersection = [...leftTokens].filter((token) =>
    rightTokens.has(token),
  ).length;
  return intersection / new Set([...leftTokens, ...rightTokens]).size;
}

function clampLimit(limit?: number) {
  return Math.max(1, Math.min(limit ?? 3, 10));
}

function clampScore(score: number) {
  return Math.max(-1, Math.min(score, 1));
}

function isEmbedding001Model(model: string) {
  return (
    model === "gemini-embedding-001" ||
    model.startsWith("gemini-embedding-001-")
  );
}
