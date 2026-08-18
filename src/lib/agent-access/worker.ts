import "server-only";

import {
  AgentCandidateStatus,
  AgentOperationItemStatus,
  AgentOperationKind,
  AgentOperationStatus,
  GenerationJobKind,
  Prisma,
  SkillDraftBatchItemStatus,
  SkillStatus,
} from "@/generated/prisma/client";
import {
  createSkillDraft,
  createSkillDraftFromSource,
  activateSkillDraft,
  verifyUntrustedAgentExerciseCandidates,
} from "@/lib/skills";
import {
  buildSkillDuplicateCandidateFingerprint,
  findSimilarSkillsForUser,
  type SkillSimilarityMatch,
} from "@/lib/skills/similarity";
import { getPrisma } from "@/lib/prisma";
import {
  ALPHA_ACTIVE_SKILLS,
  ALPHA_SKILL_ACTIVATIONS_PER_DAY,
} from "@/lib/usage-limits";
import { reduceAgentOperationStatus } from "@/lib/agent-access/operations";
import { completeSourceUploadDrafts } from "@/lib/skills/uploads";
import {
  confirmMaterialPlan,
  planMaterialSkills,
  replanMaterialSkills,
  runMaterialDraftItemJob,
} from "@/lib/materials/batches";
import { buildAgentCandidateDuplicateKey } from "@/lib/agent-access/contracts";

const AGENT_OPERATION_INCLUDE = {
  items: { orderBy: { ordinal: "asc" as const }, include: { candidates: true } },
  sourceFile: true,
  sources: { orderBy: { ordinal: "asc" as const }, include: { sourceFile: true } },
  materialRevision: { select: { materialId: true, status: true } },
} satisfies Prisma.AgentSkillOperationInclude;

type AgentOperationWithItems = Prisma.AgentSkillOperationGetPayload<{
  include: typeof AGENT_OPERATION_INCLUDE;
}>;

export class AgentSkillWorkerError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message);
    this.name = "AgentSkillWorkerError";
  }
}

export function classifyAgentDuplicate(match: SkillSimilarityMatch | null) {
  if (!match) return { action: "create" as const, confidence: null };
  if (match.confidence === "exact") {
    return { action: "reuse" as const, confidence: match.confidence, skillId: match.skill.id };
  }
  return {
    action: "review" as const,
    confidence: match.confidence,
    skillId: match.skill.id,
  };
}

