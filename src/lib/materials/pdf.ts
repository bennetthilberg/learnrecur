import { createHash } from "node:crypto";

import type { TextItem } from "pdfjs-dist/types/src/display/api";

export type ExtractedPdfPage = {
  pageNumber: number;
  text: string;
  needsOcr: boolean;
  hasVisualContent?: boolean;
};

export type PdfIndexSection = {
  ordinal: number;
  level: number;
  title: string;
  normalizedTitle: string;
  pageStart: number;
  pageEnd: number;
  headingPath: string[];
};

export type PdfIndexChunk = {
  ordinal: number;
  sectionOrdinal: number;
  text: string;
  tokenEstimate: number;
  contentHash: string;
  headingText: string;
  pageStart: number;
  pageEnd: number;
};

export type PdfIndex = {
  sections: PdfIndexSection[];
  chunks: PdfIndexChunk[];
  pagesRequiringOcr: number[];
};

export type TextChunk = {
  text: string;
  tokenEstimate: number;
  contentHash: string;
};

export const DEFAULT_MATERIAL_CHUNK_TOKENS = 800;
export const DEFAULT_MATERIAL_CHUNK_OVERLAP_TOKENS = 120;
const MIN_USABLE_PDF_PAGE_CHARACTERS = 24;

export class PdfPageLimitError extends Error {
  readonly pageCount: number;
  readonly maximumPages: number;

  constructor(pageCount: number, maximumPages: number) {
    super(`PDF page limit is ${maximumPages}; received ${pageCount} pages.`);
    this.name = "PdfPageLimitError";
    this.pageCount = pageCount;
    this.maximumPages = maximumPages;
  }
}

export async function inspectPdfPageCount(bytes: Buffer): Promise<number> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;

  try {
    return document.numPages;
  } finally {
    await document.cleanup();
    await loadingTask.destroy();
  }
}

export async function extractPdfPages(
  bytes: Buffer,
  options: { maximumPages?: number } = {},
): Promise<{
  pageCount: number;
  pages: ExtractedPdfPage[];
}> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
  });
  const document = await loadingTask.promise;
  const pages: ExtractedPdfPage[] = [];

  try {
    if (options.maximumPages && document.numPages > options.maximumPages) {
      throw new PdfPageLimitError(document.numPages, options.maximumPages);
    }

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      const text = textContent.items
        .filter((item): item is TextItem => "str" in item)
        .map((item) => item.str)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const operatorList = await page.getOperatorList();
      const visualOperators = new Set(
        [
          pdfjs.OPS.paintImageXObject,
          pdfjs.OPS.paintInlineImageXObject,
          pdfjs.OPS.paintImageMaskXObject,
          pdfjs.OPS.paintSolidColorImageMask,
          pdfjs.OPS.constructPath,
        ].filter((operator): operator is number => typeof operator === "number"),
      );

      pages.push({
        pageNumber,
        text,
        needsOcr: usableCharacterCount(text) < MIN_USABLE_PDF_PAGE_CHARACTERS,
        hasVisualContent: operatorList.fnArray.some((operator) => visualOperators.has(operator)),
      });
      page.cleanup();
    }
  } finally {
    await document.cleanup();
    await loadingTask.destroy();
  }

  return {
    pageCount: pages.length,
    pages,
  };
}

export function buildPdfIndex(
  pages: readonly ExtractedPdfPage[],
  options: { targetTokens?: number; overlapTokens?: number } = {},
): PdfIndex {
  const targetTokens = Math.max(40, options.targetTokens ?? DEFAULT_MATERIAL_CHUNK_TOKENS);
  const overlapTokens = Math.max(
    0,
    Math.min(options.overlapTokens ?? DEFAULT_MATERIAL_CHUNK_OVERLAP_TOKENS, targetTokens - 1),
  );
  const targetWords = tokenTargetToWords(targetTokens);
  const overlapWords = tokenTargetToWords(overlapTokens);
  const sections = buildPdfSections(pages);
  const chunks: PdfIndexChunk[] = [];

  for (const section of sections) {
    const sectionPages = pages.filter(
      (page) =>
        !page.needsOcr &&
        page.pageNumber >= section.pageStart &&
        page.pageNumber <= section.pageEnd,
    );
    const words = sectionPages.flatMap((page) =>
      page.text.split(/\s+/).filter(Boolean).map((word) => ({ word, pageNumber: page.pageNumber })),
    );

    if (words.length === 0) {
      continue;
    }

    const step = Math.max(1, targetWords - overlapWords);
    for (let start = 0; start < words.length; start += step) {
      const window = words.slice(start, start + targetWords);
      if (window.length === 0) {
        break;
      }

      const text = window.map(({ word }) => word).join(" ");
      chunks.push({
        ordinal: chunks.length,
        sectionOrdinal: section.ordinal,
        text,
        tokenEstimate: estimateTokens(text),
        contentHash: sha256(text),
        headingText: section.title,
        pageStart: window[0].pageNumber,
        pageEnd: window.at(-1)?.pageNumber ?? window[0].pageNumber,
      });

      if (start + targetWords >= words.length) {
        break;
      }
    }
  }

  return {
    sections,
    chunks,
    pagesRequiringOcr: pages.filter((page) => page.needsOcr).map((page) => page.pageNumber),
  };
}

