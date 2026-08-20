import "server-only";

import { MaterialRevisionStatus, StudyMaterialStatus } from "@/generated/prisma/client";
import type { AgentAuthContext } from "@/lib/agent-access/auth";
import {
  agentGetMaterialOutlineSchema,
  agentListMaterialsSchema,
  agentSearchMaterialExcerptsSchema,
} from "@/lib/agent-access/contracts";
import { consumeAgentReadRateLimit } from "@/lib/agent-access/operations";
import { searchMaterialChunksLexical } from "@/lib/materials/retrieval";
import { getPrisma } from "@/lib/prisma";

const MAX_EXCERPT_CHARS = 1_500;
const MAX_EXCERPT_TOTAL_CHARS = 4_000;

export class AgentMaterialError extends Error {
  constructor(
    readonly code: "material_not_found" | "stale_material_revision" | "invalid_cursor",
    message: string,
  ) {
    super(message);
    this.name = "AgentMaterialError";
  }
}

export async function listAgentMaterials(auth: AgentAuthContext, rawInput: unknown) {
  const input = agentListMaterialsSchema.parse(rawInput);
  await consumeAgentReadRateLimit(auth);
  const cursor = decodeCursor(input.cursor);
  const prisma = getPrisma();
  const rows = await prisma.studyMaterial.findMany({
    where: {
      userId: auth.userId,
      status: StudyMaterialStatus.ACTIVE,
      activeRevision: { status: MaterialRevisionStatus.READY },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    ...(cursor
      ? {
          cursor: { id: cursor },
          skip: 1,
        }
      : {}),
    select: {
      id: true,
      title: true,
      kind: true,
      updatedAt: true,
      activeRevision: {
        select: {
          id: true,
          revisionNumber: true,
          pageCount: true,
          summary: true,
        },
      },
    },
  });
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  return {
    materials: page.map((row) => ({
      material_id: row.id,
      title: row.title,
      kind: row.kind.toLocaleLowerCase("en-US"),
      revision_id: row.activeRevision?.id ?? null,
      revision_number: row.activeRevision?.revisionNumber ?? null,
      page_count: row.activeRevision?.pageCount ?? null,
      summary: truncate(row.activeRevision?.summary ?? null, 500),
      updated_at: row.updatedAt.toISOString(),
    })),
    next_cursor: hasMore ? encodeCursor(page.at(-1)?.id) : null,
  };
}

export async function getAgentMaterialOutline(auth: AgentAuthContext, rawInput: unknown) {
  const input = agentGetMaterialOutlineSchema.parse(rawInput);
  await consumeAgentReadRateLimit(auth);
  const cursorOrdinal = decodeOrdinalCursor(input.cursor);
  const prisma = getPrisma();
  const material = await prisma.studyMaterial.findFirst({
    where: { id: input.material_id, userId: auth.userId, status: StudyMaterialStatus.ACTIVE },
    select: { id: true, title: true, activeRevisionId: true },
  });
  if (!material?.activeRevisionId) throw new AgentMaterialError("material_not_found", "The material was not found.");
  if (input.expected_revision_id && input.expected_revision_id !== material.activeRevisionId) {
    throw new AgentMaterialError("stale_material_revision", "The active material revision changed.");
  }
  const revision = await prisma.materialRevision.findFirst({
    where: { id: material.activeRevisionId, userId: auth.userId, status: MaterialRevisionStatus.READY },
    select: { id: true, revisionNumber: true },
  });
  if (!revision) throw new AgentMaterialError("material_not_found", "The material is not ready.");
  const rows = await prisma.materialSection.findMany({
    where: {
      userId: auth.userId,
      materialRevisionId: revision.id,
      ...(cursorOrdinal === null ? {} : { ordinal: { gt: cursorOrdinal } }),
    },
    orderBy: { ordinal: "asc" },
    take: input.limit + 1,
    select: {
      id: true,
      parentId: true,
      ordinal: true,
      level: true,
      title: true,
      headingPath: true,
      pageStart: true,
      pageEnd: true,
    },
  });
  const hasMore = rows.length > input.limit;
  const page = rows.slice(0, input.limit);
  return {
    material_id: material.id,
    title: material.title,
    revision_id: revision.id,
    revision_number: revision.revisionNumber,
    sections: page.map((section) => ({
      section_id: section.id,
      parent_section_id: section.parentId,
      level: section.level,
      title: section.title,
      heading_path: section.headingPath,
      page_start: section.pageStart,
      page_end: section.pageEnd,
    })),
    next_cursor: hasMore ? encodeOrdinalCursor(page.at(-1)?.ordinal) : null,
  };
}

export async function searchAgentMaterialExcerpts(auth: AgentAuthContext, rawInput: unknown) {
  const input = agentSearchMaterialExcerptsSchema.parse(rawInput);
  await consumeAgentReadRateLimit(auth);
  const prisma = getPrisma();
  const material = await prisma.studyMaterial.findFirst({
    where: {
      id: input.material_id,
      userId: auth.userId,
      status: StudyMaterialStatus.ACTIVE,
      activeRevisionId: input.expected_revision_id,
    },
    select: { activeRevision: { select: { id: true, status: true } } },
  });
  if (!material) throw new AgentMaterialError("stale_material_revision", "The material or revision was not found.");
  if (material.activeRevision?.status !== MaterialRevisionStatus.READY) {
    throw new AgentMaterialError("material_not_found", "The material is not ready.");
  }
  if (input.section_ids?.length) {
    const ownedSections = await prisma.materialSection.count({
      where: {
        id: { in: input.section_ids },
        userId: auth.userId,
        materialRevisionId: input.expected_revision_id,
      },
    });
    if (ownedSections !== input.section_ids.length) {
      throw new AgentMaterialError("material_not_found", "One or more material sections were not found.");
    }
  }
  const matches = await searchMaterialChunksLexical({
    userId: auth.userId,
    materialRevisionId: input.expected_revision_id,
    query: input.query,
    materialSectionIds: input.section_ids,
    limit: input.limit,
    excludeLikelyBackMatter: true,
  });
  let remaining = MAX_EXCERPT_TOTAL_CHARS;
  return {
    material_id: input.material_id,
    revision_id: input.expected_revision_id,
    excerpts: matches.flatMap((match) => {
      if (remaining <= 0) return [];
      const text = match.text.slice(0, Math.min(MAX_EXCERPT_CHARS, remaining));
      remaining -= text.length;
      return [{
        section_id: match.materialSectionId,
        heading: match.headingText,
        excerpt: text,
        locator: sanitizeLocator(match.locator),
      }];
    }),
  };
}

export function sanitizeLocator(locator: unknown) {
  if (!locator || typeof locator !== "object" || Array.isArray(locator)) return null;
  const value = locator as Record<string, unknown>;
  const safe: Record<string, string | number> = {};
  for (const key of ["page", "pageStart", "pageEnd", "sectionTitle", "heading"] as const) {
    const child = value[key];
    if (typeof child === "number" && Number.isFinite(child)) safe[key] = child;
    if (typeof child === "string" && child.length <= 300) safe[key] = child;
  }
  return Object.keys(safe).length ? safe : null;
}

function encodeCursor(value?: string) {
  return value ? Buffer.from(value, "utf8").toString("base64url") : null;
}

function decodeCursor(value?: string) {
  if (!value) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (!decoded || decoded.length > 200) throw new Error("invalid");
    return decoded;
  } catch {
    throw new AgentMaterialError("invalid_cursor", "The pagination cursor is invalid.");
  }
}

function encodeOrdinalCursor(value?: number) {
  return typeof value === "number" ? Buffer.from(String(value), "utf8").toString("base64url") : null;
}

function decodeOrdinalCursor(value?: string) {
  if (!value) return null;
  const decoded = Number(Buffer.from(value, "base64url").toString("utf8"));
  if (!Number.isInteger(decoded) || decoded < 0) {
    throw new AgentMaterialError("invalid_cursor", "The pagination cursor is invalid.");
  }
  return decoded;
}

function truncate(value: string | null, max: number) {
  if (!value || value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}
