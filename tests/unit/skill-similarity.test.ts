import { describe, expect, it } from "vitest";

import { SkillStatus } from "@/generated/prisma/client";
import {
  SKILL_SIMILARITY_CACHE_WRITE_BATCH_SIZE,
  SKILL_SIMILARITY_EMBEDDING_BATCH_SIZE,
  SKILL_SIMILARITY_EMBEDDING_DIMENSIONS,
  SKILL_SIMILARITY_THRESHOLDS,
  buildSkillDuplicateCandidateFingerprint,
  buildSkillSimilarityEmbeddingConfig,
  buildSkillSimilarityEmbeddingText,
  buildSkillSimilarityFingerprint,
  compareSkillSimilarity,
  findSimilarSkillsForUser,
  invalidateSkillSimilarityCache,
  normalizeSkillSimilarityEmbedding,
  normalizeSkillSimilarityLexicalText,
  normalizeSkillSimilarityText,
  rankSkillSimilarityMatches,
  type SkillSimilarityClient,
  type SkillSimilarityEmbeddingGenerator,
  type SkillSimilarityPreview,
} from "@/lib/skills/similarity";

function unitEmbedding(seed = 0) {
  const embedding = Array<number>(
    SKILL_SIMILARITY_EMBEDDING_DIMENSIONS,
  ).fill(0);
  embedding[seed % SKILL_SIMILARITY_EMBEDDING_DIMENSIONS] = 1;
  return embedding;
}

function storedSkill(
  input: Partial<SkillSimilarityPreview> & Pick<SkillSimilarityPreview, "id">,
): SkillSimilarityPreview & {
  similarityEmbeddingModel: string | null;
  similarityEmbeddingFingerprint: string | null;
  hasSimilarityEmbedding: boolean;
} {
  return {
    id: input.id,
    title: input.title ?? `Skill ${input.id}`,
    objective: input.objective ?? null,
    status: input.status ?? SkillStatus.DRAFT,
    collectionName: input.collectionName ?? null,
    tags: input.tags ?? [],
    similarityEmbeddingModel: null,
    similarityEmbeddingFingerprint: null,
    hasSimilarityEmbedding: false,
  };
}

function createSimilarityClient(input: {
  onQuery: (sql: string) => unknown;
  onExecute?: (sql: string) => number | Promise<number>;
}) {
  const seenQueries: string[] = [];
  const seenExecutions: string[] = [];
  const client = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      seenQueries.push(sql);
      return input.onQuery(sql);
    },
    $executeRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      seenExecutions.push(sql);
      return input.onExecute?.(sql) ?? 1;
    },
  } as unknown as SkillSimilarityClient;

  return { client, seenQueries, seenExecutions };
}

