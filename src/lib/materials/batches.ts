import "server-only";

import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  GenerationJobKind,
  GenerationJobStatus,
  MaterialPageTextStatus,
  MaterialRevisionStatus,
  Prisma,
  SkillDraftBatchItemStatus,
  SkillDraftBatchStatus,
  SkillStatus,
  SourceFileStatus,
} from "@/generated/prisma/client";
import { getInngestEnvStatus } from "@/lib/inngest/client";
import {
  inngestMaterialBatchActivationEventSender,
  inngestMaterialDraftItemEventSender,
  type MaterialBatchActivationEventSender,
  type MaterialDraftItemEventSender,
} from "@/lib/inngest/events";
import {
  resolveMaterialDraftAiSetup,
  type MaterialDraftAiSetup,
} from "@/lib/materials/ai";
import {
  activateBatchInputSchema,
  batchItemMutationInputSchema,
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
  validateMaterialScopePlannerResponse,
  type MaterialPlanningSection,
} from "@/lib/materials/drafting";
import { summarizeMaterialDraftBatch } from "@/lib/materials/batch-summary";
import {
  createGeminiMaterialEmbeddingGenerator,
  type MaterialEmbeddingGenerator,
} from "@/lib/materials/embeddings";
import {
  ensureMaterialPageOcr,
  loadLocalizedMaterialEvidence,
  type MaterialOcrGenerator,
} from "@/lib/materials/evidence";
import { materialPageEvidenceId } from "@/lib/materials/evidence-ids";
import { createIdempotentDraftBatch } from "@/lib/materials/lifecycle";
import {
  searchMaterialChunks,
  searchMaterialChunksLexical,
  type MaterialChunkSearchResult,
} from "@/lib/materials/retrieval";
import { getPrisma } from "@/lib/prisma";
import type { SourceObjectStorage } from "@/lib/storage/s3";
import {
  activateSkillDraft,
  GEMINI_PROVIDER,
  REQUESTED_ACTIVATION_EXERCISES,
  SKILL_MCQ_PROMPT_VERSION,
  type ChoiceExerciseGenerator,
  type ChoiceExerciseVerifier,
  type SkillSourceEvidenceLoader,
  type SourceMediaContextLoader,
} from "@/lib/skills";
import { DEFAULT_GEMINI_MODEL } from "@/lib/gemini";
import {
  ALPHA_ACTIVE_SKILLS,
  ALPHA_SKILL_ACTIVATIONS_PER_DAY,
  startOfUtcDay,
} from "@/lib/usage-limits";

const PLANNING_CHUNK_LIMIT = 60;
const GENERATION_EVIDENCE_CHARACTER_LIMIT = 24_000;
// Keep this above the five-minute function ceiling so a slow but healthy model call
// is not surfaced as failed while its worker can still complete.
const MATERIAL_DRAFT_CLAIM_STALE_MS = 10 * 60 * 1_000;
const MATERIAL_BATCH_ACTIVATION_CLAIM_STALE_MS = 2 * 60 * 1_000;

export class MaterialDraftGenerationError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "MaterialDraftGenerationError";
    this.retryable = options.retryable;
  }
}

export class MaterialBatchActivationError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "MaterialBatchActivationError";
    this.retryable = options.retryable;
  }
}

class MaterialDraftClaimSupersededError extends Error {}

export async function planMaterialSkills(input: {
  userId: string;
  input: unknown;
  now: Date;
  aiSetup?: MaterialDraftAiSetup;
  embeddingGenerator?: MaterialEmbeddingGenerator | null;
  ocrGenerator?: MaterialOcrGenerator | null;
  ocrStorage?: SourceObjectStorage;
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
    ocrGenerator: input.ocrGenerator,
    ocrStorage: input.ocrStorage,
  });
}

