import "server-only";

import { Prisma, SourceFileStatus, StudyMaterialKind, StudyMaterialStatus, MaterialRevisionStatus } from "@/generated/prisma/client";
import { agentAddFromSpecsSchema, agentSetupPreviewSchema } from "@/lib/agent-access/contracts";
import { getPrisma } from "@/lib/prisma";
import {
  MATERIAL_LOCATOR_VERSION,
  MAX_MATERIAL_PDF_PAGES,
  skillSourceLocatorSchema,
  type SkillSourceLocator,
} from "@/lib/materials/contracts";
import { z } from "zod";

export const MAX_MATERIAL_SOURCE_REFERENCES = 8;

const sourceReferenceIdSchema = z.string().trim().min(1).max(200);

export const materialSourceReferenceSchema = z
  .strictObject({
    material_id: sourceReferenceIdSchema,
    expected_revision_id: sourceReferenceIdSchema,
    section_ids: z
      .array(sourceReferenceIdSchema)
      .max(24)
      .refine((values) => new Set(values).size === values.length, "Section IDs must be unique.")
      .optional(),
    evidence_chunk_ids: z
      .array(sourceReferenceIdSchema)
      .max(80)
      .refine(
        (values) => new Set(values).size === values.length,
        "Evidence chunk IDs must be unique.",
      )
      .optional(),
  })
  .superRefine((value, context) => {
    if (!value.section_ids?.length && !value.evidence_chunk_ids?.length) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "A source reference needs a section or evidence chunk.",
      });
    }
  });

export const materialSourceReferencesSchema = z
  .array(materialSourceReferenceSchema)
  .max(MAX_MATERIAL_SOURCE_REFERENCES);

export type MaterialSourceReference = z.infer<typeof materialSourceReferenceSchema>;
export type MaterialSourceReferenceInput = {
  material_id: string;
  expected_revision_id: string;
  section_ids?: readonly string[];
  evidence_chunk_ids?: readonly string[];
};

type ParsedAgentSpecInput = z.infer<typeof agentAddFromSpecsSchema>;
type ParsedAgentSpecItem = ParsedAgentSpecInput["items"][number];

export type AgentSpecInputWithSourceRefs = Omit<ParsedAgentSpecInput, "items"> & {
  items: Array<ParsedAgentSpecItem & { source_refs?: MaterialSourceReference[] }>;
};

type ParsedSetupInput = z.infer<typeof agentSetupPreviewSchema>;
type ParsedSetupSkill = ParsedSetupInput["skills"][number];
type ParsedSetupSpecSkill = Extract<ParsedSetupSkill, { kind: "create_specs" }>;

export type SetupInputWithSourceRefs = Omit<ParsedSetupInput, "skills"> & {
  skills: Array<
    | (ParsedSetupSpecSkill & { source_refs?: MaterialSourceReference[] })
    | Exclude<ParsedSetupSkill, ParsedSetupSpecSkill>
  >;
};

export function parseMaterialSourceReferences(value: unknown): MaterialSourceReference[] {
  return materialSourceReferencesSchema.parse(value).map(normalizeSourceReference);
}

export function normalizeSourceReference(reference: MaterialSourceReference): MaterialSourceReference {
  return {
    material_id: reference.material_id,
    expected_revision_id: reference.expected_revision_id,
    ...(reference.section_ids
      ? { section_ids: [...reference.section_ids].toSorted() }
      : {}),
    ...(reference.evidence_chunk_ids
      ? { evidence_chunk_ids: [...reference.evidence_chunk_ids].toSorted() }
      : {}),
  };
}

