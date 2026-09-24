import { z } from "zod";

import type { MaterialChunkSearchResult } from "@/lib/materials/retrieval";

const PAGE_SIZE = 200;
const MAX_GROUP_CHARS = 180_000;
const MAX_GROUP_CHUNKS = 120;
const MAX_GROUPS = 24;
const MAX_CONCURRENT_REQUESTS = 3;
const MAX_MATCHES = 48;
const MAX_SCAN_BUDGET_MS = 70_000;
const FALLBACK_RESERVE_MS = 20_000;

const scoreResponseSchema = z.object({
  scores: z.array(z.object({
    id: z.string(),
    relevance: z.number().int().min(0).max(3),
  }).strict()),
}).strict();

export type MuseRetrievalChunk = Omit<
  MaterialChunkSearchResult,
  "vectorScore" | "lexicalScore" | "score"
>;

export type MuseChunkRanker = (input: {
  query: string;
  chunks: MuseRetrievalChunk[];
  signal?: AbortSignal;
}) => Promise<unknown>;

export class MuseRetrievalCapacityError extends Error {
  constructor() {
    super("Material exceeds the bounded Muse retrieval scan capacity.");
    this.name = "MuseRetrievalCapacityError";
  }
}

export function getMuseScanBudgetMs(stageRemainingMs: number): number {
  return Math.min(MAX_SCAN_BUDGET_MS, Math.max(0, stageRemainingMs - FALLBACK_RESERVE_MS));
}

export function createMuseScanSignal(parentSignal: AbortSignal | undefined, budgetMs: number) {
  if (budgetMs <= 0) throw new Error("No delivery time remains for the Muse scan.");
  const timeoutSignal = AbortSignal.timeout(budgetMs);
  return parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Material retrieval was canceled.");
  }
}

/** Score every stored chunk in scope, or fail without returning partial coverage. */
export async function scanMaterialChunksWithMuse(input: {
  query: string;
  loadPage: (afterOrdinal: number, limit: number) => Promise<MuseRetrievalChunk[]>;
  supplementalChunks?: readonly MuseRetrievalChunk[];
  rank: MuseChunkRanker;
  signal?: AbortSignal;
}): Promise<{ matches: MaterialChunkSearchResult[]; scannedChunkCount: number }> {
  const groups: MuseRetrievalChunk[][] = [];
  let group: MuseRetrievalChunk[] = [];
  let groupChars = 0;
  let scannedChunkCount = 0;
  let afterOrdinal = Number.MIN_SAFE_INTEGER;
  const seenIds = new Set<string>();

  const appendChunk = (chunk: MuseRetrievalChunk) => {
    if (seenIds.has(chunk.id)) throw new Error("Material retrieval found a duplicate source ID.");
    seenIds.add(chunk.id);
    const chars = JSON.stringify({
      id: chunk.id,
      materialSectionId: chunk.materialSectionId,
      headingText: chunk.headingText,
      locator: chunk.locator,
      text: chunk.text,
    }).length;
    if (chars > MAX_GROUP_CHARS) throw new MuseRetrievalCapacityError();
    if (group.length > 0 &&
        (group.length >= MAX_GROUP_CHUNKS || groupChars + chars > MAX_GROUP_CHARS)) {
      groups.push(group);
      group = [];
      groupChars = 0;
    }
    if (groups.length >= MAX_GROUPS) throw new MuseRetrievalCapacityError();
    group.push(chunk);
    groupChars += chars;
    scannedChunkCount += 1;
  };

  while (true) {
    throwIfAborted(input.signal);
    const page = await input.loadPage(afterOrdinal, PAGE_SIZE);
    throwIfAborted(input.signal);
    if (page.length === 0) break;
    if (page.length > PAGE_SIZE) throw new Error("Material chunk page exceeded its limit.");

    for (const chunk of page) {
      if (chunk.ordinal <= afterOrdinal) {
        throw new Error("Material chunk scan did not advance by ordinal.");
      }
      afterOrdinal = chunk.ordinal;
      appendChunk(chunk);
    }
    if (page.length < PAGE_SIZE) break;
  }
  for (const chunk of input.supplementalChunks ?? []) {
    throwIfAborted(input.signal);
    appendChunk(chunk);
  }
  if (group.length > 0) groups.push(group);
  if (groups.length === 0) return { matches: [], scannedChunkCount: 0 };

  const controller = new AbortController();
  const abortFromParent = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abortFromParent();
  else input.signal?.addEventListener("abort", abortFromParent, { once: true });
  const scored: Array<Array<{ chunk: MuseRetrievalChunk; relevance: number }>> =
    Array.from({ length: groups.length });
  let nextGroup = 0;
  let failure: unknown;
  try {
    const settlements = await Promise.allSettled(Array.from(
      { length: Math.min(MAX_CONCURRENT_REQUESTS, groups.length) },
      async () => {
        while (nextGroup < groups.length && failure === undefined) {
          throwIfAborted(controller.signal);
          const index = nextGroup++;
          const chunks = groups[index];
          try {
            const response = scoreResponseSchema.parse(await input.rank({
              query: input.query,
              chunks,
              signal: controller.signal,
            }));
            throwIfAborted(controller.signal);
            if (response.scores.length !== chunks.length) {
              throw new Error("Muse retrieval did not score every source chunk.");
            }
            const byId = new Map(response.scores.map((score) => [score.id, score.relevance]));
            if (byId.size !== chunks.length || chunks.some((chunk) => !byId.has(chunk.id))) {
              throw new Error("Muse retrieval returned duplicate or unknown chunk IDs.");
            }
            scored[index] = chunks.map((chunk) => ({
              chunk,
              relevance: byId.get(chunk.id)!,
            }));
          } catch (error) {
            if (failure === undefined) {
              failure = error;
              controller.abort(error);
            }
          }
        }
      },
    ));
    if (failure !== undefined) throw failure;
    const rejected = settlements.find((settlement) => settlement.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
    throwIfAborted(controller.signal);
    if (scored.some((groupScores) => !groupScores)) {
      throw new Error("Muse retrieval left a source group unscored.");
    }
  } finally {
    input.signal?.removeEventListener("abort", abortFromParent);
  }

  const matches = scored.flat()
    .filter(({ relevance }) => relevance > 0)
    .sort((a, b) => b.relevance - a.relevance || a.chunk.ordinal - b.chunk.ordinal)
    .slice(0, MAX_MATCHES)
    .map(({ chunk, relevance }) => ({
      ...chunk,
      vectorScore: relevance / 3,
      lexicalScore: 0,
      score: relevance / 3,
    }));
  return { matches, scannedChunkCount };
}