export async function runAgentSkillOperationJob(input: {
  userId: string;
  operationId: string;
  now?: Date;
}) {
  const prisma = getPrisma();
  const now = input.now ?? new Date();
  const operation = await prisma.agentSkillOperation.findFirst({
    where: { id: input.operationId, userId: input.userId },
    include: AGENT_OPERATION_INCLUDE,
  });
  if (!operation) return { status: "not-found" as const };
  if (
    operation.status === AgentOperationStatus.SUCCEEDED ||
    operation.status === AgentOperationStatus.PARTIAL ||
    operation.status === AgentOperationStatus.FAILED ||
    operation.status === AgentOperationStatus.CANCELED
  ) {
    return { status: "complete" as const, operationId: operation.id };
  }

  await prisma.agentSkillOperation.update({
    where: { id: operation.id },
    data: { startedAt: operation.startedAt ?? now },
  });

  try {
  if (operation.kind === AgentOperationKind.MATERIAL_BATCH) {
    await processMaterialOperation({ operation, now });
    await reconcileAgentOperation(operation.id, input.userId, now);
    return { status: "processed" as const, operationId: operation.id };
  }

  if (operation.kind === AgentOperationKind.QUICK_FILES) {
    await processFileOperation({ operation, now });
  } else if (operation.kind === AgentOperationKind.TEXT_SOURCE) {
    await processTextOperation({ operation, now });
  } else {
    const candidates = operation.items.flatMap((item) => {
      const snapshot = parseSkillSnapshot(item.skillSnapshot);
      return snapshot ? [{ key: item.id, title: snapshot.title, objective: snapshot.objective }] : [];
    });
    const similarities = await findSimilarSkillsForUser({
      userId: input.userId,
      candidates,
      limitPerCandidate: 3,
    });
    const byItem = new Map(similarities.candidates.map((candidate) => [candidate.key, candidate]));
    for (const item of operation.items) {
      if (item.status !== AgentOperationItemStatus.QUEUED) continue;
      if (item.createdSkillId) {
        const reserved = await reserveAgentActivation(input.userId, item.id, now);
        if (!reserved) {
          await failItem(item.id, input.userId, "QUOTA_EXCEEDED", now);
          continue;
        }
        await activateCreatedDraft(input.userId, item.id, item.createdSkillId, now);
        continue;
      }
      const snapshot = parseSkillSnapshot(item.skillSnapshot);
      if (!snapshot) {
        await failItem(item.id, input.userId, "INVALID_SKILL_SNAPSHOT", now);
        continue;
      }
      const duplicate = classifyAgentDuplicate(byItem.get(item.id)?.bestMatch ?? null);
      if (duplicate.action === "reuse") {
        await prisma.agentSkillOperationItem.update({
          where: { id: item.id },
          data: {
            status: AgentOperationItemStatus.REUSED,
            resultSkillId: duplicate.skillId,
            duplicateConfidence: duplicate.confidence,
            duplicateLibraryFingerprint: similarities.duplicateLibraryFingerprint,
            completedAt: now,
          },
        });
        continue;
      }
      if (duplicate.action === "review" && !item.duplicateOverrideApprovedAt) {
        await prisma.agentSkillOperationItem.update({
          where: { id: item.id },
          data: {
            status: AgentOperationItemStatus.NEEDS_REVIEW,
            resultSkillId: duplicate.skillId,
            duplicateConfidence: duplicate.confidence,
            duplicateLibraryFingerprint: similarities.duplicateLibraryFingerprint,
          },
        });
        continue;
      }
      await createAndActivateItem({ userId: input.userId, itemId: item.id, snapshot, now });
    }
  }

  await reconcileAgentOperation(operation.id, input.userId, now);
  return { status: "processed" as const, operationId: operation.id };
  } catch (error) {
    await prisma.agentSkillOperationItem.updateMany({
      where: {
        operationId: operation.id,
        userId: input.userId,
        status: {
          in: [
            AgentOperationItemStatus.GENERATING,
            AgentOperationItemStatus.VERIFYING,
            AgentOperationItemStatus.ACTIVATING,
          ],
        },
      },
      data: {
        status: AgentOperationItemStatus.QUEUED,
        activationReservedAt: null,
        errorCode: "TRANSIENT_WORKER_FAILURE",
      },
    });
    throw new AgentSkillWorkerError(
      error instanceof Error ? error.message : "Agent skill processing failed.",
      true,
    );
  }
}

