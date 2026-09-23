import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/jobs/events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs/events")>()),
  sendAgentSkillOperationRequested: vi.fn().mockResolvedValue(undefined),
}));

import {
  AgentOperationItemStatus,
  AgentOperationStatus,
  MaterialPageTextStatus,
  SkillStatus,
  SourceFileKind,
  SourceFileStatus,
  StudyMaterialKind,
  StudyMaterialStatus,
} from "@/generated/prisma/client";
import { getAgentSkill } from "@/lib/agent-access/library";
import type { AgentAccessScope, AgentAuthContext } from "@/lib/agent-access/auth";
import { createAgentSpecOperation } from "@/lib/agent-access/operations";
import { getPrisma } from "@/lib/prisma";
import {
  readMaterialContent,
} from "@/lib/materials/reader";
import {
  attachMaterialSourceReferencesToSkill,
  resolveMaterialSourceReferences,
} from "@/lib/materials/source-references";
import {
  createMaterialWithInitialRevision,
  finalizeMaterialRevision,
} from "@/lib/materials/lifecycle";
import { runAgentSkillOperationJob } from "@/lib/agent-access/worker";

const describeDatabase = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
const runId = `material_reader_refs_${randomUUID()}`;

describeDatabase("material reader and source references", () => {
  const prisma = getPrisma();
  const userIds: string[] = [];

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  async function createFixture(label: string) {
    const userId = `${runId}_${label}`;
    userIds.push(userId);
    await prisma.user.create({
      data: { id: userId, email: `${userId}@example.test` },
    });
    const { material, revision } = await createMaterialWithInitialRevision({
      userId,
      title: `Spanish workbook ${label}`,
      kind: StudyMaterialKind.PDF,
      sourceUrl: "https://example.test/spanish.pdf",
    });
    const sourceFile = await prisma.sourceFile.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        kind: SourceFileKind.PDF,
        status: SourceFileStatus.READY,
        originalName: `${label}.pdf`,
        mimeType: "application/pdf",
        storageBucket: "test-materials",
        storageKey: `${runId}/${label}.pdf`,
      },
    });
    const root = await prisma.materialSection.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        ordinal: 0,
        level: 1,
        title: "Capítulo repetido",
        normalizedTitle: "capitulo repetido",
        pageStart: 1,
        pageEnd: 3,
        headingPath: ["Capítulo repetido"],
      },
    });
    const child = await prisma.materialSection.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        parentId: root.id,
        ordinal: 1,
        level: 2,
        title: "Capítulo repetido",
        normalizedTitle: "capitulo repetido",
        pageStart: 2,
        pageEnd: 2,
        headingPath: ["Capítulo repetido", "Capítulo repetido"],
      },
    });
    const chunks = await Promise.all([
      prisma.materialChunk.create({
        data: {
          userId,
          materialRevisionId: revision.id,
          materialSectionId: child.id,
          sourceFileId: sourceFile.id,
          ordinal: 0,
          text: "La selección de pronombres depende de la función en la oración.\n\n",
          tokenEstimate: 12,
          contentHash: `${runId}:${label}:chunk-1`,
          locator: { kind: "pdf", pageRange: { start: 2, end: 2 } },
          headingText: "Capítulo repetido",
        },
      }),
      prisma.materialChunk.create({
        data: {
          userId,
          materialRevisionId: revision.id,
          materialSectionId: child.id,
          sourceFileId: sourceFile.id,
          ordinal: 1,
          text: "El pronombre debe concordar con el objeto.\n\nEjemplo: Lo veo.",
          tokenEstimate: 13,
          contentHash: `${runId}:${label}:chunk-2`,
          locator: { kind: "pdf", pageRange: { start: 2, end: 2 } },
          headingText: "Capítulo repetido",
        },
      }),
    ]);
    const rootChunk = await prisma.materialChunk.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        materialSectionId: root.id,
        sourceFileId: sourceFile.id,
        ordinal: 2,
        text: "El capítulo introduce el sistema de pronombres y sus funciones.",
        tokenEstimate: 10,
        contentHash: `${runId}:${label}:root-chunk`,
        locator: { kind: "pdf", pageRange: { start: 1, end: 3 } },
        headingText: "Capítulo repetido",
      },
    });
    await prisma.materialPage.create({
      data: {
        userId,
        materialRevisionId: revision.id,
        pageNumber: 3,
        textStatus: MaterialPageTextStatus.NEEDS_OCR,
        contentHash: `${runId}:${label}:page-3`,
      },
    });
    await finalizeMaterialRevision({
      userId,
      materialId: material.id,
      materialRevisionId: revision.id,
      contentHash: `${runId}:${label}:revision`,
      byteSize: 10,
      pageCount: 3,
      storageBucket: "test-materials",
      storageKey: `${runId}/${label}.pdf`,
    });
    const skill = await prisma.skill.create({
      data: {
        userId,
        title: `Pronombres ${label}`,
        objective: "Choose the correct Spanish direct object pronoun in a short sentence.",
        status: SkillStatus.DRAFT,
      },
    });
    return { userId, material, revision, sourceFile, root, child, chunks, rootChunk, skill };
  }

  async function createConnection(userId: string, scopes: AgentAccessScope[]) {
    const identity = await prisma.workosIdentity.create({
      data: {
        userId,
        workosUserId: `${runId}:${userId}:workos`,
        externalId: `${runId}:${userId}:external`,
      },
    });
    const connection = await prisma.agentConnection.create({
      data: {
        userId,
        workosIdentityId: identity.id,
        workosSubject: identity.externalId,
        workosSessionId: `${runId}:${userId}:session`,
        workosApplicationId: `${runId}:${userId}:application`,
        clientId: `https://${userId}.example.test/client.json`,
        clientName: "source reference test client",
        clientDomain: `${userId}.example.test`,
        resourceUrl: "https://learnrecur.com/mcp",
        scopes,
      },
    });
    const auth: AgentAuthContext = {
      userId,
      connectionId: connection.id,
      subject: connection.workosSubject,
      sessionId: connection.workosSessionId,
      clientId: connection.clientId,
      clientName: connection.clientName,
      clientDomain: connection.clientDomain,
      resourceUrl: connection.resourceUrl,
      expiresAt: Math.floor(Date.now() / 1_000) + 600,
      permissionVersion: connection.permissionVersion,
      scopes,
    };
    return auth;
  }

  it("reads an owned section and page range without mutating OCR or study state", async () => {
    const fixture = await createFixture("reader");
    const beforePage = await prisma.materialPage.findUniqueOrThrow({
      where: { materialRevisionId_pageNumber: { materialRevisionId: fixture.revision.id, pageNumber: 3 } },
      select: { textStatus: true, ocrText: true },
    });
    const first = await readMaterialContent({
      userId: fixture.userId,
      materialId: fixture.material.id,
      expectedRevisionId: fixture.revision.id,
      sectionId: fixture.root.id,
      maxChars: 24,
    });
    let text = first.segments.map((segment) => segment.text).join("");
    let cursor = first.next_cursor;
    while (cursor) {
      const next = await readMaterialContent({
        userId: fixture.userId,
        materialId: fixture.material.id,
        expectedRevisionId: fixture.revision.id,
        sectionId: fixture.root.id,
        cursor,
        maxChars: 24,
      });
      text += next.segments.map((segment) => segment.text).join("");
      cursor = next.next_cursor;
    }
    expect(text).toContain("pronombres");
    expect(text).toContain("\n\n");
    expect(first.segments[0]).toMatchObject({
      section_id: fixture.child.id,
      section_path: ["Capítulo repetido", "Capítulo repetido"],
      locator: { revision_id: fixture.revision.id },
    });
    const pageRange = await readMaterialContent({
      userId: fixture.userId,
      materialId: fixture.material.id,
      expectedRevisionId: fixture.revision.id,
      pageRange: { start: 2, end: 3 },
      maxChars: 1_000,
    });
    expect(pageRange.segments.map((segment) => segment.page_number)).not.toContain(1);
    expect(pageRange.extraction_gaps).toEqual([
      expect.objectContaining({ page_number: 3, status: "needs_ocr" }),
    ]);
    expect(pageRange.fully_traversed).toBe(false);
    const afterPage = await prisma.materialPage.findUniqueOrThrow({
      where: { materialRevisionId_pageNumber: { materialRevisionId: fixture.revision.id, pageNumber: 3 } },
      select: { textStatus: true, ocrText: true },
    });
    expect(afterPage).toEqual(beforePage);
    await expect(
      prisma.skill.findUniqueOrThrow({ where: { id: fixture.skill.id }, select: { firstIntroducedAt: true, status: true } }),
    ).resolves.toEqual({ firstIntroducedAt: null, status: SkillStatus.DRAFT });
  });

  it("rejects stale and cross-account reads without leaking the revision", async () => {
    const fixture = await createFixture("ownership");
    const otherUserId = `${runId}_other_reader`;
    userIds.push(otherUserId);
    await prisma.user.create({ data: { id: otherUserId, email: `${otherUserId}@example.test` } });
    await expect(
      readMaterialContent({
        userId: otherUserId,
        materialId: fixture.material.id,
        expectedRevisionId: fixture.revision.id,
        sectionId: fixture.root.id,
      }),
    ).rejects.toMatchObject({ code: "material_not_found" });
    await expect(
      readMaterialContent({
        userId: fixture.userId,
        materialId: fixture.material.id,
        expectedRevisionId: "stale-revision",
        sectionId: fixture.root.id,
      }),
    ).rejects.toMatchObject({ code: "stale_material_revision" });
  });

  it("derives canonical locators, validates selected scope, merges compatible links, and exposes them in skill reads", async () => {
    const fixture = await createFixture("linking");
    const valid = {
      material_id: fixture.material.id,
      expected_revision_id: fixture.revision.id,
      section_ids: [fixture.child.id],
      evidence_chunk_ids: [fixture.chunks[1].id],
    } as const;
    const resolved = await resolveMaterialSourceReferences({ userId: fixture.userId, sourceRefs: [valid] });
    expect(resolved[0]).toMatchObject({
      sourceFileId: fixture.sourceFile.id,
      locator: {
        version: 1,
        materialRevisionId: fixture.revision.id,
        materialSectionIds: [fixture.child.id],
        evidenceChunkIds: [fixture.chunks[1].id],
        source: { kind: "pdf", pageRanges: [{ start: 2, end: 2 }] },
      },
    });

    await prisma.materialSection.update({
      where: { id: fixture.child.id },
      data: { pageEnd: 60 },
    });
    const chunkOnly = await resolveMaterialSourceReferences({
      userId: fixture.userId,
      sourceRefs: [{
        material_id: fixture.material.id,
        expected_revision_id: fixture.revision.id,
        evidence_chunk_ids: [fixture.chunks[1].id],
      }],
    });
    expect(chunkOnly[0].locator).toMatchObject({
      materialSectionIds: [fixture.child.id],
      evidenceChunkIds: [fixture.chunks[1].id],
      source: { kind: "pdf", pageRanges: [{ start: 2, end: 2 }] },
    });
    const sectionAndChunk = await resolveMaterialSourceReferences({
      userId: fixture.userId,
      sourceRefs: [valid],
    });
    expect(sectionAndChunk[0].locator.source).toMatchObject({
      kind: "pdf",
      pageRanges: [{ start: 2, end: 60 }],
    });
    await prisma.materialSection.update({
      where: { id: fixture.child.id },
      data: { pageEnd: 2 },
    });

    await expect(
      resolveMaterialSourceReferences({
        userId: fixture.userId,
        sourceRefs: [{ ...valid, evidence_chunk_ids: [fixture.rootChunk.id] }],
      }),
    ).rejects.toMatchObject({ code: "invalid_source_reference" });
    await expect(
      resolveMaterialSourceReferences({
        userId: fixture.userId,
        sourceRefs: [{ ...valid, expected_revision_id: "stale-revision" }],
      }),
    ).rejects.toMatchObject({ code: "stale_material_revision" });
    await expect(
      resolveMaterialSourceReferences({ userId: `${runId}_unknown`, sourceRefs: [valid] }),
    ).rejects.toMatchObject({ code: "material_not_found" });

    const attached = await attachMaterialSourceReferencesToSkill({
      userId: fixture.userId,
      skillId: fixture.skill.id,
      sourceRefs: [valid],
    });
    expect(attached.attachedCount).toBe(1);
    await attachMaterialSourceReferencesToSkill({
      userId: fixture.userId,
      skillId: fixture.skill.id,
      sourceRefs: [{
        material_id: fixture.material.id,
        expected_revision_id: fixture.revision.id,
        section_ids: [fixture.root.id],
        evidence_chunk_ids: [fixture.rootChunk.id],
      }],
    });
    const stored = await prisma.skillSourceRef.findMany({ where: { skillId: fixture.skill.id }, select: { locator: true } });
    expect(stored).toHaveLength(1);
    expect(stored[0].locator).toMatchObject({
      materialRevisionId: fixture.revision.id,
      evidenceChunkIds: [fixture.rootChunk.id, fixture.chunks[1].id].toSorted(),
      source: { kind: "pdf", pageRanges: [{ start: 1, end: 3 }] },
    });
    const auth = await createConnection(fixture.userId, ["skills:read"]);
    const publicSkill = await getAgentSkill(auth, { skill_id: fixture.skill.id });
    expect(publicSkill.skill).toMatchObject({
      source_links: [
        expect.objectContaining({
          revision_id: fixture.revision.id,
          section_ids: [fixture.root.id, fixture.child.id].toSorted(),
          evidence_chunk_ids: [fixture.rootChunk.id, fixture.chunks[1].id].toSorted(),
          page_ranges: [{ start: 1, end: 3 }],
        }),
      ],
    });
  });

  it("keeps source references in operation snapshots and fails delayed work after deletion", async () => {
    const fixture = await createFixture("delayed");
    const auth = await createConnection(fixture.userId, ["skills:create", "materials:read"]);
    const request = {
      idempotency_key: `${runId}_source_refs_operation`,
      items: [{
        client_reference: "spanish-pronouns",
        skill: {
          title: "Spanish direct object pronouns",
          objective: "Choose the direct object pronoun that fits a clearly specified sentence.",
          rules: ["Match the pronoun to the object."],
          examples: ["Lo veo."],
          exerciseConstraints: "Use short Spanish sentences.",
          tags: ["spanish"],
        },
        source_refs: [{
          material_id: fixture.material.id,
          expected_revision_id: fixture.revision.id,
          section_ids: [fixture.child.id],
          evidence_chunk_ids: [fixture.chunks[1].id],
        }],
      }],
    };
    const operation = await createAgentSpecOperation(auth, request);
    const stored = await prisma.agentSkillOperation.findUniqueOrThrow({
      where: { id: operation.operation_id },
      include: { items: true },
    });
    expect(stored.requestPayload).toMatchObject({ items: [{ source_refs: request.items[0].source_refs }] });
    expect(stored.items[0].skillSnapshot).toMatchObject({ source_refs: request.items[0].source_refs });
    await expect(
      createAgentSpecOperation(auth, {
        ...request,
        items: [{ ...request.items[0], source_refs: [{ ...request.items[0].source_refs[0], section_ids: [fixture.root.id] }] }],
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });

    await prisma.studyMaterial.update({ where: { id: fixture.material.id }, data: { status: StudyMaterialStatus.DELETING } });
    await expect(
      runAgentSkillOperationJob({ userId: fixture.userId, operationId: operation.operation_id, now: new Date("2026-09-17T12:00:00.000Z") }),
    ).resolves.toMatchObject({ status: "processed" });
    await expect(
      prisma.agentSkillOperationItem.findUniqueOrThrow({ where: { id: stored.items[0].id } }),
    ).resolves.toMatchObject({ status: AgentOperationItemStatus.FAILED, errorCode: "SOURCE_REFERENCE_MATERIAL_NOT_FOUND" });
    await expect(
      prisma.agentSkillOperation.findUniqueOrThrow({ where: { id: operation.operation_id }, select: { status: true } }),
    ).resolves.toEqual({ status: AgentOperationStatus.FAILED });
    await expect(
      prisma.skill.count({ where: { userId: fixture.userId, title: "Spanish direct object pronouns" } }),
    ).resolves.toBe(0);
  });
});