export function normalizeSourceReferences(
  references: readonly MaterialSourceReference[] | undefined,
) {
  if (references === undefined) return undefined;
  return references
    .map(normalizeSourceReference)
    .toSorted((left, right) =>
      [left.material_id, left.expected_revision_id, left.section_ids?.join("\u0000") ?? "", left.evidence_chunk_ids?.join("\u0000") ?? ""].join("\u0001")
        .localeCompare(
          [right.material_id, right.expected_revision_id, right.section_ids?.join("\u0000") ?? "", right.evidence_chunk_ids?.join("\u0000") ?? ""].join("\u0001"),
        ),
    );
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function withoutSourceRefs(record: Record<string, unknown>) {
  const copy = { ...record };
  delete copy.source_refs;
  return copy;
}

export function parseAgentSpecInputWithSourceRefs(rawInput: unknown): AgentSpecInputWithSourceRefs {
  const record = recordValue(rawInput);
  const rawItems = Array.isArray(record?.items) ? record.items : null;
  const sanitized = record
    ? {
        ...record,
        ...(rawItems
          ? {
              items: rawItems.map((item) => {
                const itemRecord = recordValue(item);
                if (!itemRecord) return item;
                return withoutSourceRefs(itemRecord);
              }),
            }
          : {}),
      }
    : rawInput;
  const parsed = agentAddFromSpecsSchema.parse(sanitized);
  return {
    ...parsed,
    items: parsed.items.map((item, index) => {
      const rawItem = recordValue(rawItems?.[index]);
      if (!rawItem || rawItem.source_refs === undefined) return item;
      return { ...item, source_refs: parseMaterialSourceReferences(rawItem.source_refs) };
    }),
  };
}

export function parseSetupInputWithSourceRefs(rawInput: unknown): SetupInputWithSourceRefs {
  const record = recordValue(rawInput);
  const rawSkills = Array.isArray(record?.skills) ? record.skills : null;
  const sanitized = record
    ? {
        ...record,
        ...(rawSkills
          ? {
              skills: rawSkills.map((skill) => {
                const skillRecord = recordValue(skill);
                if (skillRecord?.kind !== "create_specs") return skill;
                return withoutSourceRefs(skillRecord);
              }),
            }
          : {}),
      }
    : rawInput;
  const parsed = agentSetupPreviewSchema.parse(sanitized);
  return {
    ...parsed,
    skills: parsed.skills.map((skill, index) => {
      if (skill.kind !== "create_specs") return skill;
      const rawSkill = recordValue(rawSkills?.[index]);
      if (!rawSkill || rawSkill.source_refs === undefined) return skill;
      return { ...skill, source_refs: parseMaterialSourceReferences(rawSkill.source_refs) };
    }),
  } as SetupInputWithSourceRefs;
}

export class MaterialSourceReferenceError extends Error {
  constructor(
    readonly code:
      | "material_not_found"
      | "stale_material_revision"
      | "source_section_not_found"
      | "source_chunk_not_found"
      | "invalid_source_reference"
      | "incompatible_source_reference",
    message: string,
  ) {
    super(message);
    this.name = "MaterialSourceReferenceError";
  }
}

type SourceReferenceClient = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

type SourceReferenceSection = {
  id: string;
  parentId: string | null;
  ordinal: number;
  title: string;
  pageStart: number | null;
  pageEnd: number | null;
  url: string | null;
  anchor: string | null;
};

type SourceReferenceChunk = {
  id: string;
  materialSectionId: string | null;
  sourceFileId: string | null;
  ordinal: number;
  locator: Prisma.JsonValue;
};

type SourceReferenceScope = {
  material: {
    id: string;
    kind: StudyMaterialKind;
    activeRevisionId: string | null;
  };
  revision: { id: string };
  allSections: SourceReferenceSection[];
  sourceFiles: Array<{ id: string }>;
  chunksById: Map<string, SourceReferenceChunk>;
  missingChunkIds: Set<string>;
  sectionChunksByKey: Map<string, SourceReferenceChunk[]>;
};

export type MaterialSourceReferenceCache = Map<string, SourceReferenceScope>;

export type ResolvedMaterialSourceReference = {
  materialId: string;
  materialRevisionId: string;
  sourceFileId: string;
  locator: SkillSourceLocator;
};

function descendantSectionIds(
  roots: readonly string[],
  sections: readonly Pick<SourceReferenceSection, "id" | "parentId">[],
) {
  const ids = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const section of sections) {
      if (section.parentId && ids.has(section.parentId) && !ids.has(section.id)) {
        ids.add(section.id);
        changed = true;
      }
    }
  }
  return ids;
}

function readRecord(value: unknown) {
  return recordValue(value) ?? {};
}