describe("skill similarity text and embedding contracts", () => {
  it("normalizes case and punctuation while preserving meaningful diacritics", () => {
    expect(normalizeSkillSimilarityText("  Sí—No! ")).toBe("sí no");
    expect(normalizeSkillSimilarityText("Si, no")).toBe("si no");
    expect(normalizeSkillSimilarityLexicalText("Sí—No!")).toBe("si no");
  });

  it("fingerprints the versioned title and objective content", () => {
    const first = buildSkillSimilarityFingerprint({
      title: " Linear equations ",
      objective: " Solve and check ",
    });
    const same = buildSkillSimilarityFingerprint({
      title: "Linear equations",
      objective: "Solve and check",
    });
    const changed = buildSkillSimilarityFingerprint({
      title: "Linear equations",
      objective: "Solve and graph",
    });

    expect(first).toBe(same);
    expect(changed).not.toBe(first);
  });

  it("binds duplicate decisions to every editable draft field", () => {
    const candidate = {
      id: "draft-1",
      title: "Linear equations",
      objective: "Solve and check one-variable equations.",
      collectionId: "collection-1",
      rules: { items: ["Undo the same operation on both sides."] },
      examples: { items: ["2x + 3 = 9"] },
      exerciseConstraints: { answerKind: "choice", notes: "Use integers." },
      tags: ["algebra", "equations"],
    };
    const fingerprint = buildSkillDuplicateCandidateFingerprint(candidate);
    const sameWithReorderedJson = buildSkillDuplicateCandidateFingerprint({
      ...candidate,
      exerciseConstraints: { notes: "Use integers.", answerKind: "choice" },
    });

    expect(sameWithReorderedJson).toBe(fingerprint);
    for (const changed of [
      { ...candidate, title: "Graphing linear equations" },
      { ...candidate, objective: "Graph one-variable equations." },
      { ...candidate, collectionId: "collection-2" },
      { ...candidate, rules: { items: ["Divide first."] } },
      { ...candidate, examples: { items: ["4x = 12"] } },
      {
        ...candidate,
        exerciseConstraints: { answerKind: "choice", notes: "Use fractions." },
      },
      { ...candidate, tags: ["algebra"] },
    ]) {
      expect(buildSkillDuplicateCandidateFingerprint(changed)).not.toBe(
        fingerprint,
      );
    }
  });

  it("uses the documented sentence-similarity prefix for Embedding 2", () => {
    const text = buildSkillSimilarityEmbeddingText(
      {
        title: "Linear equations",
        objective: "Solve one-variable equations",
      },
      "gemini-embedding-2",
    );

    expect(text).toBe(
      "task: sentence similarity | query: Skill title: Linear equations\n" +
        "Skill objective: Solve one-variable equations",
    );
    expect(
      buildSkillSimilarityEmbeddingText(
        { title: "Linear equations", objective: null },
        "gemini-embedding-001",
      ),
    ).toBe("Skill title: Linear equations\nSkill objective: none");
  });

  it("only sends the legacy semantic task type to embedding-001", () => {
    expect(
      buildSkillSimilarityEmbeddingConfig(
        "gemini-embedding-2",
        "developer-api",
      ),
    ).toEqual({
      outputDimensionality: SKILL_SIMILARITY_EMBEDDING_DIMENSIONS,
    });
    expect(
      buildSkillSimilarityEmbeddingConfig(
        "gemini-embedding-001",
        "enterprise-agent-platform",
      ),
    ).toEqual({
      taskType: "SEMANTIC_SIMILARITY",
      outputDimensionality: SKILL_SIMILARITY_EMBEDDING_DIMENSIONS,
      autoTruncate: true,
    });
  });

  it("normalizes valid vectors and rejects invalid embedding output", () => {
    const vector = Array<number>(
      SKILL_SIMILARITY_EMBEDDING_DIMENSIONS,
    ).fill(0);
    vector[0] = 3;
    vector[1] = 4;

    const normalized = normalizeSkillSimilarityEmbedding(vector);
    expect(normalized[0]).toBeCloseTo(0.6);
    expect(normalized[1]).toBeCloseTo(0.8);
    expect(() => normalizeSkillSimilarityEmbedding([1, 2])).toThrow(
      "must contain 768 values",
    );
    expect(() =>
      normalizeSkillSimilarityEmbedding(
        Array<number>(SKILL_SIMILARITY_EMBEDDING_DIMENSIONS).fill(0),
      ),
    ).toThrow("finite magnitude");
    const nonFinite = unitEmbedding();
    nonFinite[2] = Number.NaN;
    expect(() => normalizeSkillSimilarityEmbedding(nonFinite)).toThrow(
      "only finite values",
    );
  });
});