async function processMaterialOperation(input: {
  operation: AgentOperationWithItems;
  now: Date;
}) {
  const prisma = getPrisma();
  const payload = parseRecord(input.operation.requestPayload);
  const instruction = typeof payload.instruction === "string" ? payload.instruction : "";
  const maxSkills =
    typeof payload.maxSkills === "number" && Number.isInteger(payload.maxSkills)
      ? Math.min(10, Math.max(1, payload.maxSkills))
      : 10;
  const sectionIds = stringArray(payload.sectionIds);
  const materialId = input.operation.materialRevision?.materialId;
  if (!materialId || !input.operation.materialRevisionId || !instruction) {
    await prisma.agentSkillOperation.update({
      where: { id: input.operation.id },
      data: { status: AgentOperationStatus.FAILED, errorCode: "INVALID_MATERIAL_REQUEST", completedAt: input.now },
    });
    return;
  }
  const sectionTitles = sectionIds.length
    ? await prisma.materialSection.findMany({
        where: {
          id: { in: sectionIds },
          userId: input.operation.userId,
          materialRevisionId: input.operation.materialRevisionId,
        },
        orderBy: { ordinal: "asc" },
        select: { title: true },
      })
    : [];
  if (sectionTitles.length !== sectionIds.length) {
    await prisma.agentSkillOperation.update({
      where: { id: input.operation.id },
      data: { status: AgentOperationStatus.FAILED, errorCode: "MATERIAL_SECTION_NOT_FOUND", completedAt: input.now },
    });
    return;
  }
  const planningInstruction = boundedMaterialInstruction(
    instruction,
    maxSkills,
    sectionTitles.map((section) => section.title),
  );

  let batchId = typeof payload.materialBatchId === "string" ? payload.materialBatchId : null;
  if (input.operation.items.length === 0) {
    let planning;
    if (batchId) {
      planning = await replanMaterialSkills({
      userId: input.operation.userId,
      now: input.now,
      input: { batchId, instruction: planningInstruction },
    });
    } else {
      planning = await planMaterialSkills({
      userId: input.operation.userId,
      now: input.now,
      input: {
        materialId,
        materialRevisionId: input.operation.materialRevisionId,
        instruction: planningInstruction,
        idempotencyKey: `agent-${input.operation.id}`,
      },
    });
    }
    if (planning.status === "needs-scope") {
    await prisma.agentSkillOperation.update({
      where: { id: input.operation.id },
      data: {
        status: AgentOperationStatus.NEEDS_INPUT,
        requestPayload: toJson({ ...payload, materialBatchId: planning.batchId }),
        errorCode: "MATERIAL_SCOPE_NEEDS_INPUT",
        errorMessage: "Clarify the chapters, sections, or concepts to cover.",
      },
    });
      return;
    }
    if (planning.status !== "planned") {
    await prisma.agentSkillOperation.update({
      where: { id: input.operation.id },
      data: {
        status: AgentOperationStatus.FAILED,
        errorCode: planning.status === "not-found" ? "MATERIAL_NOT_FOUND" : "MATERIAL_PLANNING_FAILED",
        errorMessage:
          "message" in planning ? planning.message : "Material planning could not finish.",
        completedAt: input.now,
      },
    });
      return;
    }
    batchId = planning.batchId;
    if (planning.plan.items.length > maxSkills) {
    await prisma.agentSkillOperation.update({
      where: { id: input.operation.id },
      data: {
        status: AgentOperationStatus.NEEDS_INPUT,
        requestPayload: toJson({ ...payload, materialBatchId: batchId }),
        errorCode: "MATERIAL_PLAN_TOO_BROAD",
        errorMessage: `Clarify a narrower scope that yields no more than ${maxSkills} skills.`,
      },
    });
      return;
    }
    const confirmed = await confirmMaterialPlan({
    userId: input.operation.userId,
    now: input.now,
    input: { batchId, plan: planning.plan },
    eventSender: { async sendMaterialDraftItemRequested() { return; } },
  });
    if (confirmed.status !== "queued" && confirmed.status !== "partial") {
    await prisma.agentSkillOperation.update({
      where: { id: input.operation.id },
      data: {
        status: AgentOperationStatus.FAILED,
        errorCode: "MATERIAL_CONFIRMATION_FAILED",
        errorMessage:
          "message" in confirmed ? confirmed.message : "The material plan could not be confirmed.",
        completedAt: input.now,
      },
    });
      return;
    }
  }

  if (!batchId) {
    await prisma.agentSkillOperation.update({
      where: { id: input.operation.id },
      data: {
        status: AgentOperationStatus.FAILED,
        errorCode: "MATERIAL_BATCH_NOT_FOUND",
        completedAt: input.now,
      },
    });
    return;
  }
  const materialItems = await prisma.skillDraftBatchItem.findMany({
    where: { batchId, userId: input.operation.userId },
    orderBy: { ordinal: "asc" },
    select: {
      id: true,
      ordinal: true,
      status: true,
      proposedTitle: true,
      proposedObjective: true,
      overlapSkillId: true,
    },
  });
  if (input.operation.items.length === 0) {
    await prisma.agentSkillOperation.update({
      where: { id: input.operation.id },
      data: {
        requestedCount: materialItems.length,
        requestPayload: toJson({ ...payload, materialBatchId: batchId }),
        items: {
          create: materialItems.map((item) => ({
            ordinal: item.ordinal,
            clientReference: `material-${item.ordinal + 1}`,
            proposedTitle: item.proposedTitle,
            proposedObjective: item.proposedObjective,
            status: item.overlapSkillId
              ? AgentOperationItemStatus.REUSED
              : AgentOperationItemStatus.QUEUED,
            resultSkillId: item.overlapSkillId,
            duplicateConfidence: item.overlapSkillId ? "exact" : null,
            completedAt: item.overlapSkillId ? input.now : null,
          })),
        },
      },
    });
  }
  const agentItems = await prisma.agentSkillOperationItem.findMany({
    where: { operationId: input.operation.id, userId: input.operation.userId },
    orderBy: { ordinal: "asc" },
  });
  const materialByOrdinal = new Map(materialItems.map((item) => [item.ordinal, item]));
  for (const agentItem of agentItems) {
    if (agentItem.status !== AgentOperationItemStatus.QUEUED) continue;
    if (agentItem.createdSkillId) {
      const reserved = await reserveAgentActivation(input.operation.userId, agentItem.id, input.now);
      if (!reserved) {
        await failItem(agentItem.id, input.operation.userId, "QUOTA_EXCEEDED", input.now);
        continue;
      }
      await activateCreatedDraft(input.operation.userId, agentItem.id, agentItem.createdSkillId, input.now);
      continue;
    }
    const materialItem = materialByOrdinal.get(agentItem.ordinal);
    if (!materialItem || materialItem.status !== SkillDraftBatchItemStatus.PLANNED) {
      await failItem(agentItem.id, input.operation.userId, "MATERIAL_ITEM_NOT_READY", input.now);
      continue;
    }
    const reserved = await reserveAgentActivation(input.operation.userId, agentItem.id, input.now);
    if (!reserved) {
      await failItem(agentItem.id, input.operation.userId, "QUOTA_EXCEEDED", input.now);
      continue;
    }
    await prisma.agentSkillOperationItem.update({
      where: { id: agentItem.id },
      data: { status: AgentOperationItemStatus.GENERATING, startedAt: input.now },
    });
    let generated;
    try {
      generated = await runMaterialDraftItemJob({
        userId: input.operation.userId,
        batchId,
        itemId: materialItem.id,
        now: input.now,
      });
    } catch (error) {
      await prisma.agentSkillOperationItem.updateMany({
        where: { id: agentItem.id, userId: input.operation.userId },
        data: { status: AgentOperationItemStatus.QUEUED, activationReservedAt: null },
      });
      throw error;
    }
    if (generated.status === "excluded") {
      await prisma.agentSkillOperationItem.update({
        where: { id: agentItem.id },
        data: {
          status: AgentOperationItemStatus.REUSED,
          resultSkillId: generated.duplicateSkillId,
          duplicateConfidence: "exact",
          activationReservedAt: null,
          completedAt: input.now,
        },
      });
      continue;
    }
    if (generated.status !== "ready" || !generated.skillId) {
      await failItem(agentItem.id, input.operation.userId, "MATERIAL_DRAFT_FAILED", input.now);
      continue;
    }
    const skill = await prisma.skill.findFirst({
      where: { id: generated.skillId, userId: input.operation.userId, status: SkillStatus.DRAFT },
    });
    if (!skill) {
      await failItem(agentItem.id, input.operation.userId, "DRAFT_NOT_FOUND", input.now);
      continue;
    }
    await prisma.agentSkillOperationItem.update({
      where: { id: agentItem.id },
      data: {
        createdSkillId: skill.id,
        candidateFingerprint: buildSkillDuplicateCandidateFingerprint(skill),
        proposedTitle: skill.title,
        proposedObjective: skill.objective,
        skillSnapshot: toJson({
          title: skill.title,
          objective: skill.objective ?? "",
          rules: skill.rules,
          examples: skill.examples,
          exerciseConstraints: skill.exerciseConstraints,
          tags: skill.tags,
        }),
      },
    });
    await activateCreatedDraft(input.operation.userId, agentItem.id, skill.id, input.now);
  }
}

