"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";

import {
  confirmMaterialPlan,
  excludeMaterialDraftItem,
  planMaterialSkills,
  queueMaterialBatchActivation,
  replanMaterialSkills,
  retryMaterialBatchActivationItem,
  retryMaterialDraftItem,
} from "@/lib/materials/batches";
import { materialScopePlanSchema } from "@/lib/materials/contracts";
import { ensureDatabaseUser } from "@/lib/users";

const automaticRepairInputSchema = z.strictObject({
  batchId: z.string().trim().min(1).max(64),
  itemIds: z.array(z.string().trim().min(1).max(64)).min(1).max(10),
});

const useExistingDecisionInputSchema = z.strictObject({
  expectedCandidateId: z.string().trim().min(1).max(64),
  expectedCandidateFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  expectedMatchId: z.string().trim().min(1).max(64),
  expectedMatchFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export async function planMaterialSkillsAction(formData: FormData) {
  const userId = await requireBatchUser();
  const materialId = formString(formData, "materialId");
  const result = await planMaterialSkills({
    userId,
    now: new Date(),
    input: {
      materialId,
      materialRevisionId: formString(formData, "materialRevisionId"),
      instruction: formString(formData, "instruction"),
      idempotencyKey: formString(formData, "idempotencyKey"),
    },
  });
  if (result.status === "planned" || result.status === "needs-scope") {
    revalidateBatchPaths(result.batchId, materialId);
    return redirect(`/skills/batches/${result.batchId}`);
  }
  const message = "message" in result ? result.message : "Material scope planning failed.";
  redirect(
    `/skills/materials/${materialId}/create?error=${encodeURIComponent(message)}`,
  );
}

export async function replanMaterialSkillsAction(formData: FormData) {
  const userId = await requireBatchUser();
  const batchId = formString(formData, "batchId");
  const result = await replanMaterialSkills({
    userId,
    now: new Date(),
    input: { batchId, instruction: formString(formData, "instruction") },
  });
  if (result.status === "planned" || result.status === "needs-scope") {
    revalidatePath(`/skills/batches/${batchId}`);
    return redirect(`/skills/batches/${batchId}`);
  }
  const message = "message" in result ? result.message : "Material scope planning failed.";
  redirect(`/skills/batches/${batchId}?error=${encodeURIComponent(message)}`);
}

export async function confirmMaterialPlanAction(formData: FormData) {
  const userId = await requireBatchUser();
  const batchId = formString(formData, "batchId");
  let rawPlan: unknown;
  try {
    rawPlan = JSON.parse(formString(formData, "planJson")) as unknown;
  } catch {
    redirect(`/skills/batches/${batchId}?error=${encodeURIComponent("The reviewed plan was invalid.")}`);
  }
  const plan = materialScopePlanSchema.safeParse(rawPlan);
  if (!plan.success) {
    redirect(`/skills/batches/${batchId}?error=${encodeURIComponent("The reviewed plan was invalid.")}`);
  }
  const result = await confirmMaterialPlan({
    userId,
    now: new Date(),
    input: {
      batchId,
      plan: plan.data,
      createSeparatelyTargetKeys: formStrings(
        formData,
        "createSeparatelyTargetKey",
      ),
    },
  });
  if (result.status === "queued") {
    revalidatePath(`/skills/batches/${batchId}`);
    return redirect(`/skills/batches/${batchId}`);
  }
  if (result.status === "partial") {
    revalidatePath(`/skills/batches/${batchId}`);
    return redirect(
      `/skills/batches/${batchId}?error=${encodeURIComponent("Background processing was unavailable, so some drafts did not start. Retry the failed drafts below.")}`,
    );
  }
  const message =
    "message" in result && typeof result.message === "string"
      ? result.message
      : "The batch could not be started.";
  redirect(`/skills/batches/${batchId}?error=${encodeURIComponent(message)}`);
}

export async function retryMaterialDraftItemAction(formData: FormData) {
  const userId = await requireBatchUser();
  const batchId = formString(formData, "batchId");
  const result = await retryMaterialDraftItem({
    userId,
    batchId,
    itemId: formString(formData, "itemId"),
    now: new Date(),
  });
  revalidatePath(`/skills/batches/${batchId}`);
  if (result.status !== "queued") {
    const message =
      "message" in result
        ? result.message
        : "Background processing was unavailable. Try again in a moment.";
    redirect(`/skills/batches/${batchId}?error=${encodeURIComponent(message)}`);
  }
}

export async function autoRepairMaterialDraftItemsAction(input: unknown) {
  const parsed = automaticRepairInputSchema.safeParse(input);
  if (!parsed.success) {
    return { status: "invalid" as const };
  }
  const userId = await requireBatchUser();
  let queuedCount = 0;
  for (const itemId of parsed.data.itemIds) {
    const result = await retryMaterialDraftItem({
      userId,
      batchId: parsed.data.batchId,
      itemId,
      now: new Date(),
      automatic: true,
    });
    if (result.status === "queued") {
      queuedCount += 1;
    }
  }
  revalidatePath(`/skills/batches/${parsed.data.batchId}`);
  return { status: queuedCount > 0 ? ("queued" as const) : ("unchanged" as const) };
}

export async function activateMaterialBatchAction(formData: FormData) {
  const userId = await requireBatchUser();
  const batchId = formString(formData, "batchId");
  const itemIds = formStrings(formData, "itemId");
  const createSeparatelyItemIds = formStrings(
    formData,
    "createSeparatelyItemId",
  );
  const createSeparatelySkillIds = formStrings(
    formData,
    "createSeparatelySkillId",
  );
  const result = await queueMaterialBatchActivation({
    userId,
    input: {
      batchId,
      itemIds,
      createSeparatelyMatches: createSeparatelyItemIds.map(
        (itemId, index) => ({
          itemId,
          skillId: createSeparatelySkillIds[index] ?? "",
        }),
      ),
    },
    now: new Date(),
  });
  if (
    result.status === "queued" ||
    result.status === "partial" ||
    result.status === "already-queued" ||
    result.status === "review-required"
  ) {
    revalidatePath(`/skills/batches/${batchId}`);
    revalidatePath("/skills");
    return redirect(`/skills/batches/${batchId}`);
  }
  const message =
    "message" in result && typeof result.message === "string"
      ? result.message
      : "The selected skills could not be added.";
  redirect(`/skills/batches/${batchId}?error=${encodeURIComponent(message)}`);
}

export async function retryMaterialBatchActivationItemAction(formData: FormData) {
  const userId = await requireBatchUser();
  const batchId = formString(formData, "batchId");
  const result = await retryMaterialBatchActivationItem({
    userId,
    batchId,
    itemId: formString(formData, "itemId"),
    now: new Date(),
  });
  revalidatePath(`/skills/batches/${batchId}`);
  revalidatePath("/skills");
  if (result.status !== "queued") {
    const message = "message" in result ? result.message : "Activation could not be retried.";
    redirect(`/skills/batches/${batchId}?error=${encodeURIComponent(message)}`);
  }
}

export async function excludeMaterialDraftItemAction(formData: FormData) {
  const userId = await requireBatchUser();
  const batchId = formString(formData, "batchId");
  const rawIntent = formData.get("intent");
  if (rawIntent !== "exclude" && rawIntent !== "use-existing") {
    return {
      status: "error" as const,
      message: "This choice was incomplete. Refresh the batch and try again.",
    };
  }
  const itemId = formString(formData, "itemId");
  let result: Awaited<ReturnType<typeof excludeMaterialDraftItem>>;
  if (rawIntent === "use-existing") {
    const decision = useExistingDecisionInputSchema.safeParse({
      expectedCandidateId: formData.get("expectedCandidateId"),
      expectedCandidateFingerprint: formData.get(
        "expectedCandidateFingerprint",
      ),
      expectedMatchId: formData.get("expectedMatchId"),
      expectedMatchFingerprint: formData.get("expectedMatchFingerprint"),
    });
    if (!decision.success) {
      return {
        status: "error" as const,
        message:
          "The existing skill preview changed. Refresh the batch and compare it again.",
      };
    }
    result = await excludeMaterialDraftItem({
      userId,
      batchId,
      itemId,
      intent: "use-existing",
      expectedCandidateId: decision.data.expectedCandidateId,
      expectedCandidateFingerprint:
        decision.data.expectedCandidateFingerprint,
      expectedMatchId: decision.data.expectedMatchId,
      expectedMatchFingerprint: decision.data.expectedMatchFingerprint,
      now: new Date(),
    });
  } else {
    result = await excludeMaterialDraftItem({
      userId,
      batchId,
      itemId,
      intent: "exclude",
      now: new Date(),
    });
  }
  if (result.status !== "excluded") {
    return {
      status: "error" as const,
      message:
        result.status === "not-excluded"
          ? result.message
          : "This draft could not be excluded. Refresh the batch and try again.",
    };
  }
  revalidatePath(`/skills/batches/${batchId}`);
  revalidatePath("/skills");
  return { status: "excluded" as const };
}

async function requireBatchUser() {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();
  if (!clerkUser) {
    throw new Error(`Clerk returned no user for authenticated user ${userId}.`);
  }
  const databaseUser = await ensureDatabaseUser(clerkUser);
  if (databaseUser.status !== "ready") {
    throw new Error(databaseUser.message);
  }
  return userId;
}

function revalidateBatchPaths(batchId: string, materialId: string) {
  revalidatePath(`/skills/batches/${batchId}`);
  revalidatePath(`/skills/materials/${materialId}`);
  revalidatePath("/skills/materials");
}

function formString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function formStrings(formData: FormData, key: string) {
  return formData
    .getAll(key)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter(Boolean);
}