describe("deterministic skill similarity ranking", () => {
  it("classifies normalized title and objective equality as exact", () => {
    expect(
      compareSkillSimilarity(
        {
          title: " Solving Linear Equations! ",
          objective: "Isolate x, then verify.",
        },
        {
          title: "solving linear equations",
          objective: "isolate x then verify",
        },
      ),
    ).toMatchObject({
      confidence: "exact",
      score: 1,
      lexicalScore: 1,
      reasons: ["normalized-title-objective", "normalized-title"],
    });
  });

  it("does not call accent-folded titles exact", () => {
    const comparison = compareSkillSimilarity(
      { title: "When to use sí", objective: "Affirm an answer" },
      { title: "When to use si", objective: "Affirm an answer" },
    );

    expect(comparison).toMatchObject({
      confidence: "likely",
      lexicalScore: 1,
    });
    expect(comparison?.reasons).not.toContain("normalized-title");
  });

  it("keeps conservative lexical confidence boundaries", () => {
    const likely = compareSkillSimilarity(
      {
        title: "Practice solving one step linear equations",
        objective: "Use inverse operations and verify the result",
      },
      {
        title: "Practice solving one step equations",
        objective: "Use inverse operations and verify the result",
      },
    );
    const possible = compareSkillSimilarity(
      {
        title: "Photosynthesis",
        objective: "Explain light-dependent reactions",
      },
      {
        title: "Photosynthesis",
        objective: "Identify leaf anatomy",
      },
    );
    const unrelated = compareSkillSimilarity(
      { title: "Photosynthesis", objective: "Explain chloroplast reactions" },
      { title: "French verbs", objective: "Conjugate être in the present" },
    );

    expect(likely?.confidence).toBe("likely");
    expect(likely?.lexicalScore).toBeGreaterThanOrEqual(
      SKILL_SIMILARITY_THRESHOLDS.likelyLexical,
    );
    expect(possible?.confidence).toBe("possible");
    expect(possible?.reasons).toContain("normalized-title");
    expect(unrelated).toBeNull();
  });

  it("does not collapse closely worded sibling skills into one skill", () => {
    expect(
      compareSkillSimilarity(
        {
          title: "Quota boundary first fixture",
          objective: "Choose one direct object pronoun at the quota boundary.",
        },
        {
          title: "Quota boundary second fixture",
          objective:
            "Choose one indirect object pronoun at the quota boundary.",
        },
      ),
    ).toBeNull();
  });

  it("does not promote title-only evidence to likely when an objective is missing", () => {
    expect(
      compareSkillSimilarity(
        { title: "Photosynthesis", objective: null },
        {
          title: "Photosynthesis",
          objective: "Explain light-dependent reactions",
        },
      ),
    ).toMatchObject({
      confidence: "possible",
      lexicalScore: 1,
      reasons: ["normalized-title", "lexical-overlap"],
    });
  });

  it("applies the exported semantic thresholds at their boundaries", () => {
    const candidate = {
      title: "Balancing a checking account",
      objective: "Reconcile deposits and withdrawals",
    };
    const saved = {
      title: "Cellular respiration",
      objective: "Trace energy through glycolysis",
    };

    expect(
      compareSkillSimilarity(
        candidate,
        saved,
        SKILL_SIMILARITY_THRESHOLDS.possibleSemantic - 0.001,
      ),
    ).toBeNull();
    expect(
      compareSkillSimilarity(
        candidate,
        saved,
        SKILL_SIMILARITY_THRESHOLDS.possibleSemantic,
      ),
    ).toMatchObject({
      confidence: "possible",
      reasons: ["semantic-overlap"],
    });
    expect(
      compareSkillSimilarity(
        candidate,
        saved,
        SKILL_SIMILARITY_THRESHOLDS.likelySemantic,
      ),
    ).toMatchObject({
      confidence: "likely",
      reasons: ["semantic-overlap"],
    });
  });

  it("sorts by confidence, then score, and honors the result limit", () => {
    const candidate = {
      title: "Photosynthesis",
      objective: "Explain light-dependent reactions",
    };
    const skills: SkillSimilarityPreview[] = [
      {
        id: "possible",
        title: "Photosynthesis",
        objective: "Identify leaf anatomy",
        status: SkillStatus.ARCHIVED,
        collectionName: null,
        tags: [],
      },
      {
        id: "semantic",
        title: "Plant energy conversion",
        objective: "Describe how plants turn light into chemical energy",
        status: SkillStatus.ACTIVE,
        collectionName: "Biology",
        tags: ["plants"],
      },
      {
        id: "exact",
        title: "photosynthesis",
        objective: "explain light dependent reactions",
        status: SkillStatus.PAUSED,
        collectionName: null,
        tags: [],
      },
    ];

    const matches = rankSkillSimilarityMatches({
      candidate,
      skills,
      semanticScores: new Map([["semantic", 0.95]]),
      limit: 2,
    });

    expect(matches.map((match) => match.skill.id)).toEqual([
      "exact",
      "semantic",
    ]);
    expect(matches.map((match) => match.confidence)).toEqual([
      "exact",
      "likely",
    ]);
  });
});

