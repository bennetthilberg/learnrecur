import { describe, expect, it } from "vitest";

import { MaterialPageTextStatus, StudyMaterialKind } from "@/generated/prisma/client";
import {
  DEFAULT_MATERIAL_READ_MAX_CHARS,
  MAX_MATERIAL_READ_MAX_CHARS,
  buildMaterialReadUnits,
  decodeMaterialReadCursor,
  materialReadContentSchema,
  paginateMaterialReadUnits,
} from "@/lib/materials/reader";

const section = (input: {
  id: string;
  parentId?: string | null;
  ordinal: number;
  title: string;
  headingPath?: string[];
  pageStart?: number | null;
  pageEnd?: number | null;
}) => ({
  id: input.id,
  parentId: input.parentId ?? null,
  ordinal: input.ordinal,
  level: input.parentId ? 2 : 1,
  title: input.title,
  headingPath: input.headingPath ?? [input.title],
  pageStart: input.pageStart ?? null,
  pageEnd: input.pageEnd ?? null,
  url: "https://example.test/material",
  anchor: input.id,
});

const chunk = (input: {
  id: string;
  sectionId: string;
  ordinal: number;
  text: string;
  page?: number;
}) => ({
  id: input.id,
  materialSectionId: input.sectionId,
  ordinal: input.ordinal,
  text: input.text,
  contentHash: `hash-${input.id}`,
  locator: input.page
    ? { kind: "pdf", pageRange: { start: input.page, end: input.page } }
    : { kind: "web", url: "https://example.test/material", anchor: input.id },
  headingText: null,
});

describe("material read content contract", () => {
  it("requires one selector and applies the documented character bounds", () => {
    expect(
      materialReadContentSchema.parse({
        material_id: "material-1",
        expected_revision_id: "revision-1",
        section_id: "section-1",
      }).max_chars,
    ).toBe(DEFAULT_MATERIAL_READ_MAX_CHARS);
    expect(
      materialReadContentSchema.parse({
        material_id: "material-1",
        expected_revision_id: "revision-1",
        page_range: { start: 1, end: 10 },
        max_chars: MAX_MATERIAL_READ_MAX_CHARS,
      }).max_chars,
    ).toBe(MAX_MATERIAL_READ_MAX_CHARS);
    expect(() =>
      materialReadContentSchema.parse({
        material_id: "material-1",
        expected_revision_id: "revision-1",
        section_id: "section-1",
        page_range: { start: 1, end: 1 },
      }),
    ).toThrow(/exactly one/i);
    expect(() =>
      materialReadContentSchema.parse({
        material_id: "material-1",
        expected_revision_id: "revision-1",
        page_range: { start: 1, end: 11 },
      }),
    ).toThrow(/ten pages/i);
    expect(() =>
      materialReadContentSchema.parse({
        material_id: "material-1",
        expected_revision_id: "revision-1",
        section_id: "section-1",
        max_chars: MAX_MATERIAL_READ_MAX_CHARS + 1,
      }),
    ).toThrow();
  });
});