function readPositiveInteger(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function readPageRange(locator: unknown) {
  const record = readRecord(locator);
  const pageRange = readRecord(record.pageRange ?? record.page_range);
  const start = readPositiveInteger(pageRange.start);
  const end = readPositiveInteger(pageRange.end);
  return start !== null && end !== null && end >= start && end <= MAX_MATERIAL_PDF_PAGES
    ? { start, end }
    : null;
}

function mergePageRanges(ranges: ReadonlyArray<{ start: number; end: number }>) {
  const sorted = [...ranges].toSorted((left, right) => left.start - right.start || left.end - right.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

function readWebLocation(value: unknown) {
  const record = readRecord(value);
  const url = typeof record.url === "string" ? record.url : null;
  const heading = typeof record.heading === "string" ? record.heading : null;
  const anchor = typeof record.anchor === "string" ? record.anchor : null;
  return url ? { url, ...(heading ? { heading } : {}), ...(anchor ? { anchor } : {}) } : null;
}

function uniqueWebAnchors(
  sections: readonly SourceReferenceSection[],
  chunks: readonly SourceReferenceChunk[],
) {
  const anchors = [
    ...sections.flatMap((section) =>
      section.url
        ? [{ url: section.url, heading: section.title, ...(section.anchor ? { anchor: section.anchor } : {}) }]
        : [],
    ),
    ...chunks.flatMap((chunk) => {
      const location = readWebLocation(chunk.locator);
      return location ? [location] : [];
    }),
  ];
  return anchors.filter((anchor, index) => {
    const key = `${anchor.url}\u0000${anchor.heading ?? ""}\u0000${anchor.anchor ?? ""}`;
    return anchors.findIndex((candidate) => `${candidate.url}\u0000${candidate.heading ?? ""}\u0000${candidate.anchor ?? ""}` === key) === index;
  });
}

function buildCanonicalLocator(input: {
  materialId: string;
  materialRevisionId: string;
  materialKind: StudyMaterialKind;
  sections: readonly SourceReferenceSection[];
  chunks: readonly SourceReferenceChunk[];
  evidenceChunkIds: readonly string[];
  includeSectionPageRanges: boolean;
}) {
  const sectionIds = input.sections.map((section) => section.id);
  const sectionPageRanges = input.sections.flatMap((section) =>
    section.pageStart
      ? [{ start: section.pageStart, end: section.pageEnd ?? section.pageStart }]
      : [],
  );
  const chunkPageRanges = input.chunks.flatMap((chunk) => {
    const range = readPageRange(chunk.locator);
    return range ? [range] : [];
  });
  const pageRanges =
    input.includeSectionPageRanges || chunkPageRanges.length !== input.chunks.length
      ? [...sectionPageRanges, ...chunkPageRanges]
      : chunkPageRanges;
  const common = {
    version: MATERIAL_LOCATOR_VERSION,
    materialRevisionId: input.materialRevisionId,
    materialSectionIds: sectionIds,
    evidenceChunkIds: [...input.evidenceChunkIds],
  };
  const source =
    input.materialKind === StudyMaterialKind.PDF
      ? {
          kind: "pdf" as const,
          pageRanges: mergePageRanges(pageRanges),
        }
      : { kind: "web" as const, anchors: uniqueWebAnchors(input.sections, input.chunks) };

  const parsed = skillSourceLocatorSchema.safeParse({ ...common, source });
  if (!parsed.success) {
    throw new MaterialSourceReferenceError(
      "invalid_source_reference",
      `The material does not contain a stable ${input.materialKind.toLocaleLowerCase("en-US")} locator for this reference.`,
    );
  }
  return parsed.data;
}

export async function resolveMaterialSourceReferences(input: {
  userId: string;
  sourceRefs: readonly MaterialSourceReferenceInput[] | undefined;
  client?: SourceReferenceClient;
  cache?: MaterialSourceReferenceCache;
}): Promise<ResolvedMaterialSourceReference[]> {
  if (!input.sourceRefs?.length) return [];
  const sourceRefs = materialSourceReferencesSchema.parse(input.sourceRefs);
  const client = input.client ?? getPrisma();
  const cache = input.cache ?? new Map<string, SourceReferenceScope>();
  const resolved: ResolvedMaterialSourceReference[] = [];

  for (const sourceRef of sourceRefs) {
    const scopeKey = `${sourceRef.material_id}\u0000${sourceRef.expected_revision_id}`;
    let scope = cache.get(scopeKey);
    if (!scope) {
      const material = await client.studyMaterial.findFirst({
        where: {
          id: sourceRef.material_id,
          userId: input.userId,
          status: StudyMaterialStatus.ACTIVE,
        },
        select: { id: true, kind: true, activeRevisionId: true },
      });
      if (!material) {
        throw new MaterialSourceReferenceError("material_not_found", "The source material was not found.");
      }
      if (material.activeRevisionId !== sourceRef.expected_revision_id) {
        throw new MaterialSourceReferenceError(
          "stale_material_revision",
          "The source material revision changed before the reference could be saved.",
        );
      }
      const revision = await client.materialRevision.findFirst({
        where: {
          id: sourceRef.expected_revision_id,
          userId: input.userId,
          materialId: material.id,
          status: MaterialRevisionStatus.READY,
        },
        select: { id: true },
      });
      if (!revision) {
        throw new MaterialSourceReferenceError(
          "stale_material_revision",
          "The source material revision is no longer ready.",
        );
      }
      const [allSections, sourceFiles] = await Promise.all([
        client.materialSection.findMany({
          where: { userId: input.userId, materialRevisionId: revision.id },
          orderBy: { ordinal: "asc" },
          select: {
            id: true,
            parentId: true,
            ordinal: true,
            title: true,
            pageStart: true,
            pageEnd: true,
            url: true,
            anchor: true,
          },
        }),
        client.sourceFile.findMany({
          where: {
            userId: input.userId,
            materialRevisionId: revision.id,
            status: SourceFileStatus.READY,
          },
          orderBy: { id: "asc" },
          select: { id: true },
        }),
      ]);
      scope = {
        material,
        revision,
        allSections,
        sourceFiles,
        chunksById: new Map(),
        missingChunkIds: new Set(),
        sectionChunksByKey: new Map(),
      };
      cache.set(scopeKey, scope);
    }
    const { material, revision, allSections, sourceFiles } = scope;
    const sectionById = new Map(allSections.map((section) => [section.id, section]));
    const requestedSections = (sourceRef.section_ids ?? []).map((sectionId) => sectionById.get(sectionId));
    if (requestedSections.some((section) => !section)) {
      throw new MaterialSourceReferenceError(
        "source_section_not_found",
        "One or more source sections do not belong to the requested material revision.",
      );
    }
    const selectedSectionIds = descendantSectionIds(
      requestedSections.filter((section): section is SourceReferenceSection => Boolean(section)).map((section) => section.id),
      allSections,
    );
    const requestedChunkIds = sourceRef.evidence_chunk_ids ?? [];
    let chunks: SourceReferenceChunk[] = [];
    if (requestedChunkIds.length) {
      const missingChunkIds = requestedChunkIds.filter(
        (chunkId) => !scope.chunksById.has(chunkId) && !scope.missingChunkIds.has(chunkId),
      );
      if (missingChunkIds.length) {
        const loadedChunks = await client.materialChunk.findMany({
          where: {
            id: { in: missingChunkIds },
            userId: input.userId,
            materialRevisionId: revision.id,
          },
          orderBy: { ordinal: "asc" },
          select: {
            id: true,
            materialSectionId: true,
            sourceFileId: true,
            ordinal: true,
            locator: true,
          },
        });
        for (const chunk of loadedChunks) scope.chunksById.set(chunk.id, chunk);
        for (const chunkId of missingChunkIds) {
          if (!scope.chunksById.has(chunkId)) scope.missingChunkIds.add(chunkId);
        }
      }
      chunks = requestedChunkIds
        .flatMap((chunkId) => {
          const chunk = scope.chunksById.get(chunkId);
          return chunk ? [chunk] : [];
        })
        .toSorted((left, right) => left.ordinal - right.ordinal || left.id.localeCompare(right.id));
    }
    if (chunks.length !== requestedChunkIds.length) {
      throw new MaterialSourceReferenceError(
        "source_chunk_not_found",
        "One or more evidence chunks do not belong to the requested material revision.",
      );
    }
    if (requestedSections.length && chunks.some((chunk) => !chunk.materialSectionId || !selectedSectionIds.has(chunk.materialSectionId))) {
      throw new MaterialSourceReferenceError(
        "invalid_source_reference",
        "Every evidence chunk must belong to the selected source section or one of its subsections.",
      );
    }
    if (!chunks.length && selectedSectionIds.size) {
      const sectionCacheKey = [...selectedSectionIds].toSorted().join("\u0000");
      const cachedChunks = scope.sectionChunksByKey.get(sectionCacheKey);
      if (cachedChunks) {
        chunks = cachedChunks;
      } else {
        chunks = await client.materialChunk.findMany({
          where: {
            userId: input.userId,
            materialRevisionId: revision.id,
            materialSectionId: { in: [...selectedSectionIds] },
          },
          orderBy: { ordinal: "asc" },
          take: 81,
          select: {
            id: true,
            materialSectionId: true,
            sourceFileId: true,
            ordinal: true,
            locator: true,
          },
        });
        scope.sectionChunksByKey.set(sectionCacheKey, chunks);
      }
      if (chunks.length > 80) {
        throw new MaterialSourceReferenceError(
          "invalid_source_reference",
          "A source section contains more than the maximum evidence that one reference can cite.",
        );
      }
    }
    if (!chunks.length || chunks.some((chunk) => !chunk.materialSectionId)) {
      throw new MaterialSourceReferenceError(
        "invalid_source_reference",
        "A source reference must resolve to indexed evidence chunks.",
      );
    }
    const chunkSectionIds = chunks.map((chunk) => chunk.materialSectionId as string);
    const sectionIds = requestedSections.length
      ? requestedSections.filter((section): section is SourceReferenceSection => Boolean(section)).map((section) => section.id)
      : [...new Set(chunkSectionIds)];
    const sections = sectionIds
      .map((sectionId) => sectionById.get(sectionId))
      .filter((section): section is SourceReferenceSection => Boolean(section))
      .toSorted((left, right) => left.ordinal - right.ordinal);
    const sourceFileIds = [...new Set(chunks.flatMap((chunk) => (chunk.sourceFileId ? [chunk.sourceFileId] : [])))];
    if (sourceFileIds.length > 1) {
      throw new MaterialSourceReferenceError(
        "invalid_source_reference",
        "Evidence chunks from different source files must be cited separately.",
      );
    }
    const sourceFile = sourceFileIds.length > 0
      ? sourceFiles.find((candidate) => candidate.id === sourceFileIds[0])
      : sourceFiles[0];
    if (!sourceFile) {
      throw new MaterialSourceReferenceError(
        "material_not_found",
        "The material source file is no longer available.",
      );
    }
    const evidenceChunkIds = chunks.map((chunk) => chunk.id);
    const locator = buildCanonicalLocator({
      materialId: material.id,
      materialRevisionId: revision.id,
      materialKind: material.kind,
      sections,
      chunks,
      evidenceChunkIds,
      includeSectionPageRanges: requestedSections.length > 0,
    });
    resolved.push({
      materialId: material.id,
      materialRevisionId: revision.id,
      sourceFileId: sourceFile.id,
      locator,
    });
  }
  return resolved;
}

export function mergeMaterialSourceLocators(
  locators: readonly SkillSourceLocator[],
): SkillSourceLocator {
  const first = locators[0];
  if (!first) throw new MaterialSourceReferenceError("invalid_source_reference", "No source locator was supplied.");
  for (const locator of locators) {
    if (locator.materialRevisionId !== first.materialRevisionId || locator.source.kind !== first.source.kind) {
      throw new MaterialSourceReferenceError(
        "incompatible_source_reference",
        "Source references can only be merged when they cite the same material revision.",
      );
    }
  }
  const materialSectionIds = [...new Set(locators.flatMap((locator) => locator.materialSectionIds))].toSorted();
  const evidenceChunkIds = [...new Set(locators.flatMap((locator) => locator.evidenceChunkIds))].toSorted();
  const source =
    first.source.kind === "pdf"
      ? {
          kind: "pdf" as const,
          pageRanges: mergePageRanges(locators.flatMap((locator) => locator.source.kind === "pdf" ? locator.source.pageRanges : [])),
        }
      : {
          kind: "web" as const,
          anchors: locators
            .flatMap((locator) => locator.source.kind === "web" ? locator.source.anchors : [])
            .filter((anchor, index, anchors) => {
              const key = `${anchor.url}\u0000${anchor.heading ?? ""}\u0000${anchor.anchor ?? ""}`;
              return anchors.findIndex((candidate) => `${candidate.url}\u0000${candidate.heading ?? ""}\u0000${candidate.anchor ?? ""}` === key) === index;
            }),
        };
  const parsed = skillSourceLocatorSchema.safeParse({
    version: MATERIAL_LOCATOR_VERSION,
    materialRevisionId: first.materialRevisionId,
    materialSectionIds,
    evidenceChunkIds,
    source,
  });
  if (!parsed.success) {
    throw new MaterialSourceReferenceError(
      "incompatible_source_reference",
      "The combined source references exceed the supported provenance bounds.",
    );
  }
  return parsed.data;
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function attachMaterialSourceReferencesToSkill(input: {
  userId: string;
  skillId: string;
  sourceRefs: readonly MaterialSourceReferenceInput[] | undefined;
  client?: SourceReferenceClient;
}) {
  if (!input.sourceRefs?.length) return { references: [], attachedCount: 0, mergedCount: 0, unchangedCount: 0 };
  const run = async (client: SourceReferenceClient) => {
    const skill = await client.skill.findFirst({
      where: { id: input.skillId, userId: input.userId },
      select: { id: true },
    });
    if (!skill) throw new MaterialSourceReferenceError("material_not_found", "The skill was not found.");
    const resolved = await resolveMaterialSourceReferences({
      userId: input.userId,
      sourceRefs: input.sourceRefs,
      client,
    });
    const bySourceFile = new Map<string, ResolvedMaterialSourceReference[]>();
    for (const reference of resolved) {
      const current = bySourceFile.get(reference.sourceFileId) ?? [];
      current.push(reference);
      bySourceFile.set(reference.sourceFileId, current);
    }
    const existing = await client.skillSourceRef.findMany({
      where: {
        userId: input.userId,
        skillId: input.skillId,
        sourceFileId: { in: [...bySourceFile.keys()] },
      },
      select: { id: true, sourceFileId: true, locator: true, note: true },
    });
    const existingBySourceFile = new Map(existing.map((reference) => [reference.sourceFileId, reference]));
    const references: Array<{ id: string; sourceFileId: string; locator: SkillSourceLocator; status: "attached" | "merged" | "unchanged" }> = [];
    let attachedCount = 0;
    let mergedCount = 0;
    let unchangedCount = 0;
    for (const [sourceFileId, referencesForFile] of bySourceFile) {
      const locator = mergeMaterialSourceLocators(referencesForFile.map((reference) => reference.locator));
      const previous = existingBySourceFile.get(sourceFileId);
      if (!previous) {
        const created = await client.skillSourceRef.create({
          data: {
            userId: input.userId,
            skillId: input.skillId,
            sourceFileId,
            locator: toInputJson(locator),
          },
          select: { id: true, sourceFileId: true },
        });
        references.push({ id: created.id, sourceFileId: created.sourceFileId, locator, status: "attached" });
        attachedCount += 1;
        continue;
      }
      const previousLocator = skillSourceLocatorSchema.safeParse(previous.locator);
      if (!previousLocator.success) {
        throw new MaterialSourceReferenceError(
          "incompatible_source_reference",
          "An existing source reference cannot be safely merged.",
        );
      }
      const merged = mergeMaterialSourceLocators([previousLocator.data, locator]);
      const unchanged = JSON.stringify(merged) === JSON.stringify(previousLocator.data);
      if (!unchanged) {
        await client.skillSourceRef.update({
          where: { id: previous.id },
          data: { locator: toInputJson(merged) },
        });
        mergedCount += 1;
      } else {
        unchangedCount += 1;
      }
      references.push({
        id: previous.id,
        sourceFileId,
        locator: merged,
        status: unchanged ? "unchanged" : "merged",
      });
    }
    return { references, attachedCount, mergedCount, unchangedCount };
  };
  if (input.client) return run(input.client);
  return getPrisma().$transaction((client) => run(client));
}