function boundedMaterialInstruction(
  instruction: string,
  maxSkills: number,
  sectionTitles: readonly string[],
) {
  const constraints = [
    `Create no more than ${maxSkills} distinct skills.`,
    ...(sectionTitles.length
      ? [`Use only these selected sections: ${sectionTitles.join("; ")}.`]
      : []),
  ].join(" ").slice(0, 1_800);
  const instructionLimit = Math.max(3, 3_998 - constraints.length);
  return `${instruction.slice(0, instructionLimit)}\n\n${constraints}`;
}

async function processFileOperation(input: {
  operation: AgentOperationWithItems;
  now: Date;
}) {
  const item = input.operation.items[0];
  const sourceFileIds = input.operation.sources.map((source) => source.sourceFileId);
  if (!item || sourceFileIds.length === 0) {
    if (item) await failItem(item.id, input.operation.userId, "SOURCE_NOT_READY", input.now);
    return;
  }
  if (item.status !== AgentOperationItemStatus.QUEUED) return;
  if (item.createdSkillId) {
    const reserved = await reserveAgentActivation(input.operation.userId, item.id, input.now);
    if (!reserved) {
      await failItem(item.id, input.operation.userId, "QUOTA_EXCEEDED", input.now);
      return;
    }
    await activateCreatedDraft(input.operation.userId, item.id, item.createdSkillId, input.now);
    return;
  }
  const reserved = await reserveAgentActivation(input.operation.userId, item.id, input.now);
  if (!reserved) {
    await failItem(item.id, input.operation.userId, "QUOTA_EXCEEDED", input.now);
    return;
  }
  await getPrisma().agentSkillOperationItem.update({
    where: { id: item.id },
    data: { status: AgentOperationItemStatus.GENERATING, startedAt: input.now },
  });
  const result = await completeSourceUploadDrafts({
    userId: input.operation.userId,
    sourceFileId: sourceFileIds[0],
    sourceFileIds,
    now: input.now,
  });
  if (result.status !== "created" || !result.skills[0]) {
    const code = result.status === "not-created" ? result.reason : "SOURCE_NOT_FOUND";
    await failItem(item.id, input.operation.userId, code, input.now);
    return;
  }
  const generated = result.skills[0];
  await getPrisma().agentSkillOperationItem.update({
    where: { id: item.id },
    data: {
      createdSkillId: generated.id,
      candidateFingerprint: buildSkillDuplicateCandidateFingerprint(generated),
      proposedTitle: generated.title,
      proposedObjective: generated.objective,
      skillSnapshot: toJson({
        title: generated.title,
        objective: generated.objective ?? "",
        rules: generated.rules,
        examples: generated.examples,
        exerciseConstraints: generated.exerciseConstraints,
        tags: generated.tags,
      }),
    },
  });
  await activateCreatedDraft(input.operation.userId, item.id, generated.id, input.now);
}