export async function replanMaterialSkills(input: {
  userId: string;
  input: unknown;
  now: Date;
  aiSetup?: MaterialDraftAiSetup;
  embeddingGenerator?: MaterialEmbeddingGenerator | null;
  ocrGenerator?: MaterialOcrGenerator | null;
  ocrStorage?: SourceObjectStorage;
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
    ocrGenerator: input.ocrGenerator,
    ocrStorage: input.ocrStorage,
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
  const alreadyConfirmed = Boolean(batch.confirmedAt && batch.items.length > 0);
  const proposed = materialScopePlanSchema.safeParse(
    alreadyConfirmed ? batch.confirmedPlan ?? batch.proposedPlan : batch.proposedPlan,
  );
  if (!proposed.success || !isDeepStrictEqual(proposed.data, parsed.data.plan)) {
    return {
      status: "invalid" as const,
      message: "The submitted scope no longer matches the reviewed plan. Review it again.",
    };
  }
  const itemsToQueue = alreadyConfirmed
    ? batch.items.filter((item) => item.status === SkillDraftBatchItemStatus.PLANNED)
    : proposed.data.items.filter((item) => !item.overlapSkillId);
  if (itemsToQueue.length > 0) {
    const env = getInngestEnvStatus();
    if (env.status === "missing-env" && !input.eventSender) {
      return { status: "not-queued" as const, message: env.message };
    }
  }

  const confirmation = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM "skill_draft_batches"
      WHERE "id" = ${batch.id} AND "userId" = ${input.userId}
      FOR UPDATE
    `;
    const lockedBatch = await tx.skillDraftBatch.findFirst({
      where: { id: batch.id, userId: input.userId },
      include: { items: { orderBy: { ordinal: "asc" } } },
    });
    if (!lockedBatch) {
      return { status: "not-found" as const };
    }
    const lockedAlreadyConfirmed = Boolean(
      lockedBatch.confirmedAt && lockedBatch.items.length > 0,
    );
    const lockedPlan = materialScopePlanSchema.safeParse(
      lockedAlreadyConfirmed
        ? lockedBatch.confirmedPlan ?? lockedBatch.proposedPlan
        : lockedBatch.proposedPlan,
    );
    if (!lockedPlan.success || !isDeepStrictEqual(lockedPlan.data, parsed.data.plan)) {
      return { status: "invalid" as const };
    }
    if (lockedBatch.items.length > 0) {
      return {
        status: "ready" as const,
        items: lockedBatch.items,
        alreadyConfirmed: lockedAlreadyConfirmed,
      };
    }
    const rows = [];
    for (const [ordinal, item] of lockedPlan.data.items.entries()) {
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
        confirmedPlan: toInputJson(lockedPlan.data),
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
    return { status: "ready" as const, items: rows, alreadyConfirmed: false };
  });

  if (confirmation.status === "not-found") {
    return { status: "not-found" as const, message: "Material skill batch was not found." };
  }
  if (confirmation.status === "invalid") {
    return {
      status: "invalid" as const,
      message: "The submitted scope no longer matches the reviewed plan. Review it again.",
    };
  }
  const createdItems = confirmation.items;

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
    alreadyConfirmed: confirmation.alreadyConfirmed,
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
  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - MATERIAL_DRAFT_CLAIM_STALE_MS);
  const item = await prisma.skillDraftBatchItem.findFirst({
    where: { id: input.itemId, batchId: input.batchId, userId: input.userId },
    select: {
      id: true,
      status: true,
      updatedAt: true,
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
                select: {
                  id: true,
                  materialRevisionId: true,
                  kind: true,
                  status: true,
                  originalName: true,
                  mimeType: true,
                  storageBucket: true,
                  storageKey: true,
                },
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

  const claimId = randomUUID();
  const claimed = await prisma.skillDraftBatchItem.updateMany({
    where: {
      id: item.id,
      userId: input.userId,
      OR: [
        { status: SkillDraftBatchItemStatus.PLANNED },
        { status: SkillDraftBatchItemStatus.GENERATING, updatedAt: { lt: staleBefore } },
      ],
    },
    data: {
      status: SkillDraftBatchItemStatus.GENERATING,
      generationClaimId: claimId,
      errorCode: null,
      errorMessage: null,
    },
  });
  if (claimed.count !== 1) {
    if (
      item.status === SkillDraftBatchItemStatus.GENERATING &&
      item.updatedAt >= staleBefore
    ) {
      throw new MaterialDraftGenerationError("Draft generation is still running.", {
        retryable: true,
      });
    }
    return { status: "not-claimed" as const };
  }

  const locator = skillSourceLocatorSchema.safeParse(item.locator);
  const sourceFile = item.batch.materialRevision.sourceFiles[0];
  if (!locator.success || !sourceFile) {
    const marked = await markMaterialDraftItemFailed({
      userId: input.userId,
      itemId: item.id,
      claimId,
      code: "INVALID_CONFIRMED_SCOPE",
      message: "The confirmed material evidence is no longer available.",
    });
    if (!marked) {
      return { status: "not-claimed" as const };
    }
    await reconcileMaterialDraftBatch({ userId: input.userId, batchId: input.batchId, now });
    return { status: "failed" as const, reason: "invalid-scope" as const };
  }

  try {
    const localizedEvidence = await loadLocalizedMaterialEvidence({
      userId: input.userId,
      sourceRefs: [{ locator: locator.data, sourceFile }],
    });
    const evidenceText = localizedEvidence.sourceContext
      ?.slice(0, GENERATION_EVIDENCE_CHARACTER_LIMIT)
      .trim();
    if (!evidenceText) {
      throw new MaterialDraftGenerationError("Confirmed evidence chunks were not found.", {
        retryable: false,
      });
    }
    const ai = input.aiSetup ?? resolveMaterialDraftAiSetup();
    const generated = await generateVerifiedMaterialDraft({
      target: { title: item.proposedTitle, objective: item.proposedObjective },
      materialTitle: item.batch.materialRevision.material.title,
      evidenceText,
      sourceMedia: localizedEvidence.sourceMedia.map((media) => ({
        sourceFileId: media.sourceFileId,
        label: media.originalName,
        mimeType: "application/pdf" as const,
        bytes: media.bytes,
      })),
      generateDraft: async (draftInput) => {
        const attempt = await prisma.skillDraftBatchItem.updateMany({
          where: {
            id: item.id,
            userId: input.userId,
            status: SkillDraftBatchItemStatus.GENERATING,
            generationClaimId: claimId,
          },
          data: { generationAttempts: { increment: 1 } },
        });
        if (attempt.count !== 1) {
          throw new MaterialDraftClaimSupersededError();
        }
        return ai.generateDraft(draftInput);
      },
      verifyDraft: ai.verifyDraft,
    });
    if (generated.status === "failed") {
      const marked = await markMaterialDraftItemFailed({
        userId: input.userId,
        itemId: item.id,
        claimId,
        code: generated.reason.toUpperCase().replaceAll("-", "_"),
        message: generated.message,
        generationMetadata: {
          model: ai.model,
          verification: "rejected",
          attemptsThisRun: generated.attempts,
        },
      });
      if (!marked) {
        return { status: "not-claimed" as const };
      }
      await reconcileMaterialDraftBatch({ userId: input.userId, batchId: input.batchId, now });
      return { status: "failed" as const, reason: generated.reason };
    }

    const saved = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "id" FROM "skill_draft_batch_items"
        WHERE "id" = ${item.id} AND "userId" = ${input.userId}
        FOR UPDATE
      `;
      const activeClaim = await tx.skillDraftBatchItem.findFirst({
        where: {
          id: item.id,
          userId: input.userId,
          status: SkillDraftBatchItemStatus.GENERATING,
          generationClaimId: claimId,
        },
        select: { id: true },
      });
      if (!activeClaim) {
        return { status: "superseded" as const };
      }
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
            generationClaimId: null,
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
          generationClaimId: null,
          generationMetadata: {
            model: ai.model,
            verification: "verified",
            attemptsThisRun: generated.attempts,
          },
        },
      });
      await tx.studyMaterial.update({
        where: { id: item.batch.materialRevision.materialId },
        data: { lastUsedAt: now },
      });
      return { status: "created" as const, skillId: skill.id };
    });
    if (saved.status === "superseded") {
      return { status: "not-claimed" as const };
    }
    await reconcileMaterialDraftBatch({ userId: input.userId, batchId: input.batchId, now });
    return saved.status === "duplicate"
      ? { status: "excluded" as const, duplicateSkillId: saved.skillId }
      : { status: "ready" as const, skillId: saved.skillId, alreadyGenerated: false };
  } catch (error) {
    if (error instanceof MaterialDraftClaimSupersededError) {
      return { status: "not-claimed" as const };
    }
    const normalized = normalizeMaterialDraftError(error);
    const marked = await markMaterialDraftItemFailed({
      userId: input.userId,
      itemId: item.id,
      claimId,
      code: normalized.retryable ? "TRANSIENT_GENERATION_FAILURE" : "GENERATION_REJECTED",
      message: normalized.message,
    });
    if (!marked) {
      return { status: "not-claimed" as const };
    }
    await reconcileMaterialDraftBatch({ userId: input.userId, batchId: input.batchId, now });
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
      NOT: { errorCode: { startsWith: "ACTIVATION_" } },
    },
    data: {
      status: SkillDraftBatchItemStatus.PLANNED,
      generationClaimId: null,
      errorCode: null,
      errorMessage: null,
    },
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

