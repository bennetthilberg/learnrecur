import { describe, expect, it } from "vitest";

import {
  activateBatchInputSchema,
  discoverWebsiteMaterialInputSchema,
  MATERIAL_LOCATOR_VERSION,
  materialScopePlanSchema,
  materialScopeResolutionSchema,
  skillSourceLocatorSchema,
} from "@/lib/materials/contracts";

describe("material contracts", () => {
  it("reports malformed website URLs without throwing from refinement", () => {
    expect(() => discoverWebsiteMaterialInputSchema.safeParse({ url: "not a url" })).not.toThrow();
    expect(discoverWebsiteMaterialInputSchema.safeParse({ url: "not a url" }).success).toBe(false);
  });

  it("accepts a versioned PDF locator with bounded, ordered evidence", () => {
    const locator = skillSourceLocatorSchema.parse({
      version: MATERIAL_LOCATOR_VERSION,
      materialRevisionId: "revision_1",
      materialSectionIds: ["section_4_1"],
      evidenceChunkIds: ["chunk_1", "chunk_2"],
      source: {
        kind: "pdf",
        pageRanges: [
          { start: 48, end: 51 },
          { start: 56, end: 56 },
        ],
      },
    });

    expect(locator.source.kind).toBe("pdf");
  });

  it("rejects invalid PDF ranges and non-HTTPS web evidence", () => {
    expect(() =>
      skillSourceLocatorSchema.parse({
        version: MATERIAL_LOCATOR_VERSION,
        materialRevisionId: "revision_1",
        materialSectionIds: ["section_4_1"],
        evidenceChunkIds: ["chunk_1"],
        source: {
          kind: "pdf",
          pageRanges: [{ start: 12, end: 8 }],
        },
      }),
    ).toThrow();

    expect(() =>
      skillSourceLocatorSchema.parse({
        version: MATERIAL_LOCATOR_VERSION,
        materialRevisionId: "revision_1",
        materialSectionIds: ["section_4_1"],
        evidenceChunkIds: ["chunk_1"],
        source: {
          kind: "pdf",
          pageRanges: [
            { start: 1, end: 5 },
            { start: 3, end: 8 },
          ],
        },
      }),
    ).toThrow(/overlap/i);

    expect(() =>
      skillSourceLocatorSchema.parse({
        version: MATERIAL_LOCATOR_VERSION,
        materialRevisionId: "revision_1",
        materialSectionIds: ["section_4_1"],
        evidenceChunkIds: ["chunk_1"],
        source: {
          kind: "web",
          anchors: [{ url: "http://example.com/chapter-4", heading: "Concept one" }],
        },
      }),
    ).toThrow();
  });

  it("accepts unique HTTPS web anchors and rejects duplicate anchor tuples", () => {
    const webLocator = {
      version: MATERIAL_LOCATOR_VERSION,
      materialRevisionId: "revision_1",
      materialSectionIds: ["section_4_1"],
      evidenceChunkIds: ["chunk_1"],
      source: {
        kind: "web" as const,
        anchors: [
          {
            url: "https://example.com/chapter-4",
            heading: "Concept one",
            anchor: "concept-one",
          },
        ],
      },
    };

    expect(skillSourceLocatorSchema.parse(webLocator).source.kind).toBe("web");
    expect(() =>
      skillSourceLocatorSchema.parse({
        ...webLocator,
        source: {
          ...webLocator.source,
          anchors: [webLocator.source.anchors[0], webLocator.source.anchors[0]],
        },
      }),
    ).toThrow(/unique/i);
  });

  it("requires a confirmed, unambiguous plan and caps a batch at ten skills", () => {
    const item = {
      key: "chapter-4-concept-1",
      title: "Spanish direct object pronouns",
      objective: "Choose and place direct object pronouns in short sentences.",
      materialSectionIds: ["section_4_1"],
      evidenceChunkIds: ["chunk_1"],
      locator: {
        version: MATERIAL_LOCATOR_VERSION,
        materialRevisionId: "revision_1",
        materialSectionIds: ["section_4_1"],
        evidenceChunkIds: ["chunk_1"],
        source: { kind: "pdf", pageRanges: [{ start: 48, end: 51 }] },
      },
    } as const;

    const plan = materialScopePlanSchema.parse({
      version: 1,
      materialRevisionId: "revision_1",
      instruction: "Make a skill for the first concept in chapter four.",
      resolutionStatus: "resolved",
      resolvedScopeLabel: "Chapter 4, Direct object pronouns, pages 48-51",
      warnings: [],
      items: [item],
    });

    expect(plan.items).toHaveLength(1);

    expect(() =>
      materialScopePlanSchema.parse({
        ...plan,
        items: Array.from({ length: 11 }, (_, index) => ({
          ...item,
          key: `skill-${index + 1}`,
        })),
      }),
    ).toThrow();

    expect(() =>
      materialScopePlanSchema.parse({
        ...plan,
        resolutionStatus: "ambiguous",
        items: [item],
      }),
    ).toThrow();

    for (const mismatch of [
      { materialSectionIds: ["section_4_2"] },
      { evidenceChunkIds: ["chunk_2"] },
    ]) {
      expect(() =>
        materialScopePlanSchema.parse({
          ...plan,
          items: [{ ...item, ...mismatch }],
        }),
      ).toThrow(/evidence must match/i);
    }
  });

  it("requires clarification for ambiguous scope resolutions", () => {
    const baseResolution = {
      version: 1 as const,
      materialRevisionId: "revision_1",
      instruction: "Use chapter four.",
      resolutionStatus: "ambiguous" as const,
      resolvedScopeLabel: "Chapter four",
      warnings: [],
      items: [],
    };

    expect(() => materialScopeResolutionSchema.parse(baseResolution)).toThrow(/clarification/i);
    expect(
      materialScopeResolutionSchema.parse({
        ...baseResolution,
        clarification: "Which chapter titled Chapter four did you mean?",
      }).clarification,
    ).toMatch(/which chapter/i);

    const resolvedItem = {
      key: "concept-one",
      title: "Concept one",
      objective: "Practice concept one.",
      materialSectionIds: ["section_1"],
      evidenceChunkIds: ["chunk_1"],
      locator: {
        version: MATERIAL_LOCATOR_VERSION,
        materialRevisionId: baseResolution.materialRevisionId,
        materialSectionIds: ["section_1"],
        evidenceChunkIds: ["chunk_1"],
        source: { kind: "pdf" as const, pageRanges: [{ start: 1, end: 1 }] },
      },
    };

    expect(() =>
      materialScopeResolutionSchema.parse({
        ...baseResolution,
        clarification: "Please clarify.",
        items: [resolvedItem, resolvedItem],
      }),
    ).toThrow();
  });

  it("requires a nonempty, unique activation selection capped at ten items", () => {
    expect(
      activateBatchInputSchema.parse({ batchId: "batch_1", itemIds: ["item_1", "item_2"] }),
    ).toEqual({ batchId: "batch_1", itemIds: ["item_1", "item_2"] });
    expect(() =>
      activateBatchInputSchema.parse({ batchId: "batch_1", itemIds: [] }),
    ).toThrow();
    expect(() =>
      activateBatchInputSchema.parse({ batchId: "batch_1", itemIds: ["item_1", "item_1"] }),
    ).toThrow();
    expect(() =>
      activateBatchInputSchema.parse({
        batchId: "batch_1",
        itemIds: Array.from({ length: 11 }, (_, index) => `item_${index}`),
      }),
    ).toThrow();
  });

  it("rejects a resolved scope preview with no proposed skills", () => {
    expect(
      materialScopeResolutionSchema.safeParse({
        version: 1,
        materialRevisionId: "revision_1",
        instruction: "Make a skill from chapter four.",
        resolutionStatus: "resolved",
        resolvedScopeLabel: "Chapter 4",
        warnings: [],
        items: [],
      }).success,
    ).toBe(false);
  });
});
