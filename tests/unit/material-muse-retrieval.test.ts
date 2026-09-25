import { describe, expect, it, vi } from "vitest";

import {
  createMuseScanSignal,
  getMuseScanBudgetMs,
  scanMaterialChunksWithMuse,
  type MuseRetrievalChunk,
} from "@/lib/materials/muse-retrieval";

function chunk(index: number, text = `Teaching passage ${index}`): MuseRetrievalChunk {
  return {
    id: `chunk-${index}`,
    materialRevisionId: "revision-1",
    materialSectionId: "section-1",
    sourceFileId: "file-1",
    ordinal: index,
    text,
    tokenEstimate: 20,
    locator: { page: index + 1 },
    headingText: "Lesson",
  };
}

describe("Muse material retrieval", () => {
  it.each([
    { remaining: 105_000, budget: 70_000 },
    { remaining: 50_000, budget: 30_000 },
    { remaining: 20_000, budget: 0 },
  ])("reserves lexical fallback time from a $remaining ms stage", ({ remaining, budget }) => {
    expect(getMuseScanBudgetMs(remaining)).toBe(budget);
  });

  it("times out the Muse child signal without aborting the parent", async () => {
    const parent = new AbortController();
    const child = createMuseScanSignal(parent.signal, 5);
    await new Promise<void>((resolve) => child.addEventListener("abort", () => resolve(), { once: true }));
    expect(child.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  it("propagates parent cancellation to the Muse child signal", () => {
    const parent = new AbortController();
    const child = createMuseScanSignal(parent.signal, 10_000);
    parent.abort(new Error("delivery ended"));
    expect(child.reason).toEqual(new Error("delivery ended"));
  });

  it("scans every page and finds a semantic match with no shared query words", async () => {
    const chunks = Array.from({ length: 251 }, (_, index) =>
      chunk(index, index === 241 ? "Yo me levanto antes del amanecer." : `Other lesson ${index}`),
    );
    const seen: string[] = [];
    const rank = vi.fn(async ({ chunks: group }: { chunks: MuseRetrievalChunk[] }) => {
      seen.push(...group.map((item) => item.id));
      return {
        scores: group.map((item) => ({
          id: item.id,
          relevance: item.id === "chunk-241" ? 3 : 0,
        })),
      };
    });

    const result = await scanMaterialChunksWithMuse({
      query: "Spanish reflexive actions",
      loadPage: async (afterOrdinal, limit) =>
        chunks.filter((item) => item.ordinal > afterOrdinal).slice(0, limit),
      rank,
    });

    expect(seen).toEqual(chunks.map((item) => item.id));
    expect(result.scannedChunkCount).toBe(chunks.length);
    expect(result.matches.map((item) => item.id)).toEqual(["chunk-241"]);
    expect(rank.mock.calls.length).toBeGreaterThan(1);
  });

  it("keeps long textbook chunks in smaller complete scoring requests", async () => {
    const chunks = Array.from({ length: 279 }, (_, index) =>
      chunk(index, `Lesson ${index} ${"x".repeat(3_000)}`),
    );
    const groupSizes: number[] = [];
    const result = await scanMaterialChunksWithMuse({
      query: "daily routines",
      loadPage: async (afterOrdinal, limit) =>
        chunks.filter((item) => item.ordinal > afterOrdinal).slice(0, limit),
      rank: async ({ chunks: group }) => {
        groupSizes.push(group.length);
        if (group.length > 30) throw new Error("Muse omitted scores for an oversized group");
        return { scores: group.map((item) => ({ id: item.id, relevance: 1 })) };
      },
    });
    expect(result.scannedChunkCount).toBe(279);
    expect(groupSizes.length).toBeGreaterThan(8);
    expect(Math.max(...groupSizes)).toBeLessThanOrEqual(30);
  });

  it("includes chunks with negative ordinals", async () => {
    const source = [chunk(-2), chunk(0)];
    const result = await scanMaterialChunksWithMuse({
      query: "topic",
      loadPage: async (afterOrdinal) =>
        source.filter((item) => item.ordinal > afterOrdinal),
      rank: async ({ chunks }) => ({
        scores: chunks.map((item) => ({ id: item.id, relevance: 3 })),
      }),
    });
    expect(result.matches.map((item) => item.id)).toEqual(["chunk--2", "chunk-0"]);
  });

  it("scores supplemental OCR evidence after stored chunks", async () => {
    const ocr = { ...chunk(30, "Yo me levanto cada mañana."), id: "material-page:30" };
    const seen: string[] = [];
    const result = await scanMaterialChunksWithMuse({
      query: "personal routines",
      loadPage: async (afterOrdinal) => afterOrdinal < 0 ? [chunk(0)] : [],
      supplementalChunks: [ocr],
      rank: async ({ chunks }) => {
        seen.push(...chunks.map((item) => item.id));
        return { scores: chunks.map((item) => ({
          id: item.id,
          relevance: item.id === ocr.id ? 3 : 0,
        })) };
      },
    });
    expect(seen).toEqual(["chunk-0", ocr.id]);
    expect(result.scannedChunkCount).toBe(2);
    expect(result.matches.map((item) => item.id)).toEqual([ocr.id]);
  });

  it.each([
    { label: "missing score", scores: [{ id: "chunk-0", relevance: 3 }] },
    { label: "duplicate score", scores: [{ id: "chunk-0", relevance: 3 }, { id: "chunk-0", relevance: 0 }] },
    { label: "unknown id", scores: [{ id: "chunk-0", relevance: 3 }, { id: "foreign", relevance: 0 }] },
    { label: "invalid score", scores: [{ id: "chunk-0", relevance: 4 }, { id: "chunk-1", relevance: 0 }] },
  ])("rejects $label rather than accepting partial coverage", async ({ scores }) => {
    await expect(
      scanMaterialChunksWithMuse({
        query: "topic",
        loadPage: async (afterOrdinal) =>
          afterOrdinal < 0 ? [chunk(0), chunk(1)] : [],
        rank: async () => ({ scores }),
      }),
    ).rejects.toThrow();
  });

  it("does not call Muse when a source exceeds the bounded scan budget", async () => {
    const rank = vi.fn();
    await expect(
      scanMaterialChunksWithMuse({
        query: "topic",
        loadPage: async (afterOrdinal) =>
          afterOrdinal < 0 ? [chunk(0, "x".repeat(4_400_000))] : [],
        rank,
      }),
    ).rejects.toThrow(/capacity|budget|large/i);
    expect(rank).not.toHaveBeenCalled();
  });

  it("rejects scopes needing more than 24 requests before sending source text", async () => {
    const chunks = Array.from({ length: 2_881 }, (_, index) => chunk(index));
    const rank = vi.fn();
    await expect(scanMaterialChunksWithMuse({
      query: "topic",
      loadPage: async (afterOrdinal, limit) =>
        chunks.filter((item) => item.ordinal > afterOrdinal).slice(0, limit),
      rank,
    })).rejects.toThrow(/capacity/);
    expect(rank).not.toHaveBeenCalled();
  });

  it("rejects the whole scan if one Muse request fails", async () => {
    const chunks = Array.from({ length: 241 }, (_, index) => chunk(index));
    await expect(scanMaterialChunksWithMuse({
      query: "topic",
      loadPage: async (afterOrdinal, limit) =>
        chunks.filter((item) => item.ordinal > afterOrdinal).slice(0, limit),
      rank: async ({ chunks: group }) => {
        if (group.some((item) => item.id === "chunk-200")) {
          throw new Error("Meta rate limit");
        }
        return { scores: group.map((item) => ({ id: item.id, relevance: 3 })) };
      },
    })).rejects.toThrow("Meta rate limit");
  });

  it("aborts between pages without returning partially scanned matches", async () => {
    const controller = new AbortController();
    await expect(
      scanMaterialChunksWithMuse({
        query: "topic",
        signal: controller.signal,
        loadPage: async (afterOrdinal) => {
          if (afterOrdinal >= 0) controller.abort(new Error("delivery ended"));
          return afterOrdinal < 0
            ? Array.from({ length: 200 }, (_, index) => chunk(index))
            : [];
        },
        rank: async ({ chunks: group }) => ({
          scores: group.map((item) => ({ id: item.id, relevance: 3 })),
        }),
      }),
    ).rejects.toThrow("delivery ended");
  });
});