async function processTextOperation(input: {
  operation: AgentOperationWithItems;
  now: Date;
}) {
  const item = input.operation.items[0];
  const source = input.operation.sourceFile;
  if (!item || !source?.extractedText) {
    if (item) await failItem(item.id, input.operation.userId, "SOURCE_NOT_READY", input.now);
    return;
  }
  if (item.status !== AgentOperationItemStatus.QUEUED) return;
  const payload = parseRecord(input.operation.requestPayload);
  await getPrisma().agentSkillOperationItem.update({
    where: { id: item.id },
    data: { status: AgentOperationItemStatus.GENERATING, startedAt: input.now },
  });
  const result = await createSkillDraftFromSource({
    userId: input.operation.userId,
    now: input.now,
    recoveredSourceFileId: source.id,
    skipUsageLimitCheck: true,
    persistFailedSource: false,
    input: {
      sourceText: source.extractedText,
      sourceLabel: source.originalName,
      focusNote: typeof payload.intent === "string" ? payload.intent : null,
      collectionName: typeof payload.collection === "string" ? payload.collection : null,
      tags: Array.isArray(payload.tags) ? payload.tags : [],
    },
  });
  if (result.status !== "created" || !result.skills[0]) {
    await failItem(item.id, input.operation.userId, result.status === "not-created" ? result.reason : "DRAFT_GENERATION_FAILED", input.now);
    return;
  }
  const generated = result.skills[0];
  await getPrisma().agentSkillOperationItem.update({
    where: { id: item.id },
    data: {
      createdSkillId: generated.id,
      candidateFingerprint: buildSkillDuplicateCandidateFingerprint(generated),
      proposedTitle: generated.title,
      proposedObjective: generated.objective,
      skillSnapshot: toJson({
        title: generated.title,
        objective: generated.objective ?? "",
        rules: generated.rules,
        examples: generated.examples,
        exerciseConstraints: generated.exerciseConstraints,
        tags: generated.tags,
      }),
    },
  });
  const similar = await findSimilarSkillsForUser({
    userId: input.operation.userId,
    candidates: [{ key: item.id, skillId: generated.id, title: generated.title, objective: generated.objective }],
    limitPerCandidate: 3,
  });
  const duplicate = classifyAgentDuplicate(similar.candidates[0]?.bestMatch ?? null);
  if (duplicate.action !== "create") {
    await getPrisma().agentSkillOperationItem.update({
      where: { id: item.id },
      data: {
        status: duplicate.action === "reuse" ? AgentOperationItemStatus.REUSED : AgentOperationItemStatus.NEEDS_REVIEW,
        resultSkillId: duplicate.skillId,
        duplicateConfidence: duplicate.confidence,
        duplicateLibraryFingerprint: similar.duplicateLibraryFingerprint,
        completedAt: duplicate.action === "reuse" ? input.now : null,
      },
    });
    return;
  }
  const reserved = await reserveAgentActivation(
    input.operation.userId,
    item.id,
    input.now,
  );
  if (!reserved) {
    await failItem(item.id, input.operation.userId, "QUOTA_EXCEEDED", input.now);
    return;
  }
  await activateCreatedDraft(input.operation.userId, item.id, generated.id, input.now);
}

