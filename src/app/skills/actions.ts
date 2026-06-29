"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { SkillStatus, type Prisma } from "@/generated/prisma/client";
import {
  activateSkillDraft,
  createSkillDraft,
  createSkillDraftFromSource,
  updateSkillDraft,
  updateSkillPracticeGuidance,
} from "@/lib/skills";
import {
  queueExactInputExerciseRefillForSkill,
  queueChoiceExerciseRefillForSkill,
  queueMathExerciseRefillForSkill,
} from "@/lib/skills/refill-jobs";
import {
  archiveSkill,
  pauseSkill,
  restoreArchivedSkill,
  resumeSkill,
} from "@/lib/skills/lifecycle";
import { deleteSkillPermanently } from "@/lib/skills/delete";
import {
  completeSourceUploadDrafts,
  dismissFailedSourceUpload,
  prepareSourceUpload,
  requeueSourceUploadDraft,
} from "@/lib/skills/uploads";
import { removeSkillSource } from "@/lib/skills/sources";
import { getPrisma } from "@/lib/prisma";
import { ensureDatabaseUser } from "@/lib/users";

export type CreatedSkillDraftForReview = {
  skillId: string;
  values: {
    title: string;
    objective: string;
    collectionName: string;
    rules: string;
    examples: string;
    exerciseConstraints: string;
    tags: string;
  };
};

export type SkillFormActionState = {
  status: "idle" | "error" | "saved" | "activated";
  message: string | null;
  fieldErrors?: Record<string, string[]>;
  createdSkill?: CreatedSkillDraftForReview;
  activatedSkillId?: string;
};

type SkillActionUserResult =
  | {
      status: "ready";
      userId: string;
    }
  | {
      status: "error";
      message: string;
    };

type LifecycleAction = "pause" | "resume" | "archive" | "restore";

export type PrepareSourceUploadActionResult =
  | {
      status: "prepared";
      sourceFileId: string;
      uploadUrl: string;
      headers: Record<string, string>;
      expiresInSeconds: number;
    }
  | {
      status: "error";
      message: string;
      fieldErrors?: Record<string, string[]>;
    };

export type CompleteSourceUploadActionResult =
  | {
      status: "created";
      message: string;
      redirectTo: string;
      skill: CreatedSkillDraftForReview | null;
    }
  | {
      status: "error";
      message: string;
    };

