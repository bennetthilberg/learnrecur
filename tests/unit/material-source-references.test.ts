import { describe, expect, it } from "vitest";

import {
  MATERIAL_LOCATOR_VERSION,
  skillSourceLocatorSchema,
} from "@/lib/materials/contracts";
import {
  MAX_MATERIAL_SOURCE_REFERENCES,
  materialSourceReferencesSchema,
  mergeMaterialSourceLocators,
  parseAgentSpecInputWithSourceRefs,
  parseMaterialSourceReferences,
  parseSetupInputWithSourceRefs,
} from "@/lib/materials/source-references";

const sourceRef = {
  material_id: "material-1",
  expected_revision_id: "revision-1",
  section_ids: ["section-2", "section-1"],
  evidence_chunk_ids: ["chunk-2", "chunk-1"],
};

describe("material source reference contracts", () => {
  it("requires scoped evidence and caps each request at eight references", () => {
    expect(() => materialSourceReferencesSchema.parse([{}])).toThrow();
    expect(() =>
      materialSourceReferencesSchema.parse(
        Array.from({ length: MAX_MATERIAL_SOURCE_REFERENCES + 1 }, (_, index) => ({
          material_id: `material-${index}`,
          expected_revision_id: `revision-${index}`,
          section_ids: [`section-${index}`],
        })),
      ),
    ).toThrow(/8/);
    expect(() =>
      materialSourceReferencesSchema.parse([
        { ...sourceRef, storage_key: "private/book.pdf" },
      ]),
    ).toThrow();
  });

  it("normalizes source identifiers before they enter an operation snapshot", () => {
    expect(parseMaterialSourceReferences([sourceRef])).toEqual([
      {
        material_id: "material-1",
        expected_revision_id: "revision-1",
        section_ids: ["section-1", "section-2"],
        evidence_chunk_ids: ["chunk-1", "chunk-2"],
      },
    ]);

    const input = parseAgentSpecInputWithSourceRefs({
      idempotency_key: "source-ref-operation-1",
      items: [
        {
          client_reference: "skill-1",
          skill: {
            title: "Spanish pronoun placement",
            objective: "Choose where a direct object pronoun belongs in a sentence.",
            rules: [],
            examples: [],
            exerciseConstraints: "",
            tags: ["spanish"],
          },
          source_refs: [sourceRef],
        },
      ],
    });
    expect(input.items[0].source_refs).toEqual([
      {
        material_id: "material-1",
        expected_revision_id: "revision-1",
        section_ids: ["section-1", "section-2"],
        evidence_chunk_ids: ["chunk-1", "chunk-2"],
      },
    ]);
  });

  it("keeps setup parsing and its source-reference payload in parity with spec operations", () => {
    const input = parseSetupInputWithSourceRefs({
      idempotency_key: "source-ref-setup-1",
      skills: [
        {
          kind: "create_specs",
          client_reference: "skill-1",
          skill: {
            title: "Spanish pronoun placement",
            objective: "Choose where a direct object pronoun belongs in a sentence.",
            rules: [],
            examples: [],
            exerciseConstraints: "",
            tags: ["spanish"],
          },
          source_refs: [sourceRef],
        },
      ],
    });
    expect(input.skills[0]).toMatchObject({
      kind: "create_specs",
      source_refs: [
        expect.objectContaining({
          section_ids: ["section-1", "section-2"],
          evidence_chunk_ids: ["chunk-1", "chunk-2"],
        }),
      ],
    });
  });

  it("merges compatible canonical locators without losing evidence or page ranges", () => {
    const first = skillSourceLocatorSchema.parse({
      version: MATERIAL_LOCATOR_VERSION,
      materialRevisionId: "revision-1",
      materialSectionIds: ["section-1"],
      evidenceChunkIds: ["chunk-1"],
      source: { kind: "pdf", pageRanges: [{ start: 10, end: 12 }] },
    });
    const second = skillSourceLocatorSchema.parse({
      version: MATERIAL_LOCATOR_VERSION,
      materialRevisionId: "revision-1",
      materialSectionIds: ["section-2"],
      evidenceChunkIds: ["chunk-2"],
      source: { kind: "pdf", pageRanges: [{ start: 14, end: 15 }] },
    });
    expect(mergeMaterialSourceLocators([first, second])).toEqual({
      version: MATERIAL_LOCATOR_VERSION,
      materialRevisionId: "revision-1",
      materialSectionIds: ["section-1", "section-2"],
      evidenceChunkIds: ["chunk-1", "chunk-2"],
      source: { kind: "pdf", pageRanges: [{ start: 10, end: 12 }, { start: 14, end: 15 }] },
    });
    expect(() =>
      mergeMaterialSourceLocators([
        first,
        { ...second, materialRevisionId: "different-revision" },
      ]),
    ).toThrow(/same material revision/i);
  });
});
