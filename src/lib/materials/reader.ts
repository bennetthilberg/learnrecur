import "server-only";

import { createHash } from "node:crypto";
import { MaterialPageTextStatus, MaterialRevisionStatus, Prisma, StudyMaterialKind, StudyMaterialStatus } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import { z } from "zod";

export const DEFAULT_MATERIAL_READ_MAX_CHARS = 12_000;
export const MAX_MATERIAL_READ_MAX_CHARS = 24_000;
export const MAX_MATERIAL_READ_PAGE_RANGE = 10;

const readerIdSchema = z.string().trim().min(1).max(200);

export const materialReadContentSchema = z
  .strictObject({
    material_id: readerIdSchema,
    expected_revision_id: readerIdSchema,
    section_id: readerIdSchema.optional(),
    page_range: z
      .strictObject({
        start: z.number().int().min(1).max(100_000),
        end: z.number().int().min(1).max(100_000),
      })
      .superRefine((range, context) => {
        if (range.end < range.start) {
          context.addIssue({ code: "custom", path: ["end"], message: "A page range cannot end before it starts." });
        }
        if (range.end - range.start + 1 > MAX_MATERIAL_READ_PAGE_RANGE) {
          context.addIssue({ code: "custom", path: ["end"], message: "A page range can contain at most ten pages." });
        }
      })
      .optional(),
    cursor: z.string().trim().min(1).max(2_000).optional(),
    max_chars: z.number().int().min(1).max(MAX_MATERIAL_READ_MAX_CHARS).default(DEFAULT_MATERIAL_READ_MAX_CHARS),
  })
  .superRefine((value, context) => {
    if (Boolean(value.section_id) === Boolean(value.page_range)) {
      context.addIssue({ code: "custom", path: ["section_id"], message: "Choose exactly one of section_id or page_range." });
    }
  });

export type MaterialReadContentInput = z.infer<typeof materialReadContentSchema>;

export type MaterialReaderSection = {
  id: string;
  parentId: string | null;
  ordinal: number;
  level: number;
  title: string;
  headingPath: string[];
  pageStart: number | null;
  pageEnd: number | null;
  url: string | null;
  anchor: string | null;
};

export type MaterialReaderChunk = {
  id: string;
  materialSectionId: string | null;
  ordinal: number;
  text: string;
  contentHash: string;
  locator: Prisma.JsonValue;
  headingText: string | null;
};

export type MaterialReaderPage = {
  id: string;
  pageNumber: number;
  embeddedText: string | null;
  ocrText: string | null;
  textStatus: MaterialPageTextStatus | string;
  contentHash: string;
};

export type MaterialReadSelector =
  | { kind: "section"; sectionId: string }
  | { kind: "page_range"; start: number; end: number };

export type MaterialReadUnit = {
  id: string;
  kind: "chunk" | "page" | "gap";
  sectionId: string | null;
  sectionPath: string[];
  pageNumber: number | null;
  rawText: string;
  text: string;
  sourceOffsetStart: number;
  locator: Record<string, unknown>;
  extractionStatus: MaterialReadExtractionStatus;
  gapReason: string | null;
  hasExtractionGap: boolean;
  overlap: { withChunkId: string; characters: number } | null;
  sortKey: [number, number, string];
  contentHash: string;
};

export type MaterialReadExtractionStatus =
  | "extracted"
  | "extracted_with_ocr_gap"
  | "ocr_ready"
  | "needs_ocr"
  | "ocr_processing"
  | "ocr_failed"
  | "missing";

export type MaterialReadPageResult = {
  segments: Array<{
    kind: "text" | "gap";
    chunk_id: string | null;
    page_id: string | null;
    page_number: number | null;
    section_id: string | null;
    section_path: string[];
    text: string;
    text_offset: { start: number; end: number } | null;
    locator: Record<string, unknown>;
    extraction_status: MaterialReadExtractionStatus;
    gap_reason: string | null;
    overlap: { with_chunk_id: string; characters: number } | null;
  }>;
  nextCursor: string | null;
  fullyTraversed: boolean;
  extractionGaps: Array<{
    page_number: number | null;
    status: MaterialReadExtractionStatus;
    reason: string;
    locator: Record<string, unknown>;
  }>;
  extractionGapCount: number;
};

