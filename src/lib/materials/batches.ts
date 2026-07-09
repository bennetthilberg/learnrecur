import "server-only";

import { isDeepStrictEqual } from "node:util";

import {
  MaterialRevisionStatus,
  Prisma,
  SkillDraftBatchItemStatus,
  SkillDraftBatchStatus,
  SkillStatus,
  SourceFileStatus,
} from "@/generated/prisma/client";
import { getInngestEnvStatus } from "@/lib/inngest/client";
import {
  inngestMaterialDraftItemEventSender,
  type MaterialDraftItemEventSender,
} from "@/lib/inngest/events";
import {
  resolveMaterialDraftAiSetup,
  type MaterialDraftAiSetup,
} from "@/lib/materials/ai";
import {
  confirmMaterialPlanInputSchema,
  materialScopePlanSchema,
  materialScopeResolutionSchema,
  planMaterialSkillsInputSchema,
  replanMaterialSkillsInputSchema,
  skillSourceLocatorSchema,
  type MaterialScopeResolution,
} from "@/lib/materials/contracts";
import {
  annotateMaterialPlanOverlaps,
  generateVerifiedMaterialDraft,
  resolveStructuralMaterialScope,
  summarizeMaterialDraftBatch,
  validateMaterialScopePlannerResponse,
  type MaterialPlanningSection,
} from "@/lib/materials/drafting";
import {
  createGeminiMaterialEmbeddingGenerator,
  type MaterialEmbeddingGenerator,
} from "@/lib/materials/embeddings";
import { createIdempotentDraftBatch } from "@/lib/materials/lifecycle";
import {
  searchMaterialChunks,
  searchMaterialChunksLexical,
  type MaterialChunkSearchResult,
} from "@/lib/materials/retrieval";
import { getPrisma } from "@/lib/prisma";
import { REQUESTED_ACTIVATION_EXERCISES } from "@/lib/skills";

const PLANNING_CHUNK_LIMIT = 60;
const GENERATION_EVIDENCE_CHARACTER_LIMIT = 24_000;

export class MaterialDraftGenerationError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "MaterialDraftGenerationError";
    this.retryable = options.retryable;
  }
}