describe("material read traversal", () => {
  it("traverses child sections, preserves paragraphs and accents, and identifies chunk overlap", () => {
    const shared = "Este párrafo compartido mantiene su forma.\n\n";
    const sections = [
      section({ id: "chapter-a", ordinal: 0, title: "Lección repetida", headingPath: ["Lección repetida"] }),
      section({ id: "lesson-a", parentId: "chapter-a", ordinal: 1, title: "Lección repetida", headingPath: ["Lección repetida", "Lección repetida"] }),
      section({ id: "chapter-b", ordinal: 2, title: "Lección repetida", headingPath: ["Lección repetida"] }),
    ];
    const units = buildMaterialReadUnits({
      kind: StudyMaterialKind.WEB,
      revisionId: "revision-1",
      selector: { kind: "section", sectionId: "chapter-a" },
      sections,
      chunks: [
        chunk({ id: "chunk-a", sectionId: "lesson-a", ordinal: 0, text: `Inicio\n\n${shared}` }),
        chunk({ id: "chunk-b", sectionId: "lesson-a", ordinal: 1, text: `${shared}fin de la lección.` }),
        chunk({ id: "chunk-c", sectionId: "chapter-b", ordinal: 2, text: "No debe aparecer." }),
      ],
    });

    expect(units).toHaveLength(2);
    expect(units[0]).toMatchObject({
      sectionId: "lesson-a",
      sectionPath: ["Lección repetida", "Lección repetida"],
      text: `Inicio\n\n${shared}`,
    });
    expect(units[1]).toMatchObject({
      id: "chunk:chunk-b",
      text: "fin de la lección.",
      overlap: { withChunkId: "chunk-a" },
    });
    expect(units.map((unit) => unit.sectionId)).not.toContain("chapter-b");

    let cursor: string | undefined;
    let combined = "";
    do {
      const page = paginateMaterialReadUnits({
        units,
        userId: "owner-a",
        revisionId: "revision-1",
        selector: { kind: "section", sectionId: "chapter-a" },
        maxChars: 9,
        cursor,
      });
      combined += page.segments.map((segment) => segment.text).join("");
      cursor = page.nextCursor ?? undefined;
      if (!page.nextCursor) expect(page.fullyTraversed).toBe(true);
    } while (cursor);
    expect(combined).toBe(`Inicio\n\n${shared}fin de la lección.`);
  });

  it("splits a Unicode chunk at exact code-point offsets without losing boundaries", () => {
    const text = "mañana\n\n¿Dónde estás? 🧭";
    const units = buildMaterialReadUnits({
      kind: StudyMaterialKind.WEB,
      revisionId: "revision-1",
      selector: { kind: "section", sectionId: "section-1" },
      sections: [section({ id: "section-1", ordinal: 0, title: "Preguntas" })],
      chunks: [chunk({ id: "chunk-1", sectionId: "section-1", ordinal: 0, text })],
    });

    let cursor: string | undefined;
    let combined = "";
    const offsets: Array<{ start: number; end: number }> = [];
    do {
      const page = paginateMaterialReadUnits({
        units,
        userId: "owner-a",
        revisionId: "revision-1",
        selector: { kind: "section", sectionId: "section-1" },
        maxChars: 4,
        cursor,
      });
      for (const segment of page.segments) {
        combined += segment.text;
        if (segment.text_offset) offsets.push(segment.text_offset);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    expect(combined).toBe(text);
    expect(offsets[0]).toEqual({ start: 0, end: 4 });
    expect(offsets.at(-1)?.end).toBe(Array.from(text).length);
    expect(combined).toContain("\n\n");
    expect(combined).toContain("mañana");
    expect(combined).toContain("🧭");
  });

  it("binds reusable cursors to the account, revision, selector, and immutable scope", () => {
    const selector = { kind: "section" as const, sectionId: "section-1" };
    const units = buildMaterialReadUnits({
      kind: StudyMaterialKind.WEB,
      revisionId: "revision-1",
      selector,
      sections: [section({ id: "section-1", ordinal: 0, title: "Section" })],
      chunks: [chunk({ id: "chunk-1", sectionId: "section-1", ordinal: 0, text: "A long enough stable text." })],
    });
    const first = paginateMaterialReadUnits({
      units,
      userId: "owner-a",
      revisionId: "revision-1",
      selector,
      maxChars: 4,
    });
    expect(first.nextCursor).toBeTruthy();
    expect(
      paginateMaterialReadUnits({
        units,
        userId: "owner-a",
        revisionId: "revision-1",
        selector,
        maxChars: 4,
        cursor: first.nextCursor ?? undefined,
      }),
    ).toEqual(
      paginateMaterialReadUnits({
        units,
        userId: "owner-a",
        revisionId: "revision-1",
        selector,
        maxChars: 4,
        cursor: first.nextCursor ?? undefined,
      }),
    );
    expect(() =>
      paginateMaterialReadUnits({
        units,
        userId: "owner-b",
        revisionId: "revision-1",
        selector,
        maxChars: 4,
        cursor: first.nextCursor ?? undefined,
      }),
    ).toThrow(/does not match/i);
    expect(() =>
      paginateMaterialReadUnits({
        units,
        userId: "owner-a",
        revisionId: "revision-1",
        selector: { kind: "section", sectionId: "other-section" },
        maxChars: 4,
        cursor: first.nextCursor ?? undefined,
      }),
    ).toThrow(/does not match/i);
    expect(() => decodeMaterialReadCursor("not-a-cursor")).toThrow(/invalid/i);
  });

  it("honors PDF page boundaries and reports missing OCR without starting OCR", () => {
    const units = buildMaterialReadUnits({
      kind: StudyMaterialKind.PDF,
      revisionId: "revision-1",
      selector: { kind: "page_range", start: 2, end: 3 },
      sections: [section({ id: "section-1", ordinal: 0, title: "Chapter", pageStart: 1, pageEnd: 3 })],
      chunks: [
        chunk({ id: "page-one", sectionId: "section-1", ordinal: 0, text: "outside range", page: 1 }),
        chunk({ id: "page-two", sectionId: "section-1", ordinal: 1, text: "page two text", page: 2 }),
      ],
      pages: [
        {
          id: "page-2",
          pageNumber: 2,
          embeddedText: null,
          ocrText: null,
          textStatus: MaterialPageTextStatus.NEEDS_OCR,
          contentHash: "page-2-hash",
        },
        {
          id: "page-3",
          pageNumber: 3,
          embeddedText: null,
          ocrText: null,
          textStatus: MaterialPageTextStatus.OCR_FAILED,
          contentHash: "page-3-hash",
        },
      ],
    });
    const page = paginateMaterialReadUnits({
      units,
      userId: "owner-a",
      revisionId: "revision-1",
      selector: { kind: "page_range", start: 2, end: 3 },
      maxChars: 100,
    });
    expect(page.segments.map((segment) => segment.chunk_id)).not.toContain("page-one");
    expect(page.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chunk_id: "page-two", page_number: 2, text: "page two text" }),
        expect.objectContaining({ kind: "gap", page_number: 2, extraction_status: "needs_ocr" }),
        expect.objectContaining({ kind: "gap", page_number: 3, extraction_status: "ocr_failed" }),
      ]),
    );
    expect(page.nextCursor).toBeNull();
    expect(page.fullyTraversed).toBe(false);
    expect(page.extractionGapCount).toBe(2);
    expect(page.extractionGaps.map((gap) => gap.page_number)).toEqual([2, 3]);
  });

  it("does not include a multi-page chunk that crosses a requested page boundary", () => {
    const units = buildMaterialReadUnits({
      kind: StudyMaterialKind.PDF,
      revisionId: "revision-1",
      selector: { kind: "page_range", start: 2, end: 2 },
      sections: [section({ id: "section-1", ordinal: 0, title: "Chapter", pageStart: 1, pageEnd: 2 })],
      chunks: [{
        ...chunk({ id: "crossing", sectionId: "section-1", ordinal: 0, text: "page one and page two", page: 1 }),
        locator: { kind: "pdf", pageRange: { start: 1, end: 2 } },
      }],
      pages: [{
        id: "page-2",
        pageNumber: 2,
        embeddedText: null,
        ocrText: "page two text",
        textStatus: MaterialPageTextStatus.OCR_READY,
        contentHash: "page-2-hash",
      }],
    });

    expect(units.map((unit) => unit.id)).toEqual(["page:page-2"]);
    expect(units[0]?.text).toBe("page two text");
  });
});
