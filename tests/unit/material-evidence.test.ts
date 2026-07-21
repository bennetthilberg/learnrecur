import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  buildLocalizedMaterialContext,
  createPdfPageSlice,
} from "@/lib/materials/evidence";

describe("localized material evidence", () => {
  it("copies only the requested PDF pages in source order", async () => {
    const source = await PDFDocument.create();
    for (let index = 0; index < 6; index += 1) {
      source.addPage([500 + index, 700]);
    }

    const result = await createPdfPageSlice({
      bytes: Buffer.from(await source.save()),
      pageRanges: [
        { start: 2, end: 2 },
        { start: 4, end: 5 },
      ],
    });
    const sliced = await PDFDocument.load(result.bytes);

    expect(result.pageNumbers).toEqual([2, 4, 5]);
    expect(sliced.getPages().map((page) => page.getWidth())).toEqual([501, 503, 504]);
  });

  it("bounds a visual slice without expanding or duplicating overlapping ranges", async () => {
    const source = await PDFDocument.create();
    for (let index = 0; index < 20; index += 1) {
      source.addPage();
    }

    const result = await createPdfPageSlice({
      bytes: Buffer.from(await source.save()),
      pageRanges: [
        { start: 1, end: 10 },
        { start: 8, end: 18 },
      ],
      maxPages: 8,
    });

    expect(result.pageNumbers).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await expect(PDFDocument.load(result.bytes)).resolves.toHaveProperty("getPageCount");
  });

  it("builds context from cited chunks and cached OCR pages only", () => {
    const context = buildLocalizedMaterialContext({
      chunks: [
        { id: "cited-2", ordinal: 2, headingText: "Recipient pronouns", text: "Use le for one recipient." },
        { id: "cited-1", ordinal: 1, headingText: "Object pronouns", text: "Place lo before the verb." },
      ],
      evidenceChunkIds: ["cited-1", "cited-2"],
      ocrPages: [{ pageNumber: 7, ocrText: "A diagram contrasts lo and le." }],
      maxCharacters: 10_000,
    });

    expect(context).toContain("Object pronouns\nPlace lo before the verb.");
    expect(context).toContain("Recipient pronouns\nUse le for one recipient.");
    expect(context).toContain("Visual page 7\nA diagram contrasts lo and le.");
    if (!context) {
      throw new Error("expected localized context");
    }
    expect(context.indexOf("Object pronouns")).toBeLessThan(context.indexOf("Recipient pronouns"));
  });
});
