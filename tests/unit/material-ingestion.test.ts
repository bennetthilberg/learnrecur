import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  buildPdfIndex,
  extractPdfPages,
  type ExtractedPdfPage,
} from "@/lib/materials/pdf";
import {
  discoverBookWebsite,
  validatePublicHttpsUrl,
} from "@/lib/materials/web";
import { getQuickPdfDisposition } from "@/lib/materials/quick-flow";

describe("PDF material ingestion", () => {
  it("inspects actual PDF pages and identifies pages that need OCR", async () => {
    const document = await PDFDocument.create();
    const font = await document.embedFont(StandardFonts.Helvetica);
    const textPage = document.addPage([612, 792]);
    textPage.drawText(
      "Chapter 4 Direct object pronouns replace nouns that receive the action in a sentence.",
      { x: 48, y: 720, size: 12, font },
    );
    document.addPage([612, 792]);

    const extracted = await extractPdfPages(Buffer.from(await document.save()));

    expect(extracted.pageCount).toBe(2);
    expect(extracted.pages[0]).toMatchObject({ pageNumber: 1, needsOcr: false });
    expect(extracted.pages[0].text).toContain("Direct object pronouns");
    expect(extracted.pages[1]).toMatchObject({ pageNumber: 2, needsOcr: true });
  });

  it("creates heading-aware, section-bounded chunks near the token target with overlap", () => {
    const words = Array.from({ length: 420 }, (_, index) => `word${index + 1}`);
    const pages: ExtractedPdfPage[] = [
      {
        pageNumber: 1,
        text: `Chapter 4: Direct object pronouns\n${words.slice(0, 280).join(" ")}`,
        needsOcr: false,
      },
      {
        pageNumber: 2,
        text: words.slice(280).join(" "),
        needsOcr: false,
      },
      {
        pageNumber: 3,
        text: "Chapter 5: The preterite\nCompleted past actions use the preterite.",
        needsOcr: false,
      },
    ];

    const index = buildPdfIndex(pages, { targetTokens: 120, overlapTokens: 24 });

    expect(index.sections.map((section) => section.title)).toEqual([
      "Chapter 4: Direct object pronouns",
      "Chapter 5: The preterite",
    ]);
    expect(index.chunks.length).toBeGreaterThan(3);
    expect(index.chunks.every((chunk) => chunk.tokenEstimate <= 145)).toBe(true);
    expect(index.chunks[0].pageStart).toBe(1);
    expect(index.chunks.at(-1)).toMatchObject({ pageStart: 3, pageEnd: 3 });

    const firstWords = index.chunks[0].text.split(/\s+/);
    const secondWords = index.chunks[1].text.split(/\s+/);
    expect(secondWords.slice(0, 18)).toEqual(firstWords.slice(-18));
  });
});

describe("website material discovery", () => {
  const publicResolver = async () => ["93.184.216.34"];

  it("rejects non-HTTPS, credentialed, loopback, and private-network URLs", async () => {
    await expect(validatePublicHttpsUrl("http://example.com/book", publicResolver)).rejects.toThrow(
      /https/i,
    );
    await expect(
      validatePublicHttpsUrl("https://user:password@example.com/book", publicResolver),
    ).rejects.toThrow(/credentials/i);
    await expect(validatePublicHttpsUrl("https://127.0.0.1/book", publicResolver)).rejects.toThrow(
      /public/i,
    );
    await expect(
      validatePublicHttpsUrl("https://textbook.example/book", async () => ["10.0.0.8"]),
    ).rejects.toThrow(/public/i);
    await expect(validatePublicHttpsUrl("https://example.com/book", publicResolver)).resolves.toMatchObject({
      hostname: "example.com",
      protocol: "https:",
    });
  });

  it("discovers a bounded same-origin table of contents and prefers a linked PDF", async () => {
    const html = `
      <html>
        <head><title>Open Grammar</title></head>
        <body>
          <nav aria-label="Table of contents">
            <a href="/chapter-1">Chapter 1</a>
            <a href="/chapter-2#overview">Chapter 2</a>
            <a href="https://elsewhere.example/chapter-3">External chapter</a>
          </nav>
          <main><a href="/downloads/open-grammar.pdf">Download the textbook PDF</a></main>
        </body>
      </html>`;

    const discovery = await discoverBookWebsite({
      url: "https://books.example/open-grammar",
      resolveHostname: publicResolver,
      fetchResource: async (url) => ({
        url,
        contentType: "text/html; charset=utf-8",
        bytes: Buffer.from(html),
      }),
      maximumPages: 1,
    });

    expect(discovery.title).toBe("Open Grammar");
    expect(discovery.pages).toEqual([
      { title: "Chapter 1", url: "https://books.example/chapter-1", level: 1 },
    ]);
    expect(discovery.preferredPdf).toEqual({
      title: "Download the textbook PDF",
      url: "https://books.example/downloads/open-grammar.pdf",
    });
  });

  it("turns an OpenStax details shell into an official PDF handoff", async () => {
    const discovery = await discoverBookWebsite({
      url: "https://openstax.org/details/books/biology-2e",
      resolveHostname: publicResolver,
      fetchResource: async (url) => {
        if (url.includes("/apps/cms/api/books/")) {
          return {
            url,
            contentType: "application/json",
            bytes: Buffer.from(
              JSON.stringify({
                books: [
                  {
                    slug: "books/biology-2e",
                    title: "Biology 2e",
                    high_resolution_pdf_url:
                      "https://assets.openstax.org/oscms-prodcms/media/documents/Biology-2e_-_WEB.pdf",
                  },
                ],
              }),
            ),
          };
        }

        return {
          url,
          contentType: "text/html; charset=utf-8",
          bytes: Buffer.from("<html><head><title>OpenStax</title></head><body><div id=\"app\"></div></body></html>"),
        };
      },
    });

    expect(discovery).toMatchObject({
      title: "Biology 2e",
      sourceUrl: "https://openstax.org/details/books/biology-2e",
      pages: [],
      preferredPdf: {
        title: "Download Biology 2e PDF",
        url: "https://assets.openstax.org/oscms-prodcms/media/documents/Biology-2e_-_WEB.pdf",
      },
    });
    expect(discovery.notice).toMatch(/official PDF/i);
  });

  it("rejects an unreadable JavaScript-only website without a supported handoff", async () => {
    await expect(
      discoverBookWebsite({
        url: "https://books.example/dynamic-reader",
        resolveHostname: publicResolver,
        fetchResource: async (url) => ({
          url,
          contentType: "text/html; charset=utf-8",
          bytes: Buffer.from("<html><head><title>Reader</title></head><body><div id=\"app\"></div></body></html>"),
        }),
      }),
    ).rejects.toThrow(/JavaScript-only/i);
  });
});

describe("quick PDF routing", () => {
  it("requires Materials beyond either quick-flow threshold", () => {
    expect(
      getQuickPdfDisposition({ byteSize: 10 * 1024 * 1024 + 1, pageCount: 4, focusNote: "Chapter 1" }),
    ).toMatchObject({ route: "materials-required", reason: "file-size" });
    expect(
      getQuickPdfDisposition({ byteSize: 2 * 1024 * 1024, pageCount: 21, focusNote: "Chapter 1" }),
    ).toMatchObject({ route: "materials-required", reason: "page-count" });
  });

  it("keeps a small focused excerpt in quick create", () => {
    expect(
      getQuickPdfDisposition({
        byteSize: 2 * 1024 * 1024,
        pageCount: 8,
        focusNote: "Only practice the noun-adjective agreement rule.",
      }),
    ).toEqual({ route: "quick-allowed", reason: null });
  });
});