async function createAndActivateItem(input: {
  userId: string;
  itemId: string;
  snapshot: SkillSnapshot;
  now: Date;
}) {
  const reserved = await reserveAgentActivation(input.userId, input.itemId, input.now);
  if (!reserved) {
    await failItem(input.itemId, input.userId, "QUOTA_EXCEEDED", input.now);
    return;
  }
  await getPrisma().agentSkillOperationItem.update({
    where: { id: input.itemId },
    data: { status: AgentOperationItemStatus.GENERATING, startedAt: input.now },
  });
  const draft = await createSkillDraft({
    userId: input.userId,
    input: buildSkillDraftInputFromSnapshot(input.snapshot),
  });
  if (draft.status !== "created") {
    await failItem(input.itemId, input.userId, "DRAFT_CREATE_FAILED", input.now);
    return;
  }
  await getPrisma().agentSkillOperationItem.update({
    where: { id: input.itemId },
    data: {
      createdSkillId: draft.skill.id,
      candidateFingerprint: buildSkillDuplicateCandidateFingerprint(draft.skill),
    },
  });
  await activateCreatedDraft(input.userId, input.itemId, draft.skill.id, input.now);
}

async function activateCreatedDraft(userId: string, itemId: string, skillId: string, now: Date) {
  const prisma = getPrisma();
  const draft = await prisma.skill.findFirst({
    where: { id: skillId, userId, status: SkillStatus.DRAFT },
    select: { id: true, title: true, objective: true },
  });
  if (!draft) {
    await failItem(itemId, userId, "DRAFT_NOT_FOUND", now);
    return;
  }
  const duplicateResult = await findSimilarSkillsForUser({
    userId,
    candidates: [{ key: itemId, skillId, title: draft.title, objective: draft.objective }],
    limitPerCandidate: 3,
  });
  const duplicate = classifyAgentDuplicate(duplicateResult.candidates[0]?.bestMatch ?? null);
  const reviewItem = await prisma.agentSkillOperationItem.findFirst({
    where: { id: itemId, userId },
    select: { duplicateOverrideApprovedAt: true },
  });
  const shouldStopForDuplicate =
    duplicate.action === "reuse" ||
    (duplicate.action === "review" && !reviewItem?.duplicateOverrideApprovedAt);
  if (shouldStopForDuplicate) {
    await prisma.agentSkillOperationItem.update({
      where: { id: itemId },
      data: {
        status: duplicate.action === "reuse" ? AgentOperationItemStatus.REUSED : AgentOperationItemStatus.NEEDS_REVIEW,
        resultSkillId: duplicate.skillId,
        duplicateConfidence: duplicate.confidence,
        duplicateLibraryFingerprint: duplicateResult.duplicateLibraryFingerprint,
        activationReservedAt: null,
        completedAt: duplicate.action === "reuse" ? now : null,
      },
    });
    if (duplicate.action === "reuse") {
      await prisma.skill.deleteMany({ where: { id: skillId, userId, status: SkillStatus.DRAFT } });
    }
    return;
  }
  await prisma.agentSkillOperationItem.update({
    where: { id: itemId },
    data: { duplicateLibraryFingerprint: duplicateResult.duplicateLibraryFingerprint },
  });
  const operationItem = await prisma.agentSkillOperationItem.findFirst({
    where: { id: itemId, userId, createdSkillId: skillId },
    select: { candidateFingerprint: true, duplicateLibraryFingerprint: true },
  });
  await prisma.agentSkillOperationItem.update({
    where: { id: itemId },
    data: { status: AgentOperationItemStatus.VERIFYING },
  });
  const candidates = await prisma.agentExerciseCandidate.findMany({
    where: { operationItemId: itemId, userId, status: AgentCandidateStatus.VALIDATED },
    orderBy: { ordinal: "asc" },
    select: { id: true, normalizedPayload: true },
  });
  const seen = new Set<string>();
  const uniqueCandidates = candidates.filter((candidate) => {
    const key = buildAgentCandidateDuplicateKey(candidate.normalizedPayload);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const duplicateIds = candidates
    .filter((candidate) => !uniqueCandidates.some((unique) => unique.id === candidate.id))
    .map((candidate) => candidate.id);
  if (duplicateIds.length) {
    await prisma.agentExerciseCandidate.updateMany({
      where: { id: { in: duplicateIds }, userId, operationItemId: itemId },
      data: { status: AgentCandidateStatus.REJECTED, verifierReason: "DUPLICATE" },
    });
  }
  if (uniqueCandidates.length) {
    const verification = await verifyUntrustedAgentExerciseCandidates({
      userId,
      skillId,
      now,
      candidates: uniqueCandidates.map((candidate) => ({
        candidateId: parseRecord(candidate.normalizedPayload).candidateId as string,
        normalizedPayload: candidate.normalizedPayload,
      })),
    });
    if (verification.status === "verified") {
      for (const decision of verification.decisions) {
        const candidate = uniqueCandidates.find(
          (value) => parseRecord(value.normalizedPayload).candidateId === decision.candidateId,
        );
        if (!candidate) continue;
        await prisma.agentExerciseCandidate.updateMany({
          where: { id: candidate.id, userId, operationItemId: itemId },
          data: {
            status: decision.verdict === "verified" ? AgentCandidateStatus.VERIFIED : AgentCandidateStatus.REJECTED,
            verifierReason: decision.reason?.toUpperCase() ?? null,
            verifierNote: decision.note,
          },
        });
      }
    } else {
      await prisma.agentExerciseCandidate.updateMany({
        where: { id: { in: uniqueCandidates.map((candidate) => candidate.id) }, userId, operationItemId: itemId },
        data: { status: AgentCandidateStatus.REJECTED, verifierReason: verification.reason.toUpperCase() },
      });
    }
  }
  const result = await activateSkillDraft({
    userId,
    skillId,
    now,
    skipUsageLimitCheck: true,
    verifiedAgentCandidateItemId: itemId,
    expectedDraftFingerprint: operationItem?.candidateFingerprint ?? undefined,
    expectedDuplicateLibraryFingerprint:
      operationItem?.duplicateLibraryFingerprint ?? undefined,
  });
  if (result.status !== "activated") {
    await failItem(itemId, userId, result.reason, now);
    return;
  }
  await prisma.$transaction([
    prisma.agentSkillOperationItem.update({
      where: { id: itemId },
      data: {
        status: AgentOperationItemStatus.ACTIVE,
        resultSkillId: skillId,
        activationReservedAt: null,
        completedAt: now,
      },
    }),
    prisma.agentExerciseCandidate.updateMany({
      where: { operationItemId: itemId, userId, status: AgentCandidateStatus.VALIDATED },
      data: { status: AgentCandidateStatus.NOT_PROCESSED, verifierReason: "NOT_SELECTED" },
    }),
  ]);
}

export async function reserveAgentActivation(userId: string, itemId: string, now: Date) {
  const prisma = getPrisma();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
        const reservations = await tx.agentSkillOperationItem.count({
          where: {
            userId,
            activationReservedAt: { not: null },
            status: {
              in: [
                AgentOperationItemStatus.QUEUED,
                AgentOperationItemStatus.GENERATING,
                AgentOperationItemStatus.VERIFYING,
                AgentOperationItemStatus.ACTIVATING,
              ],
            },
          },
        });
        const active = await tx.skill.count({
          where: { userId, status: { in: [SkillStatus.ACTIVE, SkillStatus.PAUSED] } },
        });
        const dayStart = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
        );
        const [activationsToday, unclaimedReservationsToday] = await Promise.all([
          tx.generationJob.count({
            where: {
              userId,
              kind: GenerationJobKind.SKILL_ACTIVATION,
              createdAt: { gte: dayStart },
            },
          }),
          tx.agentSkillOperationItem.count({
            where: {
              userId,
              activationReservedAt: { gte: dayStart },
              OR: [
                { createdSkillId: null },
                {
                  createdSkill: {
                    generationJobs: {
                      none: {
                        userId,
                        kind: GenerationJobKind.SKILL_ACTIVATION,
                        createdAt: { gte: dayStart },
                      },
                    },
                  },
                },
              ],
            },
          }),
        ]);
        if (
          active + reservations >= ALPHA_ACTIVE_SKILLS ||
          activationsToday + unclaimedReservationsToday >=
            ALPHA_SKILL_ACTIVATIONS_PER_DAY
        ) {
          return false;
        }
        const claimed = await tx.agentSkillOperationItem.updateMany({
          where: {
            id: itemId,
            userId,
            activationReservedAt: null,
            status: {
              in: [AgentOperationItemStatus.QUEUED, AgentOperationItemStatus.GENERATING],
            },
          },
          data: { activationReservedAt: now, errorCode: null, errorMessage: null },
        });
        return claimed.count === 1;
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (
        !(error instanceof Prisma.PrismaClientKnownRequestError) ||
        error.code !== "P2034" ||
        attempt === 2
      ) {
        throw error;
      }
    }
  }
  return false;
}