describe("user-scoped bulk skill similarity", () => {
  it("does not embed a saved draft when there is no other skill to compare", async () => {
    const self = storedSkill({
      id: "draft-self",
      title: "First saved skill",
      objective: "Practice one focused concept",
    });
    let generationCalls = 0;
    const fake = createSimilarityClient({
      onQuery: () => [self],
    });

    const result = await findSimilarSkillsForUser({
      userId: "user-1",
      candidates: [
        {
          key: "candidate",
          skillId: self.id,
          title: self.title,
          objective: self.objective,
        },
      ],
      embeddingGenerator: async () => {
        generationCalls += 1;
        return [unitEmbedding()];
      },
      embeddingModel: "gemini-embedding-2",
      prisma: fake.client,
    });

    expect(result).toMatchObject({
      semanticStatus: "skipped",
      candidates: [{ key: "candidate", bestMatch: null, matches: [] }],
    });
    expect(generationCalls).toBe(0);
  });

  it("includes every saved status, excludes the candidate itself, and can stay lexical-only", async () => {
    const rows = [
      storedSkill({
        id: "draft-self",
        title: "French pronunciation",
        objective: "Practice vowel sounds",
        status: SkillStatus.DRAFT,
      }),
      storedSkill({
        id: "active",
        title: "French pronunciation",
        objective: "Practice vowel sounds",
        status: SkillStatus.ACTIVE,
      }),
      storedSkill({
        id: "paused",
        title: "French pronunciation",
        objective: "Distinguish nasal vowels",
        status: SkillStatus.PAUSED,
      }),
      storedSkill({
        id: "archived",
        title: "French pronunciation",
        objective: "Read liaison patterns",
        status: SkillStatus.ARCHIVED,
      }),
    ];
    const fake = createSimilarityClient({
      onQuery: () => rows,
    });

    const result = await findSimilarSkillsForUser({
      userId: "user-1",
      candidates: [
        {
          key: "candidate",
          skillId: "draft-self",
          title: "French pronunciation",
          objective: "Practice vowel sounds",
        },
      ],
      embeddingGenerator: null,
      prisma: fake.client,
    });

    expect(result.semanticStatus).toBe("skipped");
    expect(
      result.candidates[0]?.matches.map((match) => match.skill.id),
    ).toEqual(["active", "archived", "paused"]);
    expect(
      result.candidates[0]?.matches.map((match) => match.skill.status),
    ).toEqual([
      SkillStatus.ACTIVE,
      SkillStatus.ARCHIVED,
      SkillStatus.PAUSED,
    ]);
    expect(fake.seenQueries).toHaveLength(1);
    expect(fake.seenQueries[0]).toContain('WHERE skill."userId" = ?');
    expect(fake.seenQueries[0]).not.toContain('skill."status" IN');
  });

  it("skips semantic work for deterministic exact and likely candidates in a mixed request", async () => {
    const rows = [
      storedSkill({
        id: "likely-match",
        title: "Practice solving one step equations",
        objective: "Use inverse operations and verify the result",
      }),
      storedSkill({
        id: "other",
        title: "Cellular respiration",
        objective: "Trace energy through glycolysis",
      }),
    ];
    const generatedTexts: string[] = [];
    const generator: SkillSimilarityEmbeddingGenerator = async ({ texts }) => {
      generatedTexts.push(...texts);
      return texts.map((_, index) => unitEmbedding(index));
    };
    const fake = createSimilarityClient({
      onQuery: (sql) =>
        sql.includes('"semanticScore"')
          ? [{ id: "other", semanticScore: 0.9 }]
          : rows,
    });

    const result = await findSimilarSkillsForUser({
      userId: "user-1",
      candidates: [
        {
          key: "deterministic",
          title: "Practice solving one step linear equations",
          objective: "Use inverse operations and verify the result",
        },
        {
          key: "semantic",
          title: "How cells release usable energy",
          objective: "Explain ATP production from nutrients",
        },
      ],
      embeddingGenerator: generator,
      embeddingModel: "gemini-embedding-2",
      prisma: fake.client,
    });

    expect(
      result.candidates.find(
        (candidate) => candidate.key === "deterministic",
      )?.bestMatch?.confidence,
    ).toBe("likely");
    expect(generatedTexts).not.toContain(
      expect.stringContaining(
        "Practice solving one step linear equations",
      ),
    );
    expect(generatedTexts).toHaveLength(3);
  });

  it("batches cache misses with candidate texts and bounds cache write concurrency", async () => {
    const rows = Array.from({ length: 33 }, (_, index) =>
      storedSkill({
        id: `stored-${index}`,
        title: `Existing topic ${index}`,
        objective: `Practice existing concept ${index}`,
      }),
    );
    const generatedBatchSizes: number[] = [];
    const generator: SkillSimilarityEmbeddingGenerator = async ({ texts }) => {
      generatedBatchSizes.push(texts.length);
      return texts.map((_, index) => unitEmbedding(index));
    };
    let activeWrites = 0;
    let maximumActiveWrites = 0;
    const fake = createSimilarityClient({
      onQuery: (sql) =>
        sql.includes('"semanticScore"')
          ? [{ id: "stored-0", semanticScore: 0.95 }]
          : rows,
      onExecute: async () => {
        activeWrites += 1;
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
        await new Promise<void>((resolve) => queueMicrotask(resolve));
        activeWrites -= 1;
        return 1;
      },
    });

    const result = await findSimilarSkillsForUser({
      userId: "user-1",
      candidates: [
        {
          key: "candidate",
          title: "Ocean salinity reasoning",
          objective: "Relate evaporation to salt concentration",
        },
      ],
      embeddingGenerator: generator,
      embeddingModel: "gemini-embedding-2",
      prisma: fake.client,
    });

    expect(generatedBatchSizes).toEqual([
      SKILL_SIMILARITY_EMBEDDING_BATCH_SIZE,
      2,
    ]);
    expect(fake.seenExecutions).toHaveLength(rows.length);
    expect(maximumActiveWrites).toBe(
      SKILL_SIMILARITY_CACHE_WRITE_BATCH_SIZE,
    );
    expect(result.semanticStatus).toBe("used");
    expect(result.candidates[0]?.bestMatch).toMatchObject({
      confidence: "likely",
      skill: { id: "stored-0" },
    });
  });

  it("reuses a valid stored cache and embeds only the transient candidate", async () => {
    const valid = storedSkill({
      id: "stored",
      title: "Cellular respiration",
      objective: "Trace energy through glycolysis",
    });
    const fingerprint = buildSkillSimilarityFingerprint(valid);
    valid.hasSimilarityEmbedding = true;
    valid.similarityEmbeddingModel = "gemini-embedding-2";
    valid.similarityEmbeddingFingerprint = fingerprint;
    const generatedBatchSizes: number[] = [];
    const fake = createSimilarityClient({
      onQuery: (sql) =>
        sql.includes('"semanticScore"')
          ? [{ id: "stored", semanticScore: 0.91 }]
          : [valid],
    });

    const result = await findSimilarSkillsForUser({
      userId: "user-1",
      candidates: [
        {
          key: "candidate",
          title: "How cells release usable energy",
          objective: "Explain ATP production from nutrients",
        },
      ],
      embeddingGenerator: async ({ texts }) => {
        generatedBatchSizes.push(texts.length);
        return texts.map(() => unitEmbedding());
      },
      embeddingModel: "gemini-embedding-2",
      prisma: fake.client,
    });

    expect(generatedBatchSizes).toEqual([1]);
    expect(fake.seenExecutions).toHaveLength(0);
    expect(result.semanticStatus).toBe("used");
    expect(result.candidates[0]?.bestMatch?.confidence).toBe("possible");
  });

  it("returns deterministic matches when semantic generation is unavailable", async () => {
    const rows = [
      storedSkill({
        id: "possible",
        title: "Photosynthesis",
        objective: "Identify leaf anatomy",
      }),
    ];
    const fake = createSimilarityClient({
      onQuery: () => rows,
    });

    const result = await findSimilarSkillsForUser({
      userId: "user-1",
      candidates: [
        {
          key: "candidate",
          title: "Photosynthesis",
          objective: "Explain light-dependent reactions",
        },
      ],
      embeddingGenerator: async () => {
        throw new Error("embedding service unavailable");
      },
      embeddingModel: "gemini-embedding-2",
      prisma: fake.client,
    });

    expect(result.semanticStatus).toBe("unavailable");
    expect(result.candidates[0]?.bestMatch).toMatchObject({
      confidence: "possible",
      skill: { id: "possible" },
    });
  });

  it("invalidates a cache only through the scoped update helper", async () => {
    const fake = createSimilarityClient({
      onQuery: () => [],
      onExecute: () => 1,
    });

    await expect(
      invalidateSkillSimilarityCache({
        userId: "user-1",
        skillId: "skill-1",
        prisma: fake.client,
      }),
    ).resolves.toBe(true);
    expect(fake.seenExecutions).toHaveLength(1);
    expect(fake.seenExecutions[0]).toContain(
      '"similarityEmbeddingFingerprint" = NULL',
    );
    expect(fake.seenExecutions[0]).toContain('AND "userId" = ?');
  });
});
