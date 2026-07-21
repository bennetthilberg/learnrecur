import { PDFDocument } from "pdf-lib";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildLocalizedMaterialContext,
  createMetaMuseMaterialOcrGenerator,
  createPdfPageSlice,
} from "@/lib/materials/evidence";

describe("localized material evidence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
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

  it("refuses to silently drop relevant pages when a scope exceeds the media limit", async () => {
    const source = await PDFDocument.create();
    for (let index = 0; index < 20; index += 1) {
      source.addPage();
    }

    await expect(
      createPdfPageSlice({
        bytes: Buffer.from(await source.save()),
        pageRanges: [
          { start: 1, end: 10 },
          { start: 8, end: 18 },
        ],
        maxPages: 8,
      }),
    ).rejects.toThrow("18 relevant PDF pages exceed the 8-page source evidence limit");
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

  it("gives Meta Muse the actual scanned PDF slice when OCR falls back", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({ pages: [{ pageNumber: 7, text: "A diagram." }] }),
                },
              ],
            },
          ],
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createMetaMuseMaterialOcrGenerator({
        apiKey: "LLM|123|secret",
        baseUrl: "https://api.meta.ai/v1",
        model: "muse-spark-1.1",
      })({ pdfBytes: Buffer.from("%PDF slice"), pageNumbers: [7] }),
    ).resolves.toEqual({ pages: [{ pageNumber: 7, text: "A diagram." }] });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.input[0].content).toEqual(
      expect.arrayContaining([
        {
          type: "input_file",
          filename: "material-pages.pdf",
          file_data: "data:application/pdf;base64,JVBERiBzbGljZQ==",
          detail: "high",
        },
      ]),
    );
  });
});