export function buildPdfSections(pages: readonly ExtractedPdfPage[]): PdfIndexSection[] {
  if (pages.length === 0) {
    return [];
  }

  const candidates = pages
    .map((page) => ({ pageNumber: page.pageNumber, title: findPageHeading(page.text) }))
    .filter((candidate): candidate is { pageNumber: number; title: string } => Boolean(candidate.title));
  const starts = candidates.length > 0
    ? candidates
    : [{ pageNumber: pages[0].pageNumber, title: "Document" }];

  if (starts[0].pageNumber !== pages[0].pageNumber) {
    starts.unshift({ pageNumber: pages[0].pageNumber, title: "Front matter" });
  }

  return starts.map((start, index) => {
    const nextStart = starts[index + 1]?.pageNumber;
    const pageEnd = nextStart ? nextStart - 1 : pages.at(-1)?.pageNumber ?? start.pageNumber;

    return {
      ordinal: index,
      level: 1,
      title: start.title,
      normalizedTitle: normalizeHeading(start.title),
      pageStart: start.pageNumber,
      pageEnd,
      headingPath: [start.title],
    };
  });
}

export function estimateTokens(text: string): number {
  const wordCount = text.trim() ? text.trim().split(/\s+/).length : 0;
  return Math.max(1, Math.ceil(wordCount * 1.3));
}

export function chunkSectionText(
  text: string,
  options: { targetTokens?: number; overlapTokens?: number } = {},
): TextChunk[] {
  const targetTokens = Math.max(40, options.targetTokens ?? DEFAULT_MATERIAL_CHUNK_TOKENS);
  const overlapTokens = Math.max(
    0,
    Math.min(options.overlapTokens ?? DEFAULT_MATERIAL_CHUNK_OVERLAP_TOKENS, targetTokens - 1),
  );
  const targetWords = tokenTargetToWords(targetTokens);
  const overlapWords = tokenTargetToWords(overlapTokens);
  const step = Math.max(1, targetWords - overlapWords);
  const words = text.trim().split(/\s+/).filter(Boolean);
  const chunks: TextChunk[] = [];

  for (let start = 0; start < words.length; start += step) {
    const chunkText = words.slice(start, start + targetWords).join(" ");
    if (!chunkText) {
      break;
    }
    chunks.push({
      text: chunkText,
      tokenEstimate: estimateTokens(chunkText),
      contentHash: sha256(chunkText),
    });
    if (start + targetWords >= words.length) {
      break;
    }
  }

  return chunks;
}

function tokenTargetToWords(tokens: number) {
  return Math.max(0, Math.floor(tokens / 1.3));
}

function usableCharacterCount(text: string) {
  return text.replace(/[^\p{L}\p{N}]/gu, "").length;
}

function findPageHeading(text: string): string | null {
  const firstLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (firstLine && /^(?:chapter|unit|part|lesson|module)\s+(?:\d+|[ivxlcdm]+)\b/i.test(firstLine)) {
    return firstLine.slice(0, 120);
  }

  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }

  const chapterMatch = normalized.match(
    /\b((?:chapter|unit|part|lesson|module)\s+(?:\d+|[ivxlcdm]+)(?::?\s+[^.!?]{2,90})?)/i,
  );
  if (chapterMatch) {
    return chapterMatch[1].trim();
  }

  return null;
}

function normalizeHeading(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
