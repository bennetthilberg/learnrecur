import { describe, expect, it } from "vitest";

import {
  MATERIAL_LOCATOR_VERSION,
  materialScopePlanSchema,
  skillSourceLocatorSchema,
} from "@/lib/materials/contracts";

describe("material contracts", () => {
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
          kind: "web",
          anchors: [{ url: "http://example.com/chapter-4", heading: "Concept one" }],
        },
      }),
    ).toThrow();
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
  });
});