export async function planMaterialSkills(input: {
  userId: string;
  input: unknown;
  now: Date;
  aiSetup?: MaterialDraftAiSetup;
  embeddingGenerator?: MaterialEmbeddingGenerator | null;
}) {
  const parsed = planMaterialSkillsInputSchema.safeParse(input.input);
  if (!parsed.success) {
    return {
      status: "invalid" as const,
      message: "Describe the material scope before planning skills.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const prisma = getPrisma();
  const revision = await prisma.materialRevision.findFirst({
    where: {
      id: parsed.data.materialRevisionId,
      materialId: parsed.data.materialId,
      userId: input.userId,
      status: MaterialRevisionStatus.READY,
      material: { status: { not: "DELETING" } },
    },
    select: { id: true },
  });
  if (!revision) {
    return { status: "not-found" as const, message: "Ready material revision was not found." };
  }

  let batch;
  try {
    batch = await createIdempotentDraftBatch({
      userId: input.userId,
      materialRevisionId: parsed.data.materialRevisionId,
      instruction: parsed.data.instruction,
      idempotencyKey: parsed.data.idempotencyKey,
    });
  } catch (error) {
    return {
      status: "invalid" as const,
      message: error instanceof Error ? error.message : "This planning request could not be reused.",
    };
  }

  const existingPlan = materialScopeResolutionSchema.safeParse(batch.proposedPlan);
  if (existingPlan.success) {
    return planResult(batch.id, existingPlan.data);
  }

  return planExistingMaterialBatch({
    userId: input.userId,
    batchId: batch.id,
    now: input.now,
    aiSetup: input.aiSetup,
    embeddingGenerator: input.embeddingGenerator,
  });
}

export async function replanMaterialSkills(input: {
  userId: string;
  input: unknown;
  now: Date;
  aiSetup?: MaterialDraftAiSetup;
  embeddingGenerator?: MaterialEmbeddingGenerator | null;
}) {
  const parsed = replanMaterialSkillsInputSchema.safeParse(input.input);
  if (!parsed.success) {
    return {
      status: "invalid" as const,
      message: "Clarify which chapters, sections, or concepts you want.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const prisma = getPrisma();
  const updated = await prisma.skillDraftBatch.updateMany({
    where: {
      id: parsed.data.batchId,
      userId: input.userId,
      confirmedAt: null,
      status: { in: [SkillDraftBatchStatus.NEEDS_SCOPE, SkillDraftBatchStatus.PLANNED] },
      items: { none: {} },
    },
    data: {
      instruction: parsed.data.instruction,
      proposedPlan: Prisma.JsonNull,
      planningMetadata: Prisma.JsonNull,
      status: SkillDraftBatchStatus.PLANNING,
      requestedCount: 0,
      errorCode: null,
      errorMessage: null,
      completedAt: null,
    },
  });
  if (updated.count !== 1) {
    return { status: "not-found" as const, message: "Editable scope plan was not found." };
  }
  return planExistingMaterialBatch({
    userId: input.userId,
    batchId: parsed.data.batchId,
    now: input.now,
    aiSetup: input.aiSetup,
    embeddingGenerator: input.embeddingGenerator,
  });
}

export async function confirmMaterialPlan(input: {
  userId: string;
  input: unknown;
  now: Date;
  eventSender?: MaterialDraftItemEventSender;
}) {
  const parsed = confirmMaterialPlanInputSchema.safeParse(input.input);
  if (!parsed.success) {
    return { status: "invalid" as const, message: "The scope plan changed or is incomplete." };
  }
  const prisma = getPrisma();
  const batch = await prisma.skillDraftBatch.findFirst({
    where: { id: parsed.data.batchId, userId: input.userId },
    include: { items: { orderBy: { ordinal: "asc" } } },
  });
  if (!batch) {
    return { status: "not-found" as const, message: "Material skill batch was not found." };
  }
  if (batch.confirmedAt && batch.items.length > 0) {
    return {
      status: "queued" as const,
      batchId: batch.id,
      queuedItemIds: batch.items
        .filter((item) => item.status === SkillDraftBatchItemStatus.PLANNED)
        .map((item) => item.id),
      alreadyConfirmed: true,
    };
  }
  const proposed = materialScopePlanSchema.safeParse(batch.proposedPlan);
  if (!proposed.success || !isDeepStrictEqual(proposed.data, parsed.data.plan)) {
    return {
      status: "invalid" as const,
      message: "The submitted scope no longer matches the reviewed plan. Review it again.",
    };
  }
  const itemsToQueue = proposed.data.items.filter((item) => !item.overlapSkillId);
  if (itemsToQueue.length > 0) {
    const env = getInngestEnvStatus();
    if (env.status === "missing-env" && !input.eventSender) {
      return { status: "not-queued" as const, message: env.message };
    }
  }

  const createdItems = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM "skill_draft_batches"
      WHERE "id" = ${batch.id} AND "userId" = ${input.userId}
      FOR UPDATE
    `;
    const existingCount = await tx.skillDraftBatchItem.count({
      where: { batchId: batch.id, userId: input.userId },
    });
    if (existingCount > 0) {
      return tx.skillDraftBatchItem.findMany({
        where: { batchId: batch.id, userId: input.userId },
        orderBy: { ordinal: "asc" },
      });
    }
    const rows = [];
    for (const [ordinal, item] of proposed.data.items.entries()) {
      rows.push(
        await tx.skillDraftBatchItem.create({
          data: {
            userId: input.userId,
            batchId: batch.id,
            ordinal,
            targetKey: item.key,
            proposedTitle: item.title,
            proposedObjective: item.objective,
            locator: toInputJson(item.locator),
            status: item.overlapSkillId
              ? SkillDraftBatchItemStatus.EXCLUDED
              : SkillDraftBatchItemStatus.PLANNED,
            overlapSkillId: item.overlapSkillId ?? null,
            errorCode: item.overlapSkillId ? "EXACT_DUPLICATE" : null,
            errorMessage: item.overlapWarning ?? null,
          },
        }),
      );
    }
    const excludedCount = rows.filter(
      (item) => item.status === SkillDraftBatchItemStatus.EXCLUDED,
    ).length;
    await tx.skillDraftBatch.update({
      where: { id: batch.id },
      data: {
        confirmedPlan: toInputJson(proposed.data),
        confirmedAt: input.now,
        status:
          excludedCount === rows.length
            ? SkillDraftBatchStatus.READY
            : SkillDraftBatchStatus.GENERATING,
        requestedCount: rows.length,
        excludedCount,
        completedAt: excludedCount === rows.length ? input.now : null,
      },
    });
    return rows;
  });

  const queuedItems = createdItems.filter(
    (item) => item.status === SkillDraftBatchItemStatus.PLANNED,
  );
  const sender = input.eventSender ?? inngestMaterialDraftItemEventSender;
  const sendResults = await Promise.allSettled(
    queuedItems.map((item) =>
      sender.sendMaterialDraftItemRequested({
        userId: input.userId,
        batchId: batch.id,
        itemId: item.id,
        requestedAt: input.now.toISOString(),
      }),
    ),
  );
  const failedItemIds = sendResults.flatMap((result, index) =>
    result.status === "rejected" ? [queuedItems[index].id] : [],
  );
  if (failedItemIds.length > 0) {
    await prisma.skillDraftBatchItem.updateMany({
      where: {
        id: { in: failedItemIds },
        userId: input.userId,
        status: SkillDraftBatchItemStatus.PLANNED,
      },
      data: {
        status: SkillDraftBatchItemStatus.FAILED,
        errorCode: "EVENT_SEND_FAILED",
        errorMessage: "Draft generation could not be queued. Retry this item.",
      },
    });
    await reconcileMaterialDraftBatch({ userId: input.userId, batchId: batch.id, now: input.now });
  }

  return {
    status: failedItemIds.length === 0 ? ("queued" as const) : ("partial" as const),
    batchId: batch.id,
    queuedItemIds: queuedItems
      .map((item) => item.id)
      .filter((itemId) => !failedItemIds.includes(itemId)),
    failedItemIds,
    alreadyConfirmed: false,
  };
}

export async function runMaterialDraftItemJob(input: {
  userId: string;
  batchId: string;
  itemId: string;
  now?: Date;
  aiSetup?: MaterialDraftAiSetup;
}) {
  const prisma = getPrisma();
  const item = await prisma.skillDraftBatchItem.findFirst({
    where: { id: input.itemId, batchId: input.batchId, userId: input.userId },
    select: {
      id: true,
      status: true,
      proposedTitle: true,
      proposedObjective: true,
      locator: true,
      batch: {
        select: {
          id: true,
          materialRevisionId: true,
          materialRevision: {
            select: {
              materialId: true,
              material: { select: { title: true, collectionId: true } },
              sourceFiles: {
                where: { status: SourceFileStatus.READY },
                orderBy: { createdAt: "asc" },
                take: 1,
                select: { id: true },
              },
            },
          },
        },
      },
    },
  });
  if (!item) {
    return { status: "not-found" as const };
  }
  if (item.status === SkillDraftBatchItemStatus.READY && item.id) {
    return { status: "ready" as const, alreadyGenerated: true };
  }
  if (item.status === SkillDraftBatchItemStatus.EXCLUDED) {
    return { status: "excluded" as const };
  }

  const claimed = await prisma.skillDraftBatchItem.updateMany({
    where: {
      id: item.id,
      userId: input.userId,
      status: { in: [SkillDraftBatchItemStatus.PLANNED, SkillDraftBatchItemStatus.FAILED] },
    },
    data: {
      status: SkillDraftBatchItemStatus.GENERATING,
      errorCode: null,
      errorMessage: null,
    },
  });
  if (claimed.count !== 1) {
    return { status: "not-claimed" as const };
  }

  const locator = skillSourceLocatorSchema.safeParse(item.locator);
  const sourceFile = item.batch.materialRevision.sourceFiles[0];
  if (!locator.success || !sourceFile) {
    await markMaterialDraftItemFailed({
      userId: input.userId,
      itemId: item.id,
      code: "INVALID_CONFIRMED_SCOPE",
      message: "The confirmed material evidence is no longer available.",
    });
    await reconcileMaterialDraftBatch({ userId: input.userId, batchId: input.batchId, now: input.now });
    return { status: "failed" as const, reason: "invalid-scope" as const };
  }

  try {
    const chunks = await prisma.materialChunk.findMany({
      where: {
        id: { in: locator.data.evidenceChunkIds },
        userId: input.userId,
        materialRevisionId: item.batch.materialRevisionId,
      },
      select: { id: true, ordinal: true, headingText: true, text: true },
    });
    if (chunks.length !== locator.data.evidenceChunkIds.length) {
      throw new MaterialDraftGenerationError("Confirmed evidence chunks were not found.", {
        retryable: false,
      });
    }
    const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
    const evidenceText = locator.data.evidenceChunkIds
      .map((chunkId) => chunksById.get(chunkId))
      .filter(isDefined)
      .map((chunk) => `${chunk.headingText ?? `Excerpt ${chunk.ordinal + 1}`}\n${chunk.text}`)
      .join("\n\n---\n\n")
      .slice(0, GENERATION_EVIDENCE_CHARACTER_LIMIT);
    const ai = input.aiSetup ?? resolveMaterialDraftAiSetup();
    const generated = await generateVerifiedMaterialDraft({
      target: { title: item.proposedTitle, objective: item.proposedObjective },
      materialTitle: item.batch.materialRevision.material.title,
      evidenceText,
      generateDraft: async (draftInput) => {
        await prisma.skillDraftBatchItem.update({
          where: { id: item.id },
          data: { generationAttempts: { increment: 1 } },
        });
        return ai.generateDraft(draftInput);
      },
      verifyDraft: ai.verifyDraft,
    });
    if (generated.status === "failed") {
      await markMaterialDraftItemFailed({
        userId: input.userId,
        itemId: item.id,
        code: generated.reason.toUpperCase().replaceAll("-", "_"),
        message: generated.message,
        generationMetadata: {
          model: ai.model,
          verification: "rejected",
          attemptsThisRun: generated.attempts,
        },
      });
      await reconcileMaterialDraftBatch({ userId: input.userId, batchId: input.batchId, now: input.now });
      return { status: "failed" as const, reason: generated.reason };
    }

    const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT pg_advisory_xact_lock(hashtext(${item.batch.materialRevision.materialId}))::text AS "lock"
      `;
      const existingSkills = await tx.skill.findMany({
        where: {
          userId: input.userId,
          sourceRefs: {
            some: {
              sourceFile: {
                materialRevision: { materialId: item.batch.materialRevision.materialId },
              },
            },
          },
        },
        select: { id: true, title: true, objective: true },
      });
      const duplicate = existingSkills.find(
        (skill) =>
          normalizeComparableText(skill.title) === normalizeComparableText(generated.draft.title) &&
          normalizeComparableText(skill.objective ?? "") ===
            normalizeComparableText(generated.draft.objective),
      );
      if (duplicate) {
        await tx.skillDraftBatchItem.update({
          where: { id: item.id },
          data: {
            status: SkillDraftBatchItemStatus.EXCLUDED,
            overlapSkillId: duplicate.id,
            errorCode: "EXACT_DUPLICATE",
            errorMessage: `An exact skill already exists: ${duplicate.title}.`,
            generationMetadata: {
              model: ai.model,
              verification: "verified",
              duplicatePrevented: true,
            },
          },
        });
        return { status: "duplicate" as const, skillId: duplicate.id };
      }
      const skill = await tx.skill.create({
        data: {
          userId: input.userId,
          collectionId: item.batch.materialRevision.material.collectionId,
          title: generated.draft.title,
          objective: generated.draft.objective,
          rules: { items: generated.draft.rules },
          examples: { items: generated.draft.examples },
          exerciseConstraints: {
            notes: generated.draft.exerciseConstraints,
            answerKind: "choice",
            requestedCount: REQUESTED_ACTIVATION_EXERCISES,
          },
          tags: generated.draft.tags,
          status: SkillStatus.DRAFT,
        },
      });
      await tx.skillSourceRef.create({
        data: {
          userId: input.userId,
          skillId: skill.id,
          sourceFileId: sourceFile.id,
          locator: toInputJson(locator.data),
        },
      });
      await tx.skillDraftBatchItem.update({
        where: { id: item.id },
        data: {
          skillId: skill.id,
          status: SkillDraftBatchItemStatus.READY,
          generationMetadata: {
            model: ai.model,
            verification: "verified",
            attemptsThisRun: generated.attempts,
          },
        },
      });
      await tx.studyMaterial.update({
        where: { id: item.batch.materialRevision.materialId },
        data: { lastUsedAt: input.now ?? new Date() },
      });
      return { status: "created" as const, skillId: skill.id };
    });
    await reconcileMaterialDraftBatch({ userId: input.userId, batchId: input.batchId, now: input.now });
    return saved.status === "duplicate"
      ? { status: "excluded" as const, duplicateSkillId: saved.skillId }
      : { status: "ready" as const, skillId: saved.skillId, alreadyGenerated: false };
  } catch (error) {
    const normalized = normalizeMaterialDraftError(error);
    await markMaterialDraftItemFailed({
      userId: input.userId,
      itemId: item.id,
      code: normalized.retryable ? "TRANSIENT_GENERATION_FAILURE" : "GENERATION_REJECTED",
      message: normalized.message,
    });
    await reconcileMaterialDraftBatch({ userId: input.userId, batchId: input.batchId, now: input.now });
    throw normalized;
  }
}

export async function retryMaterialDraftItem(input: {
  userId: string;
  batchId: string;
  itemId: string;
  now: Date;
  eventSender?: MaterialDraftItemEventSender;
}) {
  const env = getInngestEnvStatus();
  if (env.status === "missing-env" && !input.eventSender) {
    return { status: "not-queued" as const, message: env.message };
  }
  const prisma = getPrisma();
  const updated = await prisma.skillDraftBatchItem.updateMany({
    where: {
      id: input.itemId,
      batchId: input.batchId,
      userId: input.userId,
      status: SkillDraftBatchItemStatus.FAILED,
    },
    data: { status: SkillDraftBatchItemStatus.PLANNED, errorCode: null, errorMessage: null },
  });
  if (updated.count !== 1) {
    return { status: "not-found" as const, message: "Failed draft item was not found." };
  }
  try {
    await (input.eventSender ?? inngestMaterialDraftItemEventSender).sendMaterialDraftItemRequested({
      userId: input.userId,
      batchId: input.batchId,
      itemId: input.itemId,
      requestedAt: input.now.toISOString(),
    });
  } catch {
    await markMaterialDraftItemFailed({
      userId: input.userId,
      itemId: input.itemId,
      code: "EVENT_SEND_FAILED",
      message: "Draft generation could not be queued. Try again.",
    });
    return { status: "not-queued" as const, message: "Draft generation could not be queued." };
  }
  await reconcileMaterialDraftBatch({ userId: input.userId, batchId: input.batchId, now: input.now });
  return { status: "queued" as const };
}

export async function excludeMaterialDraftItem(input: {
  userId: string;
  batchId: string;
  itemId: string;
  now: Date;
}) {
  const prisma = getPrisma();
  const result = await prisma.$transaction(async (tx) => {
    const item = await tx.skillDraftBatchItem.findFirst({
      where: {
        id: input.itemId,
        batchId: input.batchId,
        userId: input.userId,
        status: { in: [SkillDraftBatchItemStatus.READY, SkillDraftBatchItemStatus.FAILED] },
      },
      select: { id: true, skillId: true },
    });
    if (!item) {
      return false;
    }
    if (item.skillId) {
      await tx.skill.deleteMany({
        where: { id: item.skillId, userId: input.userId, status: SkillStatus.DRAFT },
      });
    }
    await tx.skillDraftBatchItem.update({
      where: { id: item.id },
      data: {
        skillId: null,
        status: SkillDraftBatchItemStatus.EXCLUDED,
        errorCode: null,
        errorMessage: null,
      },
    });
    return true;
  });
  if (!result) {
    return { status: "not-found" as const };
  }
  await reconcileMaterialDraftBatch({ userId: input.userId, batchId: input.batchId, now: input.now });
  return { status: "excluded" as const };
}

export async function getMaterialDraftBatch(input: { userId: string; batchId: string }) {
  return getPrisma().skillDraftBatch.findFirst({
    where: { id: input.batchId, userId: input.userId },
    select: {
      id: true,
      instruction: true,
      proposedPlan: true,
      confirmedPlan: true,
      status: true,
      requestedCount: true,
      readyCount: true,
      failedCount: true,
      excludedCount: true,
      activatedCount: true,
      errorMessage: true,
      createdAt: true,
      updatedAt: true,
      confirmedAt: true,
      completedAt: true,
      materialRevision: {
        select: {
          id: true,
          revisionNumber: true,
          material: { select: { id: true, title: true, kind: true } },
        },
      },
      items: {
        orderBy: { ordinal: "asc" },
        select: {
          id: true,
          ordinal: true,
          targetKey: true,
          proposedTitle: true,
          proposedObjective: true,
          locator: true,
          status: true,
          overlapSkillId: true,
          errorCode: true,
          errorMessage: true,
          generationAttempts: true,
          generationMetadata: true,
          skill: {
            select: {
              id: true,
              title: true,
              objective: true,
              rules: true,
              examples: true,
              exerciseConstraints: true,
              tags: true,
              status: true,
            },
          },
        },
      },
    },
  });
}

export async function reconcileMaterialDraftBatch(input: {
  userId: string;
  batchId: string;
  now?: Date;
}) {
  const prisma = getPrisma();
  const items = await prisma.skillDraftBatchItem.findMany({
    where: { batchId: input.batchId, userId: input.userId },
    select: { status: true },
  });
  if (items.length === 0) {
    return null;
  }
  const summary = summarizeMaterialDraftBatch(items.map((item) => item.status));
  await prisma.skillDraftBatch.updateMany({
    where: { id: input.batchId, userId: input.userId },
    data: {
      status: SkillDraftBatchStatus[summary.status],
      readyCount: summary.readyCount,
      failedCount: summary.failedCount,
      excludedCount: summary.excludedCount,
      activatedCount: summary.activatedCount,
      completedAt: summary.terminal ? input.now ?? new Date() : null,
    },
  });
  return summary;
}

async function planExistingMaterialBatch(input: {
  userId: string;
  batchId: string;
  now: Date;
  aiSetup?: MaterialDraftAiSetup;
  embeddingGenerator?: MaterialEmbeddingGenerator | null;
}) {
  const prisma = getPrisma();
  const batch = await prisma.skillDraftBatch.findFirst({
    where: { id: input.batchId, userId: input.userId, confirmedAt: null },
    select: {
      id: true,
      instruction: true,
      materialRevisionId: true,
      materialRevision: {
        select: {
          status: true,
          material: { select: { id: true, title: true, kind: true } },
          sections: {
            orderBy: { ordinal: "asc" },
            select: {
              id: true,
              parentId: true,
              ordinal: true,
              level: true,
              title: true,
              pageStart: true,
              pageEnd: true,
              url: true,
              anchor: true,
            },
          },
        },
      },
    },
  });
  if (!batch || batch.materialRevision.status !== MaterialRevisionStatus.READY) {
    return { status: "not-found" as const, message: "Ready material batch was not found." };
  }
  const sections = batch.materialRevision.sections satisfies MaterialPlanningSection[];
  const structural = resolveStructuralMaterialScope({
    instruction: batch.instruction,
    sections,
  });
  if (structural.missingReferences.length > 0) {
    const plan = materialScopeResolutionSchema.parse({
      version: 1,
      materialRevisionId: batch.materialRevisionId,
      instruction: batch.instruction,
      resolutionStatus: "ambiguous",
      resolvedScopeLabel: "The requested chapter or section was not found in this revision.",
      warnings: [],
      clarification: `Check the material outline and clarify ${structural.missingReferences.join(
        " and ",
      )}.`,
      items: [],
    });
    await saveProposedMaterialPlan({
      batchId: batch.id,
      userId: input.userId,
      plan,
      model: null,
      structural,
      now: input.now,
    });
    return planResult(batch.id, plan);
  }
  if (structural.candidateSectionIds.length === 0) {
    const plan = materialScopeResolutionSchema.parse({
      version: 1,
      materialRevisionId: batch.materialRevisionId,
      instruction: batch.instruction,
      resolutionStatus: "ambiguous",
      resolvedScopeLabel: "This material does not have a usable outline yet.",
      warnings: [],
      clarification: "Wait for indexing to finish or choose a material with resolved sections.",
      items: [],
    });
    await saveProposedMaterialPlan({
      batchId: batch.id,
      userId: input.userId,
      plan,
      model: null,
      structural,
      now: input.now,
    });
    return planResult(batch.id, plan);
  }

  try {
    const chunks = await retrievePlanningChunks({
      userId: input.userId,
      materialRevisionId: batch.materialRevisionId,
      instruction: batch.instruction,
      sectionIds: structural.candidateSectionIds,
      embeddingGenerator: input.embeddingGenerator,
    });
    if (chunks.length === 0) {
      const plan = materialScopeResolutionSchema.parse({
        version: 1,
        materialRevisionId: batch.materialRevisionId,
        instruction: batch.instruction,
        resolutionStatus: "ambiguous",
        resolvedScopeLabel: "The requested scope has no indexed text yet.",
        warnings: [],
        clarification: "Choose another section or retry after scanned pages finish OCR.",
        items: [],
      });
      await saveProposedMaterialPlan({
        batchId: batch.id,
        userId: input.userId,
        plan,
        model: null,
        structural,
        now: input.now,
      });
      return planResult(batch.id, plan);
    }
    const ai = input.aiSetup ?? resolveMaterialDraftAiSetup();
    const allowedSections = sections.filter((section) =>
      structural.candidateSectionIds.includes(section.id),
    );
    const rawPlan = await ai.planScope({
      materialTitle: batch.materialRevision.material.title,
      materialKind: batch.materialRevision.material.kind,
      instruction: batch.instruction,
      structuralReferences: structural.references,
      sections: allowedSections,
      chunks,
    });
    const validation = validateMaterialScopePlannerResponse({
      materialRevisionId: batch.materialRevisionId,
      instruction: batch.instruction,
      kind: batch.materialRevision.material.kind,
      allowedSections,
      allowedChunks: chunks,
      rawResponse: rawPlan,
    });
    if (validation.status !== "ready") {
      await markMaterialBatchPlanningFailed({
        userId: input.userId,
        batchId: batch.id,
        code: validation.reason.toUpperCase().replaceAll("-", "_"),
        message: validation.message,
      });
      return { status: "failed" as const, batchId: batch.id, message: validation.message };
    }
    const existingSkills = await prisma.skill.findMany({
      where: {
        userId: input.userId,
        sourceRefs: {
          some: {
            sourceFile: {
              materialRevision: { materialId: batch.materialRevision.material.id },
            },
          },
        },
      },
      select: { id: true, title: true, objective: true },
    });
    const plan = annotateMaterialPlanOverlaps(validation.plan, existingSkills);
    await saveProposedMaterialPlan({
      batchId: batch.id,
      userId: input.userId,
      plan,
      model: ai.model,
      structural,
      now: input.now,
    });
    return planResult(batch.id, plan);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Material scope planning failed.";
    await markMaterialBatchPlanningFailed({
      userId: input.userId,
      batchId: batch.id,
      code: "PLANNING_FAILED",
      message,
    });
    return { status: "failed" as const, batchId: batch.id, message };
  }
}

async function retrievePlanningChunks(input: {
  userId: string;
  materialRevisionId: string;
  instruction: string;
  sectionIds: string[];
  embeddingGenerator?: MaterialEmbeddingGenerator | null;
}) {
  const prisma = getPrisma();
  let ranked: MaterialChunkSearchResult[] = [];
  const embeddingGenerator =
    input.embeddingGenerator === undefined
      ? safelyResolveEmbeddingGenerator()
      : input.embeddingGenerator;
  if (embeddingGenerator) {
    try {
      const [embedding] = await embeddingGenerator({
        texts: [input.instruction],
        titles: ["Material skill request"],
      });
      ranked = await searchMaterialChunks({
        userId: input.userId,
        materialRevisionId: input.materialRevisionId,
        embedding,
        query: input.instruction,
        materialSectionIds: input.sectionIds,
        limit: 48,
      });
    } catch (error) {
      console.warn("[materials] semantic scope retrieval unavailable", {
        materialRevisionId: input.materialRevisionId,
        error: error instanceof Error ? error.message : "Unknown retrieval error",
      });
    }
  }
  if (ranked.length === 0) {
    ranked = await searchMaterialChunksLexical({
      userId: input.userId,
      materialRevisionId: input.materialRevisionId,
      query: input.instruction,
      materialSectionIds: input.sectionIds,
      limit: 48,
    });
  }
  const firstBySection = await prisma.materialChunk.findMany({
    where: {
      userId: input.userId,
      materialRevisionId: input.materialRevisionId,
      materialSectionId: { in: input.sectionIds },
    },
    orderBy: [{ materialSectionId: "asc" }, { ordinal: "asc" }],
    select: {
      id: true,
      materialRevisionId: true,
      materialSectionId: true,
      sourceFileId: true,
      ordinal: true,
      text: true,
      tokenEstimate: true,
      locator: true,
      headingText: true,
    },
    take: 80,
  });
  return uniqueById([...ranked, ...firstBySection]).slice(0, PLANNING_CHUNK_LIMIT);
}

async function saveProposedMaterialPlan(input: {
  batchId: string;
  userId: string;
  plan: MaterialScopeResolution;
  model: string | null;
  structural: ReturnType<typeof resolveStructuralMaterialScope>;
  now: Date;
}) {
  await getPrisma().skillDraftBatch.updateMany({
    where: { id: input.batchId, userId: input.userId, confirmedAt: null },
    data: {
      proposedPlan: toInputJson(input.plan),
      planningMetadata: {
        model: input.model,
        structuralReferences: input.structural.references.map((reference) => reference.label),
        candidateSectionCount: input.structural.candidateSectionIds.length,
        plannedAt: input.now.toISOString(),
      },
      status:
        input.plan.resolutionStatus === "ambiguous"
          ? SkillDraftBatchStatus.NEEDS_SCOPE
          : SkillDraftBatchStatus.PLANNED,
      requestedCount: input.plan.items.length,
      errorCode: null,
      errorMessage: null,
    },
  });
}

async function markMaterialBatchPlanningFailed(input: {
  userId: string;
  batchId: string;
  code: string;
  message: string;
}) {
  await getPrisma().skillDraftBatch.updateMany({
    where: { id: input.batchId, userId: input.userId },
    data: {
      status: SkillDraftBatchStatus.FAILED,
      errorCode: input.code,
      errorMessage: input.message.slice(0, 1_000),
      completedAt: new Date(),
    },
  });
}

async function markMaterialDraftItemFailed(input: {
  userId: string;
  itemId: string;
  code: string;
  message: string;
  generationMetadata?: Prisma.InputJsonValue;
}) {
  await getPrisma().skillDraftBatchItem.updateMany({
    where: { id: input.itemId, userId: input.userId },
    data: {
      status: SkillDraftBatchItemStatus.FAILED,
      errorCode: input.code,
      errorMessage: input.message.slice(0, 1_000),
      ...(input.generationMetadata ? { generationMetadata: input.generationMetadata } : {}),
    },
  });
}

function planResult(batchId: string, plan: MaterialScopeResolution) {
  return {
    status: plan.resolutionStatus === "ambiguous" ? ("needs-scope" as const) : ("planned" as const),
    batchId,
    plan,
  };
}

function normalizeMaterialDraftError(error: unknown) {
  if (error instanceof MaterialDraftGenerationError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "Material draft generation failed.";
  const retryable = !/invalid|not found|unsupported|confirmed evidence/i.test(message);
  return new MaterialDraftGenerationError(message, { retryable, cause: error });
}

function safelyResolveEmbeddingGenerator() {
  try {
    return createGeminiMaterialEmbeddingGenerator();
  } catch {
    return null;
  }
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function normalizeComparableText(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function uniqueById<T extends { id: string }>(values: T[]) {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