export async function queueMaterialBatchActivation(input: {
  userId: string;
  input: unknown;
  now: Date;
  eventSender?: MaterialBatchActivationEventSender;
}) {
  const parsed = activateBatchInputSchema.safeParse(input.input);
  if (!parsed.success) {
    return {
      status: "invalid" as const,
      message: "Choose between one and ten ready skills to add.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const env = getInngestEnvStatus();
  if (env.status === "missing-env" && !input.eventSender) {
    return { status: "not-queued" as const, message: env.message };
  }
  const prisma = getPrisma();
  const reservation = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM "users"
      WHERE "id" = ${input.userId}
      FOR UPDATE
    `;
    const batch = await tx.skillDraftBatch.findFirst({
      where: { id: parsed.data.batchId, userId: input.userId, confirmedAt: { not: null } },
      select: { id: true },
    });
    if (!batch) {
      return { status: "not-found" as const, message: "Ready material batch was not found." };
    }
    const items = await tx.skillDraftBatchItem.findMany({
      where: {
        id: { in: parsed.data.itemIds },
        batchId: batch.id,
        userId: input.userId,
      },
      select: {
        id: true,
        status: true,
        skill: { select: { id: true, status: true } },
      },
    });
    if (items.length !== parsed.data.itemIds.length) {
      return {
        status: "invalid" as const,
        message: "Every selected item must still belong to this batch.",
      };
    }
    const readyItems = items.filter(
      (item) =>
        item.status === SkillDraftBatchItemStatus.READY &&
        item.skill?.status === SkillStatus.DRAFT,
    );
    const handledItems = items.filter(
      (item) =>
        (item.skill?.status === SkillStatus.ACTIVE &&
          (item.status === SkillDraftBatchItemStatus.READY ||
            item.status === SkillDraftBatchItemStatus.ACTIVATING ||
            item.status === SkillDraftBatchItemStatus.ACTIVE)) ||
        (item.status === SkillDraftBatchItemStatus.ACTIVATING &&
          item.skill?.status === SkillStatus.DRAFT),
    );
    if (readyItems.length + handledItems.length !== items.length) {
      return {
        status: "invalid" as const,
        message: "Every selected item must still be a ready draft in this batch.",
      };
    }
    if (readyItems.length === 0) {
      return {
        status: "already-queued" as const,
        batchId: batch.id,
        message: "These skills are already being added or are active.",
      };
    }
    const [activeSkillCount, pendingActivationCount, activationsToday] = await Promise.all([
      tx.skill.count({
        where: {
          userId: input.userId,
          status: { in: [SkillStatus.ACTIVE, SkillStatus.PAUSED] },
        },
      }),
      tx.skillDraftBatchItem.count({
        where: {
          userId: input.userId,
          status: SkillDraftBatchItemStatus.ACTIVATING,
          skill: { status: SkillStatus.DRAFT },
        },
      }),
      tx.generationJob.count({
        where: {
          userId: input.userId,
          kind: GenerationJobKind.SKILL_ACTIVATION,
          createdAt: { gte: startOfUtcDay(input.now) },
        },
      }),
    ]);
    if (activeSkillCount + pendingActivationCount + readyItems.length > ALPHA_ACTIVE_SKILLS) {
      return {
        status: "limited" as const,
        code: "active-skill-limit" as const,
        message: `Adding ${readyItems.length} skill${readyItems.length === 1 ? "" : "s"} would exceed the ${ALPHA_ACTIVE_SKILLS}-skill alpha limit, including skills already being added. Exclude some drafts or archive existing skills.`,
      };
    }
    if (activationsToday + readyItems.length > ALPHA_SKILL_ACTIVATIONS_PER_DAY) {
      const remaining = Math.max(0, ALPHA_SKILL_ACTIVATIONS_PER_DAY - activationsToday);
      return {
        status: "limited" as const,
        code: "daily-activation-limit" as const,
        message: `Only ${remaining} activation${remaining === 1 ? "" : "s"} remain today. Select fewer skills or try again after 00:00 UTC.`,
      };
    }

    const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
    const byId = new Map(readyItems.map((item) => [item.id, item]));
    const reservations = [];
    for (const itemId of parsed.data.itemIds) {
      const item = byId.get(itemId);
      if (!item) {
        continue;
      }
      if (!item.skill) {
        throw new Error("Selected activation skill disappeared while reserving quota.");
      }
      const generationJob = await tx.generationJob.create({
        data: {
          userId: input.userId,
          skillId: item.skill.id,
          kind: GenerationJobKind.SKILL_ACTIVATION,
          status: GenerationJobStatus.PENDING,
          provider: GEMINI_PROVIDER,
          model,
          promptVersion: SKILL_MCQ_PROMPT_VERSION,
          requestedCount: REQUESTED_ACTIVATION_EXERCISES,
          createdAt: input.now,
        },
        select: { id: true },
      });
      await tx.skillDraftBatchItem.update({
        where: { id: item.id },
        data: {
          status: SkillDraftBatchItemStatus.ACTIVATING,
          errorCode: null,
          errorMessage: null,
        },
      });
      reservations.push({ itemId: item.id, generationJobId: generationJob.id });
    }
    await tx.skillDraftBatch.update({
      where: { id: batch.id },
      data: {
        status: SkillDraftBatchStatus.ACTIVATING,
        completedAt: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    return { status: "reserved" as const, batchId: batch.id, reservations };
  });

  if (reservation.status !== "reserved") {
    return reservation;
  }
  const sender = input.eventSender ?? inngestMaterialBatchActivationEventSender;
  const payloads = reservation.reservations.map((item) => ({
    userId: input.userId,
    batchId: reservation.batchId,
    itemId: item.itemId,
    generationJobId: item.generationJobId,
    requestedAt: input.now.toISOString(),
  }));
  const sendResults = await Promise.allSettled(
    payloads.map((payload) => sender.sendMaterialBatchActivationRequested(payload)),
  );
  const failed = sendResults.flatMap((result, index) =>
    result.status === "rejected" ? [payloads[index]] : [],
  );
  if (failed.length > 0) {
    await prisma.$transaction(async (tx) => {
      await tx.generationJob.updateMany({
        where: {
          id: { in: failed.map((item) => item.generationJobId) },
          userId: input.userId,
          status: GenerationJobStatus.PENDING,
        },
        data: {
          status: GenerationJobStatus.FAILED,
          errorMessage: "Activation could not be queued.",
          completedAt: input.now,
        },
      });
      await tx.skillDraftBatchItem.updateMany({
        where: {
          id: { in: failed.map((item) => item.itemId) },
          userId: input.userId,
          status: SkillDraftBatchItemStatus.ACTIVATING,
        },
        data: {
          status: SkillDraftBatchItemStatus.FAILED,
          errorCode: "ACTIVATION_EVENT_SEND_FAILED",
          errorMessage: "Activation could not be queued. Retry this item.",
        },
      });
    });
    await reconcileMaterialDraftBatch({
      userId: input.userId,
      batchId: reservation.batchId,
      now: input.now,
    });
  }
  const failedItemIds = failed.map((item) => item.itemId);
  return {
    status: failed.length > 0 ? ("partial" as const) : ("queued" as const),
    batchId: reservation.batchId,
    queuedItemIds: payloads
      .map((payload) => payload.itemId)
      .filter((itemId) => !failedItemIds.includes(itemId)),
    failedItemIds,
  };
}

export async function runMaterialBatchActivationJob(input: {
  userId: string;
  batchId: string;
  itemId: string;
  generationJobId: string;
  requestedAt?: string;
  now?: Date;
  generateChoiceExercises?: ChoiceExerciseGenerator;
  verifyChoiceExercises?: ChoiceExerciseVerifier;
  sourceMediaLoader?: SourceMediaContextLoader;
  sourceEvidenceLoader?: SkillSourceEvidenceLoader;
  model?: string;
}) {
  const prisma = getPrisma();
  const now = input.now ?? new Date();
  const item = await prisma.skillDraftBatchItem.findFirst({
    where: { id: input.itemId, batchId: input.batchId, userId: input.userId },
    select: {
      id: true,
      status: true,
      errorCode: true,
      skill: { select: { id: true, status: true } },
    },
  });
  if (!item?.skill) {
    return { status: "not-found" as const };
  }
  if (item.status === SkillDraftBatchItemStatus.ACTIVE && item.skill.status === SkillStatus.ACTIVE) {
    return { status: "active" as const, alreadyActivated: true, skillId: item.skill.id };
  }
  if (item.skill.status === SkillStatus.ACTIVE) {
    await markMaterialBatchItemActive({
      userId: input.userId,
      batchId: input.batchId,
      itemId: item.id,
      now,
    });
    return { status: "active" as const, alreadyActivated: true, skillId: item.skill.id };
  }
  const slot = await claimMaterialBatchActivationSlot({
    userId: input.userId,
    batchId: input.batchId,
    itemId: item.id,
    generationJobId: input.generationJobId,
    now,
  });
  if (slot.status === "limited") {
    await reconcileMaterialDraftBatch({
      userId: input.userId,
      batchId: input.batchId,
      now,
    });
    throw new MaterialBatchActivationError(slot.message, { retryable: true });
  }
  if (slot.status !== "ready") {
    return { status: "not-claimed" as const };
  }

  let result: Awaited<ReturnType<typeof activateSkillDraft>>;
  try {
    result = await activateSkillDraft({
      userId: input.userId,
      skillId: slot.skillId,
      generationJobId: input.generationJobId,
      now,
      generateChoiceExercises: input.generateChoiceExercises,
      verifyChoiceExercises: input.verifyChoiceExercises,
      sourceMediaLoader: input.sourceMediaLoader,
      sourceEvidenceLoader: input.sourceEvidenceLoader,
      model: input.model,
      skipUsageLimitCheck: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Skill activation failed.";
    await prisma.generationJob.updateMany({
      where: {
        id: input.generationJobId,
        userId: input.userId,
        status: { in: [GenerationJobStatus.PENDING, GenerationJobStatus.RUNNING] },
      },
      data: {
        status: GenerationJobStatus.FAILED,
        errorMessage: message.slice(0, 1_000),
        completedAt: now,
      },
    });
    await markMaterialBatchActivationFailed({
      userId: input.userId,
      batchId: input.batchId,
      itemId: item.id,
      code: "ACTIVATION_RETRYABLE_UNEXPECTED_FAILURE",
      message,
      now,
    });
    throw new MaterialBatchActivationError(message, { retryable: true, cause: error });
  }
  if (result.status === "activated") {
    await markMaterialBatchItemActive({
      userId: input.userId,
      batchId: input.batchId,
      itemId: item.id,
      now,
    });
    return {
      status: "active" as const,
      alreadyActivated: false,
      skillId: result.skillId,
      exerciseCount: result.exerciseCount,
    };
  }
  const reason = result.reason.toUpperCase().replaceAll("-", "_");
  const retryable = [
    "generation-failed",
    "verification-failed",
    "activation-in-progress",
  ].includes(result.reason);
  await markMaterialBatchActivationFailed({
    userId: input.userId,
    batchId: input.batchId,
    itemId: item.id,
    code: `ACTIVATION_${retryable ? "RETRYABLE_" : ""}${reason}`,
    message: result.message,
    now,
  });
  if (retryable) {
    throw new MaterialBatchActivationError(result.message, { retryable: true });
  }
  return { status: "failed" as const, reason: result.reason, message: result.message };
}

async function claimMaterialBatchActivationSlot(input: {
  userId: string;
  batchId: string;
  itemId: string;
  generationJobId: string;
  now: Date;
}) {
  return getPrisma().$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM "users"
      WHERE "id" = ${input.userId}
      FOR UPDATE
    `;
    const item = await tx.skillDraftBatchItem.findFirst({
      where: { id: input.itemId, batchId: input.batchId, userId: input.userId },
      select: {
        id: true,
        status: true,
        errorCode: true,
        generationClaimId: true,
        updatedAt: true,
        skill: { select: { id: true, status: true } },
      },
    });
    if (!item?.skill || item.skill.status !== SkillStatus.DRAFT) {
      return { status: "not-claimed" as const };
    }
    const retryingTransientFailure =
      item.status === SkillDraftBatchItemStatus.FAILED &&
      item.errorCode?.startsWith("ACTIVATION_RETRYABLE_");
    if (item.status !== SkillDraftBatchItemStatus.ACTIVATING && !retryingTransientFailure) {
      return { status: "not-claimed" as const };
    }
    if (
      item.status === SkillDraftBatchItemStatus.ACTIVATING &&
      item.generationClaimId &&
      input.now.getTime() - item.updatedAt.getTime() < MATERIAL_BATCH_ACTIVATION_CLAIM_STALE_MS
    ) {
      return { status: "not-claimed" as const };
    }
    const job = await tx.generationJob.findFirst({
      where: {
        id: input.generationJobId,
        userId: input.userId,
        skillId: item.skill.id,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        status: {
          in: [
            GenerationJobStatus.PENDING,
            GenerationJobStatus.RUNNING,
            GenerationJobStatus.FAILED,
          ],
        },
      },
      select: { id: true, status: true, startedAt: true },
    });
    if (
      !job ||
      (job.status === GenerationJobStatus.RUNNING &&
        job.startedAt &&
        input.now.getTime() - job.startedAt.getTime() <
          MATERIAL_BATCH_ACTIVATION_CLAIM_STALE_MS)
    ) {
      return { status: "not-claimed" as const };
    }
    const [activeSkillCount, pendingActivationCount] = await Promise.all([
      tx.skill.count({
        where: {
          userId: input.userId,
          status: { in: [SkillStatus.ACTIVE, SkillStatus.PAUSED] },
        },
      }),
      tx.skillDraftBatchItem.count({
        where: {
          userId: input.userId,
          status: SkillDraftBatchItemStatus.ACTIVATING,
          skill: { status: SkillStatus.DRAFT },
        },
      }),
    ]);
    const projectedSkillCount =
      activeSkillCount + pendingActivationCount + (retryingTransientFailure ? 1 : 0);
    if (projectedSkillCount > ALPHA_ACTIVE_SKILLS) {
      if (item.status === SkillDraftBatchItemStatus.ACTIVATING) {
        await tx.skillDraftBatchItem.update({
          where: { id: item.id },
          data: {
            status: SkillDraftBatchItemStatus.FAILED,
            errorCode: "ACTIVATION_RETRYABLE_ACTIVE_SKILL_LIMIT",
            errorMessage: `Activation would exceed the ${ALPHA_ACTIVE_SKILLS}-skill alpha limit. Archive a skill and retry.`,
          },
        });
      }
      await tx.generationJob.update({
        where: { id: job.id },
        data: {
          status: GenerationJobStatus.FAILED,
          errorMessage: `Activation would exceed the ${ALPHA_ACTIVE_SKILLS}-skill alpha limit.`,
          completedAt: input.now,
        },
      });
      return {
        status: "limited" as const,
        message: `Activation would exceed the ${ALPHA_ACTIVE_SKILLS}-skill alpha limit. Archive a skill and retry.`,
      };
    }
    const claimId = randomUUID();
    await tx.skillDraftBatchItem.update({
      where: { id: item.id },
      data: {
        status: SkillDraftBatchItemStatus.ACTIVATING,
        generationClaimId: claimId,
        errorCode: null,
        errorMessage: null,
      },
    });
    return { status: "ready" as const, skillId: item.skill.id, claimId };
  });
}