async function failItem(itemId: string, userId: string, errorCode: string, now: Date) {
  await getPrisma().agentSkillOperationItem.updateMany({
    where: { id: itemId, userId },
    data: { status: AgentOperationItemStatus.FAILED, errorCode: normalizeAgentItemErrorCode(errorCode), activationReservedAt: null, completedAt: now },
  });
}

export function normalizeAgentItemErrorCode(errorCode: string) {
  return errorCode.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
}

async function reconcileAgentOperation(operationId: string, userId: string, now: Date) {
  const prisma = getPrisma();
  const items = await prisma.agentSkillOperationItem.findMany({ where: { operationId, userId }, select: { status: true } });
  if (items.length === 0) return;
  const status = reduceAgentOperationStatus(items.map((item) => item.status));
  const activeCount = items.filter((item) => item.status === AgentOperationItemStatus.ACTIVE).length;
  const reusedCount = items.filter((item) => item.status === AgentOperationItemStatus.REUSED).length;
  const failedCount = items.filter((item) => item.status === AgentOperationItemStatus.FAILED).length;
  const terminal = [AgentOperationStatus.SUCCEEDED, AgentOperationStatus.PARTIAL, AgentOperationStatus.FAILED, AgentOperationStatus.CANCELED].some((value) => value === status);
  await prisma.agentSkillOperation.updateMany({
    where: { id: operationId, userId },
    data: { status, activeCount, reusedCount, failedCount, completedAt: terminal ? now : null },
  });
}

type SkillSnapshot = {
  title: string;
  objective: string;
  rules: string[];
  examples: string[];
  exerciseConstraints: string;
  tags: string[];
  collection?: string;
};

export function buildSkillDraftInputFromSnapshot(snapshot: SkillSnapshot) {
  return {
    title: snapshot.title,
    objective: snapshot.objective,
    rules: snapshot.rules.join("\n"),
    examples: snapshot.examples.join("\n"),
    exerciseConstraints: snapshot.exerciseConstraints,
    tags: snapshot.tags,
    collectionName: snapshot.collection,
  };
}

function parseSkillSnapshot(value: unknown): SkillSnapshot | null {
  const record = parseRecord(value);
  if (typeof record.title !== "string" || typeof record.objective !== "string") return null;
  return {
    title: record.title,
    objective: record.objective,
    rules: stringArray(record.rules),
    examples: stringArray(record.examples),
    exerciseConstraints: typeof record.exerciseConstraints === "string" ? record.exerciseConstraints : "",
    tags: stringArray(record.tags),
    collection: typeof record.collection === "string" ? record.collection : undefined,
  };
}

function parseRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