type MaterialReadCursorPayload = {
  version: 1;
  userHash: string;
  revisionId: string;
  selector: MaterialReadSelector;
  scopeHash: string;
  unitIndex: number;
  offset: number;
};

export class MaterialReaderError extends Error {
  constructor(
    readonly code: "material_not_found" | "stale_material_revision" | "material_not_ready" | "invalid_cursor" | "invalid_scope",
    message: string,
  ) {
    super(message);
    this.name = "MaterialReaderError";
  }
}

function codePointLength(value: string) {
  return Array.from(value).length;
}

function sliceCodePoints(value: string, start: number, end?: number) {
  return Array.from(value).slice(start, end).join("");
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(",")}}`;
}

function userHash(userId: string) {
  return hash(`material-reader-user\u0000${userId}`);
}

export function encodeMaterialReadCursor(payload: Omit<MaterialReadCursorPayload, "version">) {
  return Buffer.from(JSON.stringify({ version: 1, ...payload }), "utf8").toString("base64url");
}

export function decodeMaterialReadCursor(value: string): MaterialReadCursorPayload {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) throw new Error("invalid cursor");
    const record = decoded as Record<string, unknown>;
    const selector = record.selector;
    const selectorRecord = selector && typeof selector === "object" && !Array.isArray(selector)
      ? selector as Record<string, unknown>
      : null;
    const validSelector = selectorRecord?.kind === "section" && typeof selectorRecord.sectionId === "string"
      ? { kind: "section" as const, sectionId: selectorRecord.sectionId }
      : selectorRecord?.kind === "page_range" &&
          typeof selectorRecord.start === "number" && Number.isInteger(selectorRecord.start) &&
          typeof selectorRecord.end === "number" && Number.isInteger(selectorRecord.end)
        ? { kind: "page_range" as const, start: selectorRecord.start, end: selectorRecord.end }
        : null;
    if (
      record.version !== 1 ||
      typeof record.userHash !== "string" || !/^[a-f0-9]{64}$/.test(record.userHash) ||
      typeof record.revisionId !== "string" || !record.revisionId ||
      !validSelector ||
      typeof record.scopeHash !== "string" || !/^[a-f0-9]{64}$/.test(record.scopeHash) ||
      typeof record.unitIndex !== "number" || !Number.isInteger(record.unitIndex) || record.unitIndex < 0 ||
      typeof record.offset !== "number" || !Number.isInteger(record.offset) || record.offset < 0
    ) {
      throw new Error("invalid cursor");
    }
    return {
      version: 1,
      userHash: record.userHash,
      revisionId: record.revisionId,
      selector: validSelector,
      scopeHash: record.scopeHash,
      unitIndex: record.unitIndex,
      offset: record.offset,
    };
  } catch {
    throw new MaterialReaderError("invalid_cursor", "The material read cursor is invalid or has expired.");
  }
}

function sectionPath(sectionId: string | null, sectionsById: ReadonlyMap<string, MaterialReaderSection>) {
  if (!sectionId) return [];
  const section = sectionsById.get(sectionId);
  if (!section) return [];
  if (section.headingPath.length > 0) return [...section.headingPath];
  const path: string[] = [];
  const visited = new Set<string>();
  let current: MaterialReaderSection | undefined = section;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current.title);
    current = current.parentId ? sectionsById.get(current.parentId) : undefined;
  }
  return path;
}

function collectSectionSubtreeIds(
  rootId: string,
  sections: readonly Pick<MaterialReaderSection, "id" | "parentId">[],
) {
  const selected = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const section of sections) {
      if (section.parentId && selected.has(section.parentId) && !selected.has(section.id)) {
        selected.add(section.id);
        changed = true;
      }
    }
  }
  return selected;
}

function sectionPageBounds(
  sections: readonly MaterialReaderSection[],
  selectedSectionIds: ReadonlySet<string>,
) {
  const boundedSections = sections.filter(
    (section) =>
      selectedSectionIds.has(section.id) &&
      section.pageStart !== null &&
      section.pageEnd !== null,
  );
  if (boundedSections.length === 0) return null;
  return {
    start: Math.min(...boundedSections.map((section) => section.pageStart!)),
    end: Math.max(...boundedSections.map((section) => section.pageEnd!)),
  };
}

function readRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readPageRange(value: unknown) {
  const record = readRecord(value);
  const range = readRecord(record.pageRange ?? record.page_range);
  return typeof range.start === "number" && Number.isInteger(range.start) && range.start >= 1 &&
    typeof range.end === "number" && Number.isInteger(range.end) && range.end >= range.start
    ? { start: range.start, end: range.end }
    : null;
}

function isContainedByPageRange(locator: unknown, selector: Extract<MaterialReadSelector, { kind: "page_range" }>) {
  const range = readPageRange(locator);
  return Boolean(range && range.start >= selector.start && range.end <= selector.end);
}

function pageRangeForUnit(locator: unknown) {
  return readPageRange(locator);
}

function pageSectionForNumber(pageNumber: number, sections: readonly MaterialReaderSection[]) {
  return sections
    .filter((section) => section.pageStart !== null && section.pageEnd !== null && section.pageStart <= pageNumber && section.pageEnd >= pageNumber)
    .toSorted((left, right) => right.level - left.level || (left.pageEnd! - left.pageStart!) - (right.pageEnd! - right.pageStart!) || left.ordinal - right.ordinal)[0] ?? null;
}

function largestSuffixPrefixOverlap(previous: string, current: string) {
  const previousPoints = Array.from(previous);
  const currentPoints = Array.from(current);
  const maximum = Math.min(previousPoints.length, currentPoints.length, 8_000);
  if (maximum < 8) return 0;

  const sequence: Array<string | null> = [
    ...currentPoints.slice(0, maximum),
    null,
    ...previousPoints.slice(-maximum),
  ];
  const prefixLengths = new Array<number>(sequence.length).fill(0);
  for (let index = 1; index < sequence.length; index += 1) {
    let candidate = prefixLengths[index - 1];
    while (candidate > 0 && sequence[index] !== sequence[candidate]) {
      candidate = prefixLengths[candidate - 1];
    }
    if (sequence[index] === sequence[candidate]) candidate += 1;
    prefixLengths[index] = candidate;
  }
  const overlap = prefixLengths.at(-1) ?? 0;
  return overlap >= 8 ? overlap : 0;
}

function unitLocator(input: {
  kind: StudyMaterialKind;
  revisionId: string;
  sectionId: string | null;
  chunkId?: string;
  pageNumber?: number;
  rawLocator?: unknown;
  section?: MaterialReaderSection | null;
}) {
  const raw = readRecord(input.rawLocator);
  if (input.kind === StudyMaterialKind.PDF) {
    const range = input.pageNumber !== undefined
      ? { start: input.pageNumber, end: input.pageNumber }
      : readPageRange(raw);
    return {
      kind: "pdf",
      revision_id: input.revisionId,
      ...(input.sectionId ? { section_id: input.sectionId } : {}),
      ...(input.chunkId ? { chunk_id: input.chunkId } : {}),
      ...(input.pageNumber !== undefined ? { page: input.pageNumber } : {}),
      ...(range ? { page_range: range } : {}),
    };
  }
  const rawUrl = typeof raw.url === "string" ? raw.url : input.section?.url;
  const rawAnchor = typeof raw.anchor === "string" ? raw.anchor : input.section?.anchor;
  return {
    kind: "web",
    revision_id: input.revisionId,
    ...(input.sectionId ? { section_id: input.sectionId } : {}),
    ...(input.chunkId ? { chunk_id: input.chunkId } : {}),
    ...(rawUrl ? { url: rawUrl } : {}),
    ...(rawAnchor ? { anchor: rawAnchor } : {}),
  };
}

export function buildMaterialReadUnits(input: {
  kind: StudyMaterialKind;
  revisionId?: string;
  selector: MaterialReadSelector;
  sections: readonly MaterialReaderSection[];
  chunks: readonly MaterialReaderChunk[];
  pages?: readonly MaterialReaderPage[];
}): MaterialReadUnit[] {
  const revisionId = input.revisionId ?? "revision";
  const sectionsById = new Map(input.sections.map((section) => [section.id, section]));
  const selectedSectionIds = new Set<string>();
  if (input.selector.kind === "section") {
    if (!sectionsById.has(input.selector.sectionId)) {
      throw new MaterialReaderError("invalid_scope", "The requested material section was not found.");
    }
    selectedSectionIds.add(input.selector.sectionId);
    let changed = true;
    while (changed) {
      changed = false;
      for (const section of input.sections) {
        if (section.parentId && selectedSectionIds.has(section.parentId) && !selectedSectionIds.has(section.id)) {
          selectedSectionIds.add(section.id);
          changed = true;
        }
      }
    }
  }
  const sectionSelected = (sectionId: string | null) => input.selector.kind === "section"
    ? sectionId !== null && selectedSectionIds.has(sectionId)
    : true;
  const selectedChunks = input.chunks
    .filter((chunk) => sectionSelected(chunk.materialSectionId))
    .filter((chunk) => input.selector.kind === "page_range" ? isContainedByPageRange(chunk.locator, input.selector) : true)
    .toSorted((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
  const units: MaterialReadUnit[] = [];
  const lastChunkTextBySection = new Map<string, { id: string; rawText: string }>();

  for (const chunk of selectedChunks) {
    const section = chunk.materialSectionId ? sectionsById.get(chunk.materialSectionId) ?? null : null;
    const previous = chunk.materialSectionId ? lastChunkTextBySection.get(chunk.materialSectionId) : undefined;
    const overlapCharacters = previous ? largestSuffixPrefixOverlap(previous.rawText, chunk.text) : 0;
    const text = overlapCharacters > 0 ? sliceCodePoints(chunk.text, overlapCharacters) : chunk.text;
    const range = pageRangeForUnit(chunk.locator);
    const sortPrimary = input.selector.kind === "page_range" ? range?.start ?? Number.MAX_SAFE_INTEGER : chunk.ordinal;
    units.push({
      id: `chunk:${chunk.id}`,
      kind: "chunk",
      sectionId: chunk.materialSectionId,
      sectionPath: sectionPath(chunk.materialSectionId, sectionsById),
      pageNumber: range?.start ?? null,
      rawText: chunk.text,
      text,
      sourceOffsetStart: overlapCharacters,
      locator: unitLocator({ kind: input.kind, revisionId, sectionId: chunk.materialSectionId, chunkId: chunk.id, rawLocator: chunk.locator, section }),
      extractionStatus: "extracted",
      gapReason: null,
      hasExtractionGap: false,
      overlap: overlapCharacters > 0 && previous ? { withChunkId: previous.id, characters: overlapCharacters } : null,
      sortKey: [sortPrimary, chunk.ordinal, chunk.id],
      contentHash: chunk.contentHash,
    });
    if (chunk.materialSectionId) lastChunkTextBySection.set(chunk.materialSectionId, { id: chunk.id, rawText: chunk.text });
  }

  if (input.kind !== StudyMaterialKind.PDF) {
    return units.toSorted(compareUnits);
  }

  const pages = input.pages ?? [];
  const selectedPageNumbers = selectedPageSet(input.selector, input.sections, selectedSectionIds);
  const chunkRanges = selectedChunks.flatMap((chunk) => {
    const range = readPageRange(chunk.locator);
    return range ? [range] : [];
  });
  const pageIsCoveredByChunk = (pageNumber: number) => chunkRanges.some((range) => range.start <= pageNumber && range.end >= pageNumber);
  const pageByNumber = new Map(pages.map((page) => [page.pageNumber, page]));

  for (const pageNumber of selectedPageNumbers) {
    const page = pageByNumber.get(pageNumber);
    const section = pageSectionForNumber(pageNumber, input.sections.filter((candidate) => input.selector.kind === "page_range" || selectedSectionIds.has(candidate.id)));
    const sectionId = section?.id ?? (input.selector.kind === "section" ? input.selector.sectionId : null);
    const covered = pageIsCoveredByChunk(pageNumber);
    if (page && isPageGap(page) && covered) {
      units.push({
        id: `gap:${page.id}`,
        kind: "gap",
        sectionId,
        sectionPath: sectionPath(sectionId, sectionsById),
        pageNumber,
        rawText: "",
        text: "",
        sourceOffsetStart: 0,
        locator: unitLocator({ kind: input.kind, revisionId, sectionId, pageNumber, section }),
        extractionStatus: page.textStatus === MaterialPageTextStatus.OCR_PROCESSING ? "ocr_processing" : page.textStatus === MaterialPageTextStatus.OCR_FAILED ? "ocr_failed" : "needs_ocr",
        gapReason: pageGapReason(page),
        hasExtractionGap: true,
        overlap: null,
        sortKey: [pageNumber, -1, `gap:${page.id}`],
        contentHash: page.contentHash,
      });
    }
    if (covered) continue;
    if (!page) {
      units.push({
        id: `gap:missing:${pageNumber}`,
        kind: "gap",
        sectionId,
        sectionPath: sectionPath(sectionId, sectionsById),
        pageNumber,
        rawText: "",
        text: "",
        sourceOffsetStart: 0,
        locator: unitLocator({ kind: input.kind, revisionId, sectionId, pageNumber, section }),
        extractionStatus: "missing",
        gapReason: "No extracted page text or indexed chunk is available for this page.",
        hasExtractionGap: true,
        overlap: null,
        sortKey: [pageNumber, -1, `gap:missing:${pageNumber}`],
        contentHash: hash(`missing-page-${pageNumber}`),
      });
      continue;
    }
    const pageText = page.textStatus === MaterialPageTextStatus.OCR_READY && page.ocrText !== null
      ? page.ocrText
      : page.embeddedText;
    if (pageText !== null && pageText.length > 0) {
      const status: MaterialReadExtractionStatus = page.textStatus === MaterialPageTextStatus.OCR_READY && page.ocrText !== null
        ? "ocr_ready"
        : isPageGap(page)
          ? "extracted_with_ocr_gap"
          : "extracted";
      units.push({
        id: `page:${page.id}`,
        kind: "page",
        sectionId,
        sectionPath: sectionPath(sectionId, sectionsById),
        pageNumber,
        rawText: pageText,
        text: pageText,
        sourceOffsetStart: 0,
        locator: unitLocator({ kind: input.kind, revisionId, sectionId, pageNumber, section }),
        extractionStatus: status,
        gapReason: isPageGap(page) ? pageGapReason(page) : null,
        hasExtractionGap: isPageGap(page),
        overlap: null,
        sortKey: [pageNumber, 0, `page:${page.id}`],
        contentHash: page.contentHash,
      });
    } else {
      units.push({
        id: `gap:${page.id}`,
        kind: "gap",
        sectionId,
        sectionPath: sectionPath(sectionId, sectionsById),
        pageNumber,
        rawText: "",
        text: "",
        sourceOffsetStart: 0,
        locator: unitLocator({ kind: input.kind, revisionId, sectionId, pageNumber, section }),
        extractionStatus: page.textStatus === MaterialPageTextStatus.OCR_PROCESSING ? "ocr_processing" : page.textStatus === MaterialPageTextStatus.OCR_FAILED ? "ocr_failed" : "needs_ocr",
        gapReason: pageGapReason(page),
        hasExtractionGap: true,
        overlap: null,
        sortKey: [pageNumber, -1, `gap:${page.id}`],
        contentHash: page.contentHash,
      });
    }
  }
  return units.toSorted(compareUnits);
}

function compareUnits(left: MaterialReadUnit, right: MaterialReadUnit) {
  return left.sortKey[0] - right.sortKey[0] || left.sortKey[1] - right.sortKey[1] || left.sortKey[2].localeCompare(right.sortKey[2]);
}

function selectedPageSet(
  selector: MaterialReadSelector,
  sections: readonly MaterialReaderSection[],
  selectedSectionIds: ReadonlySet<string>,
) {
  if (selector.kind === "page_range") return Array.from({ length: selector.end - selector.start + 1 }, (_, index) => selector.start + index);
  const ranges = sections
    .filter((section) => selectedSectionIds.has(section.id) && section.pageStart !== null && section.pageEnd !== null)
    .map((section) => ({ start: section.pageStart!, end: section.pageEnd! }));
  const pages = new Set<number>();
  for (const range of ranges) for (let page = range.start; page <= range.end; page += 1) pages.add(page);
  return [...pages].toSorted((left, right) => left - right);
}

function isPageGap(page: MaterialReaderPage) {
  return page.textStatus === MaterialPageTextStatus.NEEDS_OCR || page.textStatus === MaterialPageTextStatus.OCR_PROCESSING || page.textStatus === MaterialPageTextStatus.OCR_FAILED;
}

function pageGapReason(page: MaterialReaderPage) {
  if (page.textStatus === MaterialPageTextStatus.OCR_FAILED) return "Text extraction failed and OCR is unavailable.";
  if (page.textStatus === MaterialPageTextStatus.OCR_PROCESSING) return "OCR is currently processing this page; reading does not start OCR.";
  return "This page requires OCR; reading does not start OCR.";
}

function unitScopeHash(units: readonly MaterialReadUnit[]) {
  return hash(stableJson(units.map((unit) => ({
    id: unit.id,
    contentHash: unit.contentHash,
    rawTextLength: codePointLength(unit.rawText),
    extractionStatus: unit.extractionStatus,
    pageNumber: unit.pageNumber,
    sectionId: unit.sectionId,
  }))));
}

function cursorFor(input: {
  userId: string;
  revisionId: string;
  selector: MaterialReadSelector;
  scopeHash: string;
  unitIndex: number;
  offset: number;
}) {
  return encodeMaterialReadCursor({
    userHash: userHash(input.userId),
    revisionId: input.revisionId,
    selector: input.selector,
    scopeHash: input.scopeHash,
    unitIndex: input.unitIndex,
    offset: input.offset,
  });
}

function validateCursor(input: {
  cursor?: string;
  userId: string;
  revisionId: string;
  selector: MaterialReadSelector;
  scopeHash: string;
  units: readonly MaterialReadUnit[];
}) {
  if (!input.cursor) return { unitIndex: 0, offset: 0 };
  const cursor = decodeMaterialReadCursor(input.cursor);
  if (
    cursor.userHash !== userHash(input.userId) ||
    cursor.revisionId !== input.revisionId ||
    stableJson(cursor.selector) !== stableJson(input.selector) ||
    cursor.scopeHash !== input.scopeHash ||
    cursor.unitIndex > input.units.length
  ) {
    throw new MaterialReaderError("invalid_cursor", "The material read cursor does not match this revision or selector.");
  }
  if (cursor.unitIndex < input.units.length && cursor.offset > codePointLength(input.units[cursor.unitIndex].text)) {
    throw new MaterialReaderError("invalid_cursor", "The material read cursor is past the available text.");
  }
  if (cursor.unitIndex === input.units.length && cursor.offset !== 0) {
    throw new MaterialReaderError("invalid_cursor", "The material read cursor is past the end of the material.");
  }
  return { unitIndex: cursor.unitIndex, offset: cursor.offset };
}

export function paginateMaterialReadUnits(input: {
  units: readonly MaterialReadUnit[];
  userId: string;
  revisionId: string;
  selector: MaterialReadSelector;
  maxChars: number;
  cursor?: string;
}): MaterialReadPageResult {
  const maxChars = Math.min(Math.max(1, Math.trunc(input.maxChars)), MAX_MATERIAL_READ_MAX_CHARS);
  const scopeHash = unitScopeHash(input.units);
  const start = validateCursor({ ...input, scopeHash });
  const segments: MaterialReadPageResult["segments"] = [];
  let usedChars = 0;
  let unitIndex = start.unitIndex;
  let offset = start.offset;
  while (unitIndex < input.units.length) {
    const unit = input.units[unitIndex];
    if (unit.kind === "gap") {
      segments.push(toPublicSegment(unit, 0, 0));
      unitIndex += 1;
      offset = 0;
      continue;
    }
    const length = codePointLength(unit.text);
    if (offset >= length) {
      unitIndex += 1;
      offset = 0;
      continue;
    }
    const remainingBudget = maxChars - usedChars;
    if (remainingBudget <= 0) break;
    const amount = Math.min(remainingBudget, length - offset);
    segments.push(toPublicSegment(unit, offset, offset + amount));
    usedChars += amount;
    offset += amount;
    if (offset >= length) {
      unitIndex += 1;
      offset = 0;
    }
    if (usedChars >= maxChars) break;
  }
  const nextCursor = unitIndex < input.units.length
    ? cursorFor({ userId: input.userId, revisionId: input.revisionId, selector: input.selector, scopeHash, unitIndex, offset })
    : null;
  const allGaps = input.units.filter((unit) => unit.hasExtractionGap);
  return {
    segments,
    nextCursor,
    fullyTraversed: nextCursor === null && allGaps.length === 0,
    extractionGaps: allGaps.slice(0, 100).map((unit) => ({
      page_number: unit.pageNumber,
      status: unit.extractionStatus,
      reason: unit.gapReason ?? "Text extraction is incomplete for this segment.",
      locator: unit.locator,
    })),
    extractionGapCount: allGaps.length,
  };
}

function toPublicSegment(unit: MaterialReadUnit, start: number, end: number) {
  const isText = unit.kind !== "gap";
  return {
    kind: isText ? "text" as const : "gap" as const,
    chunk_id: unit.kind === "chunk" ? unit.id.slice("chunk:".length) : null,
    page_id: unit.kind === "page" || unit.id.startsWith("gap:") && !unit.id.startsWith("gap:missing:") ? unit.id.replace(/^(?:page|gap):/, "") : null,
    page_number: unit.pageNumber,
    section_id: unit.sectionId,
    section_path: unit.sectionPath,
    text: isText ? sliceCodePoints(unit.text, start, end) : "",
    text_offset: isText ? { start: unit.sourceOffsetStart + start, end: unit.sourceOffsetStart + end } : null,
    locator: unit.locator,
    extraction_status: unit.extractionStatus,
    gap_reason: unit.gapReason,
    overlap: unit.overlap
      ? { with_chunk_id: unit.overlap.withChunkId, characters: unit.overlap.characters }
      : null,
  };
}

export async function readMaterialContent(input: {
  userId: string;
  materialId: string;
  expectedRevisionId: string;
  sectionId?: string;
  pageRange?: { start: number; end: number };
  cursor?: string;
  maxChars?: number;
}) {
  const parsed = materialReadContentSchema.parse({
    material_id: input.materialId,
    expected_revision_id: input.expectedRevisionId,
    ...(input.sectionId ? { section_id: input.sectionId } : {}),
    ...(input.pageRange ? { page_range: input.pageRange } : {}),
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.maxChars !== undefined ? { max_chars: input.maxChars } : {}),
  });
  const prisma = getPrisma();
  const material = await prisma.studyMaterial.findFirst({
    where: { id: parsed.material_id, userId: input.userId, status: StudyMaterialStatus.ACTIVE },
    select: { id: true, title: true, kind: true, activeRevisionId: true },
  });
  if (!material) throw new MaterialReaderError("material_not_found", "The material was not found.");
  if (material.activeRevisionId !== parsed.expected_revision_id) {
    throw new MaterialReaderError("stale_material_revision", "The active material revision changed. Refresh the material and retry.");
  }
  const revision = await prisma.materialRevision.findFirst({
    where: { id: parsed.expected_revision_id, userId: input.userId, materialId: material.id, status: MaterialRevisionStatus.READY },
    select: { id: true, revisionNumber: true, pageCount: true, fetchedPageCount: true },
  });
  if (!revision) throw new MaterialReaderError("material_not_ready", "The requested material revision is not ready.");
  if (parsed.page_range) {
    if (material.kind !== StudyMaterialKind.PDF) throw new MaterialReaderError("invalid_scope", "PDF page ranges do not apply to web materials.");
    const availablePageCount = revision.pageCount ?? revision.fetchedPageCount;
    if (availablePageCount !== null && parsed.page_range.end > availablePageCount) {
      throw new MaterialReaderError("invalid_scope", "The requested page range exceeds the material revision.");
    }
  }
  const selector: MaterialReadSelector = parsed.section_id
    ? { kind: "section", sectionId: parsed.section_id }
    : { kind: "page_range", start: parsed.page_range!.start, end: parsed.page_range!.end };
  const sections = await prisma.materialSection.findMany({
    where: { userId: input.userId, materialRevisionId: revision.id },
    orderBy: { ordinal: "asc" },
    select: { id: true, parentId: true, ordinal: true, level: true, title: true, headingPath: true, pageStart: true, pageEnd: true, url: true, anchor: true },
  });
  if (selector.kind === "section" && !sections.some((section) => section.id === selector.sectionId)) {
    throw new MaterialReaderError("invalid_scope", "The requested material section was not found.");
  }
  const scopedSectionIds = selector.kind === "section"
    ? collectSectionSubtreeIds(selector.sectionId, sections)
    : null;
  const scopedPageRange = parsed.page_range ?? (
    scopedSectionIds ? sectionPageBounds(sections, scopedSectionIds) : null
  );
  const [chunks, pages] = await Promise.all([
    prisma.materialChunk.findMany({
      where: {
        userId: input.userId,
        materialRevisionId: revision.id,
        ...(scopedSectionIds ? { materialSectionId: { in: [...scopedSectionIds] } } : {}),
      },
      orderBy: { ordinal: "asc" },
      select: { id: true, materialSectionId: true, ordinal: true, text: true, contentHash: true, locator: true, headingText: true },
    }),
    material.kind === StudyMaterialKind.PDF
      ? prisma.materialPage.findMany({
          where: {
            userId: input.userId,
            materialRevisionId: revision.id,
            ...(scopedPageRange
              ? { pageNumber: { gte: scopedPageRange.start, lte: scopedPageRange.end } }
              : {}),
          },
          orderBy: { pageNumber: "asc" },
          select: { id: true, pageNumber: true, embeddedText: true, ocrText: true, textStatus: true, contentHash: true },
        })
      : [],
  ]);
  const units = buildMaterialReadUnits({
    kind: material.kind,
    revisionId: revision.id,
    selector,
    sections,
    chunks,
    pages,
  });
  const page = paginateMaterialReadUnits({
    units,
    userId: input.userId,
    revisionId: revision.id,
    selector,
    maxChars: parsed.max_chars,
    cursor: parsed.cursor,
  });
  return {
    material_id: material.id,
    title: material.title,
    revision_id: revision.id,
    revision_number: revision.revisionNumber,
    selector: parsed.section_id
      ? { section_id: parsed.section_id }
      : { page_range: parsed.page_range },
    segments: page.segments,
    next_cursor: page.nextCursor,
    fully_traversed: page.fullyTraversed,
    extraction_gaps: page.extractionGaps,
    extraction_gap_count: page.extractionGapCount,
  };
}