export async function retryMaterialBatchActivationItem(input: {
  userId: string;
  batchId: string;
  itemId: string;
  now: Date;
  eventSender?: MaterialBatchActivationEventSender;
}) {
  const parsed = batchItemMutationInputSchema.safeParse({
    batchId: input.batchId,
    itemId: input.itemId,
  });
  if (!parsed.success) {
    return { status: "invalid" as const, message: "Activation item was invalid." };
  }
  const env = getInngestEnvStatus();
  if (env.status === "missing-env" && !input.eventSender) {
    return { status: "not-queued" as const, message: env.message };
  }
  const prisma = getPrisma();
  const retry = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT "id" FROM "users"
      WHERE "id" = ${input.userId}
      FOR UPDATE
    `;
    const item = await tx.skillDraftBatchItem.findFirst({
      where: {
        id: parsed.data.itemId,
        batchId: parsed.data.batchId,
        userId: input.userId,
        status: SkillDraftBatchItemStatus.FAILED,
        errorCode: { startsWith: "ACTIVATION_" },
      },
      select: { id: true, skill: { select: { id: true, status: true } } },
    });
    if (!item?.skill || item.skill.status !== SkillStatus.DRAFT) {
      return { status: "not-found" as const };
    }
    const job = await tx.generationJob.findFirst({
      where: {
        userId: input.userId,
        skillId: item.skill.id,
        kind: GenerationJobKind.SKILL_ACTIVATION,
        status: {
          in: [
            GenerationJobStatus.FAILED,
            GenerationJobStatus.PENDING,
            GenerationJobStatus.RUNNING,
          ],
        },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (!job) {
      return { status: "not-found" as const };
    }
    const [activeSkillCount, pendingActivationCount] = await Promise.all([
      tx.skill.count({
        where: {
          userId: input.userId,
          status: { in: [SkillStatus.ACTIVE, SkillStatus.PAUSED] },
        },
      }),
      tx.skillDraftBatchItem.count({
        where: {
          userId: input.userId,
          status: SkillDraftBatchItemStatus.ACTIVATING,
          skill: { status: SkillStatus.DRAFT },
        },
      }),
    ]);
    if (activeSkillCount + pendingActivationCount >= ALPHA_ACTIVE_SKILLS) {
      return {
        status: "limited" as const,
        message: `This retry would exceed the ${ALPHA_ACTIVE_SKILLS}-skill alpha limit, including skills already being added. Archive a skill or wait for an in-progress activation to finish.`,
      };
    }
    await tx.skillDraftBatchItem.update({
      where: { id: item.id },
      data: {
        status: SkillDraftBatchItemStatus.ACTIVATING,
        generationClaimId: null,
        errorCode: null,
        errorMessage: null,
      },
    });
    await tx.skillDraftBatch.update({
      where: { id: parsed.data.batchId },
      data: { status: SkillDraftBatchStatus.ACTIVATING, completedAt: null },
    });
    return { status: "reserved" as const, itemId: item.id, generationJobId: job.id };
  });
  if (retry.status === "not-found") {
    return { status: "not-found" as const, message: "Retryable activation was not found." };
  }
  if (retry.status === "limited") {
    return retry;
  }
  const payload = {
    userId: input.userId,
    batchId: parsed.data.batchId,
    itemId: retry.itemId,
    generationJobId: retry.generationJobId,
    requestedAt: input.now.toISOString(),
  };
  try {
    await (input.eventSender ?? inngestMaterialBatchActivationEventSender)
      .sendMaterialBatchActivationRequested(payload);
  } catch {
    await markMaterialBatchActivationFailed({
      userId: input.userId,
      batchId: parsed.data.batchId,
      itemId: retry.itemId,
      code: "ACTIVATION_EVENT_SEND_FAILED",
      message: "Activation could not be queued. Try again.",
      now: input.now,
    });
    return { status: "not-queued" as const, message: "Activation could not be queued." };
  }
  return {
    status: "queued" as const,
    itemId: retry.itemId,
    generationJobId: retry.generationJobId,
  };
}

async function markMaterialBatchItemActive(input: {
  userId: string;
  batchId: string;
  itemId: string;
  now: Date;
}) {
  await getPrisma().skillDraftBatchItem.updateMany({
    where: { id: input.itemId, batchId: input.batchId, userId: input.userId },
    data: {
      status: SkillDraftBatchItemStatus.ACTIVE,
      generationClaimId: null,
      errorCode: null,
      errorMessage: null,
    },
  });
  await reconcileMaterialDraftBatch(input);
}

async function markMaterialBatchActivationFailed(input: {
  userId: string;
  batchId: string;
  itemId: string;
  code: string;
  message: string;
  now: Date;
}) {
  await getPrisma().skillDraftBatchItem.updateMany({
    where: { id: input.itemId, batchId: input.batchId, userId: input.userId },
    data: {
      status: SkillDraftBatchItemStatus.FAILED,
      generationClaimId: null,
      errorCode: input.code,
      errorMessage: input.message.slice(0, 1_000),
    },
  });
  await reconcileMaterialDraftBatch(input);
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
      select: {
        id: true,
        skillId: true,
        skill: { select: { id: true, status: true } },
      },
    });
    if (!item) {
      return { status: "not-found" as const };
    }
    if (item.skillId) {
      const lockedSkills = await tx.$queryRaw<Array<{ status: SkillStatus }>>`
        SELECT "status" FROM "skills"
        WHERE "id" = ${item.skillId} AND "userId" = ${input.userId}
        FOR UPDATE
      `;
      if (
        !item.skill ||
        item.skill.status !== SkillStatus.DRAFT ||
        lockedSkills[0]?.status !== SkillStatus.DRAFT
      ) {
        return { status: "skill-not-draft" as const };
      }
      const activeActivation = await tx.generationJob.count({
        where: {
          userId: input.userId,
          skillId: item.skillId,
          kind: GenerationJobKind.SKILL_ACTIVATION,
          status: { in: [GenerationJobStatus.PENDING, GenerationJobStatus.RUNNING] },
        },
      });
      if (activeActivation > 0) {
        return { status: "activation-in-progress" as const };
      }
      const deletedSkill = await tx.skill.deleteMany({
        where: { id: item.skillId, userId: input.userId, status: SkillStatus.DRAFT },
      });
      if (deletedSkill.count !== 1) {
        return { status: "skill-not-draft" as const };
      }
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
    return { status: "excluded" as const };
  });
  if (result.status === "not-found") {
    return { status: "not-found" as const };
  }
  if (result.status === "skill-not-draft") {
    return {
      status: "not-excluded" as const,
      reason: "skill-not-draft" as const,
      message: "This skill is already active or changed outside the batch and cannot be excluded.",
    };
  }
  if (result.status === "activation-in-progress") {
    return {
      status: "not-excluded" as const,
      reason: "activation-in-progress" as const,
      message: "This skill is being activated and cannot be excluded until activation finishes.",
    };
  }
  await reconcileMaterialDraftBatch({ userId: input.userId, batchId: input.batchId, now: input.now });
  return { status: "excluded" as const };
}

export async function getMaterialDraftBatch(input: { userId: string; batchId: string }) {
  const prisma = getPrisma();
  const staleBefore = new Date(Date.now() - MATERIAL_DRAFT_CLAIM_STALE_MS);
  const recovered = await prisma.skillDraftBatchItem.updateMany({
    where: {
      batchId: input.batchId,
      userId: input.userId,
      status: SkillDraftBatchItemStatus.GENERATING,
      updatedAt: { lt: staleBefore },
    },
    data: {
      status: SkillDraftBatchItemStatus.FAILED,
      generationClaimId: null,
      errorCode: "STALE_GENERATION_CLAIM",
      errorMessage: "Draft generation stopped before it finished. Retry this item.",
    },
  });
  const synchronizedActive = await prisma.skillDraftBatchItem.updateMany({
    where: {
      batchId: input.batchId,
      userId: input.userId,
      status: {
        in: [
          SkillDraftBatchItemStatus.READY,
          SkillDraftBatchItemStatus.ACTIVATING,
          SkillDraftBatchItemStatus.FAILED,
        ],
      },
      skill: { status: SkillStatus.ACTIVE },
    },
    data: {
      status: SkillDraftBatchItemStatus.ACTIVE,
      errorCode: null,
      errorMessage: null,
    },
  });
  if (recovered.count > 0 || synchronizedActive.count > 0) {
    await reconcileMaterialDraftBatch({
      userId: input.userId,
      batchId: input.batchId,
      now: new Date(),
    });
  }

  return prisma.skillDraftBatch.findFirst({
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
  ocrGenerator?: MaterialOcrGenerator | null;
  ocrStorage?: SourceObjectStorage;
}) {
  const prisma = getPrisma();
  const batch = await prisma.skillDraftBatch.findFirst({
    where: { id: input.batchId, userId: input.userId, confirmedAt: null },
    select: {
      id: true,
      instruction: true,
      updatedAt: true,
      materialRevisionId: true,
      materialRevision: {
        select: {
          status: true,
          material: { select: { id: true, title: true, kind: true } },
          sourceFiles: {
            where: { status: SourceFileStatus.READY },
            orderBy: { createdAt: "asc" },
            take: 1,
            select: {
              id: true,
              materialRevisionId: true,
              kind: true,
              status: true,
              originalName: true,
              mimeType: true,
              storageBucket: true,
              storageKey: true,
            },
          },
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
    return saveProposedMaterialPlan({
      batchId: batch.id,
      userId: input.userId,
      plan,
      model: null,
      structural,
      now: input.now,
      expectedInstruction: batch.instruction,
      expectedUpdatedAt: batch.updatedAt,
    });
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
    return saveProposedMaterialPlan({
      batchId: batch.id,
      userId: input.userId,
      plan,
      model: null,
      structural,
      now: input.now,
      expectedInstruction: batch.instruction,
      expectedUpdatedAt: batch.updatedAt,
    });
  }

  try {
    const sourceFile = batch.materialRevision.sourceFiles[0];
    if (batch.materialRevision.material.kind === "PDF" && sourceFile) {
      const pageRanges = sections
        .filter((section) => structural.candidateSectionIds.includes(section.id))
        .flatMap((section) =>
          section.pageStart !== null && section.pageEnd !== null
            ? [{ start: section.pageStart, end: section.pageEnd }]
            : [],
        );
      if (pageRanges.length > 0) {
        await ensureMaterialPageOcr({
          userId: input.userId,
          materialRevisionId: batch.materialRevisionId,
          sourceFile,
          pageRanges,
          now: input.now,
          storage: input.ocrStorage,
          ocrGenerator: input.ocrGenerator,
        });
      }
    }
    const chunks = await retrievePlanningChunks({
      userId: input.userId,
      materialRevisionId: batch.materialRevisionId,
      instruction: batch.instruction,
      sectionIds: structural.candidateSectionIds,
      sections: sections.filter((section) =>
        structural.candidateSectionIds.includes(section.id),
      ),
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
      return saveProposedMaterialPlan({
        batchId: batch.id,
        userId: input.userId,
        plan,
        model: null,
        structural,
        now: input.now,
        expectedInstruction: batch.instruction,
        expectedUpdatedAt: batch.updatedAt,
      });
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
      const markedFailed = await markMaterialBatchPlanningFailed({
        userId: input.userId,
        batchId: batch.id,
        code: validation.reason.toUpperCase().replaceAll("-", "_"),
        message: validation.message,
        expectedInstruction: batch.instruction,
        expectedUpdatedAt: batch.updatedAt,
      });
      if (!markedFailed) {
        return readCurrentMaterialPlanningResult({
          userId: input.userId,
          batchId: batch.id,
        });
      }
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
    return saveProposedMaterialPlan({
      batchId: batch.id,
      userId: input.userId,
      plan,
      model: ai.model,
      structural,
      now: input.now,
      expectedInstruction: batch.instruction,
      expectedUpdatedAt: batch.updatedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Material scope planning failed.";
    const markedFailed = await markMaterialBatchPlanningFailed({
      userId: input.userId,
      batchId: batch.id,
      code: "PLANNING_FAILED",
      message,
      expectedInstruction: batch.instruction,
      expectedUpdatedAt: batch.updatedAt,
    });
    if (!markedFailed) {
      return readCurrentMaterialPlanningResult({
        userId: input.userId,
        batchId: batch.id,
      });
    }
    return { status: "failed" as const, batchId: batch.id, message };
  }
}

async function retrievePlanningChunks(input: {
  userId: string;
  materialRevisionId: string;
  instruction: string;
  sectionIds: string[];
  sections: MaterialPlanningSection[];
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
  const ocrChunks = await retrieveOcrPlanningChunks({
    userId: input.userId,
    materialRevisionId: input.materialRevisionId,
    instruction: input.instruction,
    sections: input.sections,
  });
  const matchedOcrChunks = ocrChunks.filter((chunk) => chunk.lexicalScore > 0);
  const reservedOcrChunks = uniqueById([...matchedOcrChunks, ...ocrChunks]).slice(0, 8);
  ranked = uniqueById([
    ...matchedOcrChunks,
    ...ranked.slice(0, Math.max(0, 48 - reservedOcrChunks.length)),
    ...reservedOcrChunks,
  ]).slice(0, 48);
  const firstBySection = await prisma.$queryRaw<MaterialChunkSearchResult[]>`
    WITH section_chunks AS (
      SELECT
        "id",
        "materialRevisionId",
        "materialSectionId",
        "sourceFileId",
        "ordinal",
        "text",
        "tokenEstimate",
        "locator",
        "headingText",
        ROW_NUMBER() OVER (
          PARTITION BY "materialSectionId"
          ORDER BY "ordinal" ASC
        ) AS "sectionRank"
      FROM "material_chunks"
      WHERE "userId" = ${input.userId}
        AND "materialRevisionId" = ${input.materialRevisionId}
        AND "materialSectionId" IN (${Prisma.join(input.sectionIds)})
    )
    SELECT
      "id",
      "materialRevisionId",
      "materialSectionId",
      "sourceFileId",
      "ordinal",
      "text",
      "tokenEstimate",
      "locator",
      "headingText",
      0::double precision AS "vectorScore",
      0::double precision AS "lexicalScore",
      0::double precision AS "score"
    FROM section_chunks
    WHERE "sectionRank" = 1
    ORDER BY array_position(
      ARRAY[${Prisma.join(input.sectionIds)}]::text[],
      "materialSectionId"
    )
    LIMIT ${PLANNING_CHUNK_LIMIT}
  `;
  const firstOcrBySection = uniqueBy(
    ocrChunks.filter((chunk) => chunk.materialSectionId !== null),
    (chunk) => chunk.materialSectionId,
  );
  const rankedChunks = uniqueById(ranked);
  const rankedSectionIds = new Set(
    rankedChunks.flatMap((chunk) =>
      chunk.materialSectionId ? [chunk.materialSectionId] : [],
    ),
  );
  const uncoveredSectionFallbacks = uniqueById([...firstBySection, ...firstOcrBySection]).filter(
    (chunk) =>
      chunk.materialSectionId !== null && !rankedSectionIds.has(chunk.materialSectionId),
  );
  const rankedMinimum = rankedChunks.length > 0 ? 1 : 0;
  const fallbackSlots = Math.min(
    uncoveredSectionFallbacks.length,
    PLANNING_CHUNK_LIMIT - rankedMinimum,
  );
  const rankedSlots = PLANNING_CHUNK_LIMIT - fallbackSlots;
  return uniqueById([
    ...rankedChunks.slice(0, rankedSlots),
    ...uncoveredSectionFallbacks.slice(0, fallbackSlots),
  ]);
}

async function retrieveOcrPlanningChunks(input: {
  userId: string;
  materialRevisionId: string;
  instruction: string;
  sections: MaterialPlanningSection[];
}): Promise<MaterialChunkSearchResult[]> {
  const boundedSections = input.sections.filter(
    (section) => section.pageStart !== null && section.pageEnd !== null,
  );
  if (boundedSections.length === 0) {
    return [];
  }
  const pages = await getPrisma().materialPage.findMany({
    where: {
      userId: input.userId,
      materialRevisionId: input.materialRevisionId,
      textStatus: MaterialPageTextStatus.OCR_READY,
      ocrText: { not: null },
      OR: boundedSections.map((section) => ({
        pageNumber: { gte: section.pageStart!, lte: section.pageEnd! },
      })),
    },
    orderBy: { pageNumber: "asc" },
    select: {
      id: true,
      pageNumber: true,
      ocrText: true,
      tokenEstimate: true,
    },
  });
  return pages.flatMap((page) => {
    if (!page.ocrText) {
      return [];
    }
    const section = boundedSections
      .filter(
        (candidate) =>
          candidate.pageStart! <= page.pageNumber && candidate.pageEnd! >= page.pageNumber,
      )
      .sort(
        (left, right) =>
          right.level - left.level ||
          left.pageEnd! - left.pageStart! - (right.pageEnd! - right.pageStart!) ||
          left.ordinal - right.ordinal,
      )[0];
    if (!section) {
      return [];
    }
    const lexicalScore = planningLexicalScore(input.instruction, page.ocrText);
    return [
      {
        id: materialPageEvidenceId(page.id),
        materialRevisionId: input.materialRevisionId,
        materialSectionId: section.id,
        sourceFileId: null,
        ordinal: page.pageNumber,
        text: page.ocrText,
        tokenEstimate: page.tokenEstimate,
        locator: {
          kind: "pdf",
          pageRange: { start: page.pageNumber, end: page.pageNumber },
        },
        headingText: `${section.title} · page ${page.pageNumber}`,
        vectorScore: 0,
        lexicalScore,
        score: lexicalScore,
      },
    ];
  });
}

function planningLexicalScore(query: string, text: string) {
  const terms = new Set(normalizeComparableText(query).split(" ").filter((term) => term.length > 1));
  if (terms.size === 0) {
    return 0;
  }
  const textTerms = new Set(normalizeComparableText(text).split(" "));
  return [...terms].filter((term) => textTerms.has(term)).length / terms.size;
}

async function saveProposedMaterialPlan(input: {
  batchId: string;
  userId: string;
  plan: MaterialScopeResolution;
  model: string | null;
  structural: ReturnType<typeof resolveStructuralMaterialScope>;
  now: Date;
  expectedInstruction: string;
  expectedUpdatedAt: Date;
}) {
  const updated = await getPrisma().skillDraftBatch.updateMany({
    where: {
      id: input.batchId,
      userId: input.userId,
      confirmedAt: null,
      status: SkillDraftBatchStatus.PLANNING,
      instruction: input.expectedInstruction,
      updatedAt: input.expectedUpdatedAt,
    },
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
  if (updated.count === 1) {
    return planResult(input.batchId, input.plan);
  }
  return readCurrentMaterialPlanningResult({
    userId: input.userId,
    batchId: input.batchId,
  });
}

async function markMaterialBatchPlanningFailed(input: {
  userId: string;
  batchId: string;
  code: string;
  message: string;
  expectedInstruction: string;
  expectedUpdatedAt: Date;
}) {
  const updated = await getPrisma().skillDraftBatch.updateMany({
    where: {
      id: input.batchId,
      userId: input.userId,
      confirmedAt: null,
      status: SkillDraftBatchStatus.PLANNING,
      instruction: input.expectedInstruction,
      updatedAt: input.expectedUpdatedAt,
    },
    data: {
      status: SkillDraftBatchStatus.FAILED,
      errorCode: input.code,
      errorMessage: input.message.slice(0, 1_000),
      completedAt: new Date(),
    },
  });
  return updated.count === 1;
}

async function readCurrentMaterialPlanningResult(input: {
  userId: string;
  batchId: string;
}) {
  const current = await getPrisma().skillDraftBatch.findFirst({
    where: { id: input.batchId, userId: input.userId },
    select: { proposedPlan: true, status: true, errorMessage: true },
  });
  if (!current) {
    return { status: "not-found" as const, message: "Material skill batch was not found." };
  }
  const plan = materialScopeResolutionSchema.safeParse(current.proposedPlan);
  if (plan.success) {
    return planResult(input.batchId, plan.data);
  }
  if (current.status === SkillDraftBatchStatus.FAILED) {
    return {
      status: "failed" as const,
      batchId: input.batchId,
      message: current.errorMessage ?? "Material scope planning failed.",
    };
  }
  return {
    status: "superseded" as const,
    batchId: input.batchId,
    message: "A newer scope request is still being planned. Refresh this batch shortly.",
  };
}

async function markMaterialDraftItemFailed(input: {
  userId: string;
  itemId: string;
  claimId?: string;
  code: string;
  message: string;
  generationMetadata?: Prisma.InputJsonValue;
}) {
  const updated = await getPrisma().skillDraftBatchItem.updateMany({
    where: {
      id: input.itemId,
      userId: input.userId,
      ...(input.claimId
        ? {
            status: SkillDraftBatchItemStatus.GENERATING,
            generationClaimId: input.claimId,
          }
        : {}),
    },
    data: {
      status: SkillDraftBatchItemStatus.FAILED,
      generationClaimId: null,
      errorCode: input.code,
      errorMessage: input.message.slice(0, 1_000),
      ...(input.generationMetadata ? { generationMetadata: input.generationMetadata } : {}),
    },
  });
  return updated.count === 1;
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

function uniqueBy<T, K>(values: T[], key: (value: T) => K) {
  return [...new Map(values.map((value) => [key(value), value])).values()];
}