export async function saveSkillDraftAction(
  _previousState: SkillFormActionState,
  formData: FormData,
): Promise<SkillFormActionState> {
  const user = await requireSkillActionUser();

  if (user.status === "error") {
    return user;
  }

  const skillId = getOptionalFormString(formData, "skillId");
  const draftInput = formDataToDraftInput(formData);
  const result = skillId
    ? await updateSkillDraft({ userId: user.userId, skillId, input: draftInput })
    : await createSkillDraft({ userId: user.userId, input: draftInput });

  if (result.status === "invalid") {
    return {
      status: "error",
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  }

  if (result.status === "not-found") {
    return {
      status: "error",
      message: result.message,
    };
  }

  if (result.status === "created") {
    redirect(`/skills/${result.skill.id}`);
  }

  return {
    status: "saved",
    message: "Skill saved.",
  };
}

export async function activateSkillDraftAction(
  _previousState: SkillFormActionState,
  formData: FormData,
): Promise<SkillFormActionState> {
  const user = await requireSkillActionUser();

  if (user.status === "error") {
    return user;
  }

  const skillId = getOptionalFormString(formData, "skillId");

  if (!skillId) {
    return {
      status: "error",
      message: "No skill was selected.",
    };
  }

  const result = await activateSkillDraft({
    userId: user.userId,
    skillId,
    now: new Date(),
  });

  if (result.status === "activated") {
    redirect("/practice");
  }

  return {
    status: "error",
    message: result.message,
  };
}

export async function addSkillDraftToPracticeAction(
  _previousState: SkillFormActionState,
  formData: FormData,
): Promise<SkillFormActionState> {
  const result = await saveAndActivateSkillDraft(formData);

  if (result.status === "activated" && result.activatedSkillId) {
    revalidatePath(`/skills/${result.activatedSkillId}`);
    revalidatePath("/skills");
    revalidatePath("/dashboard");
    revalidatePath("/practice");
    redirect(`/skills/${result.activatedSkillId}`);
  }

  return result;
}

export async function addSkillDraftToPracticeInlineAction(
  _previousState: SkillFormActionState,
  formData: FormData,
): Promise<SkillFormActionState> {
  return saveAndActivateSkillDraft(formData);
}

export async function generateSkillDraftFromSourceAction(
  _previousState: SkillFormActionState,
  formData: FormData,
): Promise<SkillFormActionState> {
  const user = await requireSkillActionUser();

  if (user.status === "error") {
    return user;
  }

  const result = await createSkillDraftFromSource({
    userId: user.userId,
    now: new Date(),
    input: formDataToSourceDraftInput(formData),
    persistFailedSource: true,
  });

  if (result.status === "created") {
    const skill = result.skills[0];

    if (skill) {
      const draft = await getSkillDraftForReview(user.userId, skill.id);

      if (draft) {
        revalidatePath("/skills");
        revalidatePath("/dashboard");
        revalidatePath(`/skills/${skill.id}`);

        return {
          status: "saved",
          message: "Skill ready to review.",
          createdSkill: draft,
        };
      }

      revalidatePath("/skills");
      revalidatePath("/dashboard");
      revalidatePath(`/skills/${skill.id}`);

      return {
        status: "saved",
        message: "Skill was created, but LearnRecur could not load it for review. Open Skills and try again.",
      };
    }

    return {
      status: "error",
      message: "LearnRecur could not create a skill from that source. Try again with a clearer excerpt.",
    };
  }

  if (result.status === "invalid") {
    return {
      status: "error",
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  }

  return {
    status: "error",
    message:
      result.reason === "generation-failed" ||
      result.reason === "invalid-generation" ||
      result.reason === "save-failed"
        ? `${result.message} Your material was saved, so you can try again without losing it.`
        : result.message,
  };
}

export async function prepareSourceUploadAction(
  formData: FormData,
): Promise<PrepareSourceUploadActionResult> {
  const user = await requireSkillActionUser();

  if (user.status === "error") {
    return user;
  }

  const result = await prepareSourceUpload({
    userId: user.userId,
    now: new Date(),
    input: formDataToSourceUploadInput(formData),
  });

  if (result.status === "prepared") {
    return {
      status: "prepared",
      sourceFileId: result.sourceFileId,
      uploadUrl: result.uploadUrl,
      headers: result.headers,
      expiresInSeconds: result.expiresInSeconds,
    };
  }

  if (result.status === "invalid") {
    return {
      status: "error",
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  }

  return {
    status: "error",
    message: result.message,
  };
}

export async function completeSourceUploadAction(input: {
  sourceFileId: string;
}): Promise<CompleteSourceUploadActionResult> {
  const user = await requireSkillActionUser();

  if (user.status === "error") {
    return user;
  }

  const result = await completeSourceUploadDrafts({
    userId: user.userId,
    sourceFileId: input.sourceFileId,
    now: new Date(),
  });

  if (result.status === "created") {
    const skill = result.skills[0];

    if (!skill) {
      return {
        status: "error",
        message: "LearnRecur could not create a skill from that source. Try again with a clearer excerpt.",
      };
    }

    revalidatePath("/skills");
    revalidatePath("/dashboard");
    revalidatePath(`/skills/${skill.id}`);

    const draft = await getSkillDraftForReview(user.userId, skill.id);

    if (!draft) {
      return {
        status: "created",
        message: "Skill was created, but LearnRecur could not load it for review. Open Skills and try again.",
        redirectTo: `/skills/${skill.id}`,
        skill: null,
      };
    }

    return {
      status: "created",
      message: "Skill ready to review.",
      redirectTo: `/skills/${skill.id}`,
      skill: draft,
    };
  }

  return {
    status: "error",
    message:
      result.status === "not-created"
        ? `${result.message} Try again here, or choose a clearer file.`
        : result.message,
  };
}

export async function requeueSourceUploadAction(
  _previousState: SkillFormActionState,
  formData: FormData,
): Promise<SkillFormActionState> {
  const user = await requireSkillActionUser();

  if (user.status === "error") {
    return user;
  }

  const sourceFileId = getOptionalFormString(formData, "sourceFileId");

  if (!sourceFileId) {
    return {
      status: "error",
      message: "No uploaded source was selected.",
    };
  }

  const result = await requeueSourceUploadDraft({
    userId: user.userId,
    sourceFileId,
    now: new Date(),
  });

  revalidatePath("/skills");
  revalidatePath("/skills/new");
  revalidatePath("/dashboard");

  if (result.status === "queued") {
    return {
      status: "saved",
      message: result.message,
    };
  }

  return {
    status: "error",
    message: result.message,
  };
}

export async function dismissFailedSourceUploadAction(
  _previousState: SkillFormActionState,
  formData: FormData,
): Promise<SkillFormActionState> {
  const user = await requireSkillActionUser();

  if (user.status === "error") {
    return user;
  }

  const sourceFileId = getOptionalFormString(formData, "sourceFileId");

  if (!sourceFileId) {
    return {
      status: "error",
      message: "No failed source was selected.",
    };
  }

  const result = await dismissFailedSourceUpload({
    userId: user.userId,
    sourceFileId,
  });

  revalidatePath("/skills");
  revalidatePath("/dashboard");

  if (result.status === "dismissed") {
    return {
      status: "saved",
      message: result.message,
    };
  }

  return {
    status: "error",
    message: result.message,
  };
}

export async function refillChoiceExercisesAction(
  _previousState: SkillFormActionState,
  formData: FormData,
): Promise<SkillFormActionState> {
  const user = await requireSkillActionUser();

  if (user.status === "error") {
    return user;
  }

  const skillId = getOptionalFormString(formData, "skillId");

  if (!skillId) {
    return {
      status: "error",
      message: "No active skill was selected.",
    };
  }

  const result = await queueChoiceExerciseRefillForSkill({
    userId: user.userId,
    skillId,
    now: new Date(),
  });

  revalidatePath(`/skills/${skillId}`);
  revalidatePath("/skills");
  revalidatePath("/dashboard");

  if (result.status === "queued") {
    return {
      status: "saved",
      message: result.message,
    };
  }

  return {
    status:
      result.status === "not-queued" &&
      (result.reason === "already-at-target" || result.reason === "job-in-progress")
        ? "saved"
        : "error",
    message: result.message,
  };
}

export async function refillExactInputExercisesAction(
  _previousState: SkillFormActionState,
  formData: FormData,
): Promise<SkillFormActionState> {
  const user = await requireSkillActionUser();

  if (user.status === "error") {
    return user;
  }

  const skillId = getOptionalFormString(formData, "skillId");

  if (!skillId) {
    return {
      status: "error",
      message: "No active skill was selected.",
    };
  }

  const result = await queueExactInputExerciseRefillForSkill({
    userId: user.userId,
    skillId,
    now: new Date(),
  });

  revalidatePath(`/skills/${skillId}`);
  revalidatePath("/skills");
  revalidatePath("/dashboard");

  if (result.status === "queued") {
    return {
      status: "saved",
      message: result.message,
    };
  }

  return {
    status:
      result.status === "not-queued" &&
      (result.reason === "already-at-target" ||
        result.reason === "exact-input-locked" ||
        result.reason === "job-in-progress")
        ? "saved"
        : "error",
    message: result.message,
  };
}

export async function refillMathExercisesAction(
  _previousState: SkillFormActionState,
  formData: FormData,
): Promise<SkillFormActionState> {
  const user = await requireSkillActionUser();

  if (user.status === "error") {
    return user;
  }

  const skillId = getOptionalFormString(formData, "skillId");

  if (!skillId) {
    return {
      status: "error",
      message: "No active skill was selected.",
    };
  }

  const result = await queueMathExerciseRefillForSkill({
    userId: user.userId,
    skillId,
    now: new Date(),
  });

  revalidatePath(`/skills/${skillId}`);
  revalidatePath("/skills");
  revalidatePath("/dashboard");

  if (result.status === "queued") {
    return {
      status: "saved",
      message: result.message,
    };
  }

  return {
    status:
      result.status === "not-queued" &&
      (result.reason === "already-at-target" ||
        result.reason === "exact-input-locked" ||
        result.reason === "job-in-progress")
        ? "saved"
        : "error",
    message: result.message,
  };
}

export async function updateSkillLifecycleAction(
  _previousState: SkillFormActionState,
  formData: FormData,
): Promise<SkillFormActionState> {
  const user = await requireSkillActionUser();

  if (user.status === "error") {
    return user;
  }

  const skillId = getOptionalFormString(formData, "skillId");
  const lifecycleAction = getOptionalFormString(formData, "lifecycleAction");
  const confirmed = formData.get("confirmLifecycle") === "yes";

  if (!skillId || !lifecycleAction) {
    return {
      status: "error",
      message: "No skill lifecycle change was selected.",
    };
  }

  if (!isLifecycleAction(lifecycleAction)) {
    return {
      status: "error",
      message: "Unsupported skill lifecycle action.",
    };
  }

  if (lifecycleAction === "archive" && !confirmed) {
    return {
      status: "error",
      message: "Confirm archiving before continuing.",
    };
  }

  const result = await runLifecycleAction({
    action: lifecycleAction,
    userId: user.userId,
    skillId,
  });

  revalidatePath(`/skills/${skillId}`);
  revalidatePath("/skills");
  revalidatePath("/dashboard");
  revalidatePath("/practice");

  if (result.status === "updated") {
    return {
      status: "saved",
      message: result.message,
    };
  }

  return {
    status: "error",
    message: result.message,
  };
}

export async function deleteSkillPermanentlyAction(
  _previousState: SkillFormActionState,
  formData: FormData,
): Promise<SkillFormActionState> {
  const user = await requireSkillActionUser();

  if (user.status === "error") {
    return user;
  }

  const skillId = getOptionalFormString(formData, "skillId");
  const confirmationTitle = getOptionalFormString(formData, "confirmationTitle");

  if (!skillId || !confirmationTitle) {
    return {
      status: "error",
      message: "Type the skill title to confirm deletion.",
    };
  }

  const result = await deleteSkillPermanently({
    userId: user.userId,
    skillId,
    confirmationTitle,
  });

  if (result.status === "deleted") {
    revalidatePath(`/skills/${skillId}`);
    revalidatePath("/skills");
    revalidatePath("/dashboard");
    revalidatePath("/practice");
    redirect("/skills?deletedSkill=1");
  }

  return {
    status: "error",
    message: result.message,
  };
}

export async function removeSkillSourceAction(
  _previousState: SkillFormActionState,
  formData: FormData,
): Promise<SkillFormActionState> {
  const user = await requireSkillActionUser();

  if (user.status === "error") {
    return user;
  }

  const skillId = getOptionalFormString(formData, "skillId");
  const sourceRefId = getOptionalFormString(formData, "sourceRefId");
  const confirmed = formData.get("confirmRemove") === "yes";

  if (!skillId || !sourceRefId) {
    return {
      status: "error",
      message: "No source material was selected.",
    };
  }

  if (!confirmed) {
    return {
      status: "error",
      message: "Confirm source removal before continuing.",
    };
  }

  const result = await removeSkillSource({
    userId: user.userId,
    skillId,
    sourceRefId,
  });

  revalidatePath(`/skills/${skillId}`);
  revalidatePath("/skills");
  revalidatePath("/dashboard");

  if (result.status === "removed") {
    return {
      status: "saved",
      message: result.message,
    };
  }

  return {
    status: "error",
    message: result.message,
  };
}

export async function updateSkillPracticeGuidanceAction(
  _previousState: SkillFormActionState,
  formData: FormData,
): Promise<SkillFormActionState> {
  const user = await requireSkillActionUser();

  if (user.status === "error") {
    return user;
  }

  const skillId = getOptionalFormString(formData, "skillId");

  if (!skillId) {
    return {
      status: "error",
      message: "No skill was selected.",
    };
  }

  const result = await updateSkillPracticeGuidance({
    userId: user.userId,
    skillId,
    input: {
      rules: getFormString(formData, "rules"),
      examples: getFormString(formData, "examples"),
      exerciseConstraints: getFormString(formData, "exerciseConstraints"),
    },
  });

  if (result.status === "updated") {
    revalidatePath(`/skills/${result.skillId}`);
    revalidatePath("/skills");
    revalidatePath("/dashboard");
    revalidatePath("/practice");

    return {
      status: "saved",
      message: "Practice guidance saved.",
    };
  }

  if (result.status === "invalid") {
    return {
      status: "error",
      message: result.message,
      fieldErrors: result.fieldErrors,
    };
  }

  return {
    status: "error",
    message: result.message,
  };
}

async function runLifecycleAction(input: {
  action: LifecycleAction;
  userId: string;
  skillId: string;
}) {
  switch (input.action) {
    case "pause":
      return pauseSkill(input);
    case "resume":
      return resumeSkill(input);
    case "archive":
      return archiveSkill(input);
    case "restore":
      return restoreArchivedSkill(input);
  }
}

function isLifecycleAction(value: string): value is LifecycleAction {
  return value === "pause" || value === "resume" || value === "archive" || value === "restore";
}

async function saveAndActivateSkillDraft(formData: FormData): Promise<SkillFormActionState> {
  const user = await requireSkillActionUser();

  if (user.status === "error") {
    return user;
  }

  const skillId = getOptionalFormString(formData, "skillId");

  if (!skillId) {
    return {
      status: "error",
      message: "No skill was selected.",
    };
  }

  const draftInput = formDataToDraftInput(formData);
  const saveResult = await updateSkillDraft({
    userId: user.userId,
    skillId,
    input: draftInput,
  });

  if (saveResult.status === "invalid") {
    return {
      status: "error",
      message: saveResult.message,
      fieldErrors: saveResult.fieldErrors,
    };
  }

  if (saveResult.status === "not-found") {
    return {
      status: "error",
      message: saveResult.message,
    };
  }

  const addResult = await activateSkillDraft({
    userId: user.userId,
    skillId,
    now: new Date(),
  });

  if (addResult.status === "activated") {
    revalidatePath(`/skills/${addResult.skillId}`);
    revalidatePath("/skills");
    revalidatePath("/dashboard");
    revalidatePath("/practice");

    return {
      status: "activated",
      message: "Skill added.",
      activatedSkillId: addResult.skillId,
    };
  }

  return {
    status: "saved",
    message: `Your changes were saved, but the skill was not added. ${addResult.message}`,
  };
}

async function getSkillDraftForReview(
  userId: string,
  skillId: string,
): Promise<CreatedSkillDraftForReview | null> {
  const skill = await getPrisma().skill.findFirst({
    where: {
      id: skillId,
      userId,
      status: SkillStatus.DRAFT,
    },
    select: {
      id: true,
      title: true,
      objective: true,
      rules: true,
      examples: true,
      exerciseConstraints: true,
      tags: true,
      collection: {
        select: {
          name: true,
        },
      },
    },
  });

  if (!skill) {
    return null;
  }

  return {
    skillId: skill.id,
    values: {
      title: skill.title,
      objective: skill.objective ?? "",
      collectionName: skill.collection?.name ?? "",
      rules: notesToText(skill.rules),
      examples: notesToText(skill.examples),
      exerciseConstraints: notesToText(skill.exerciseConstraints),
      tags: skill.tags.join(", "),
    },
  };
}

async function requireSkillActionUser(): Promise<SkillActionUserResult> {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();

  if (!clerkUser) {
    return {
      status: "error",
      message: "Could not load the signed-in Clerk user.",
    };
  }

  const databaseUser = await ensureDatabaseUser(clerkUser);

  if (databaseUser.status !== "ready") {
    return {
      status: "error",
      message: databaseUser.message,
    };
  }

  return {
    status: "ready",
    userId,
  };
}

function formDataToDraftInput(formData: FormData) {
  return {
    title: getFormString(formData, "title"),
    objective: getFormString(formData, "objective"),
    collectionName: getFormString(formData, "collectionName"),
    rules: getFormString(formData, "rules"),
    examples: getFormString(formData, "examples"),
    exerciseConstraints: getFormString(formData, "exerciseConstraints"),
    tags: getFormString(formData, "tags"),
  };
}

function formDataToSourceDraftInput(formData: FormData) {
  return {
    sourceText: getFormString(formData, "sourceText"),
    sourceLabel: getFormString(formData, "sourceLabel"),
    focusNote: getFormString(formData, "focusNote"),
    collectionName: getFormString(formData, "collectionName"),
    tags: getFormString(formData, "tags"),
  };
}

function formDataToSourceUploadInput(formData: FormData) {
  return {
    originalName: getFormString(formData, "originalName"),
    mimeType: getFormString(formData, "mimeType"),
    byteSize: getFormString(formData, "byteSize"),
    sourceLabel: getFormString(formData, "sourceLabel"),
    focusNote: getFormString(formData, "focusNote"),
    collectionName: getFormString(formData, "collectionName"),
    tags: getFormString(formData, "tags"),
  };
}

function getFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function getOptionalFormString(formData: FormData, key: string): string | null {
  const value = getFormString(formData, key).trim();
  return value.length > 0 ? value : null;
}

function notesToText(value: Prisma.JsonValue | null): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  if ("items" in value && Array.isArray(value.items)) {
    return value.items.filter((item) => typeof item === "string").join("\n");
  }

  if ("notes" in value && typeof value.notes === "string") {
    return value.notes;
  }

  return "";
}
