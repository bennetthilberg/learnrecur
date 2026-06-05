"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import {
  activateSkillDraft,
  createSkillDraft,
  createSkillDraftFromSource,
  refillExactInputExercisesForSkill,
  refillChoiceExercisesForSkill,
  updateSkillDraft,
} from "@/lib/skills";
import {
  completeSourceUploadDrafts,
  prepareSourceUpload,
} from "@/lib/skills/uploads";
import { removeSkillSource } from "@/lib/skills/sources";
import { ensureDatabaseUser } from "@/lib/users";

export type SkillFormActionState = {
  status: "idle" | "error" | "saved";
  message: string | null;
  fieldErrors?: Record<string, string[]>;
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
    message: "Draft saved.",
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
      message: "No skill draft was selected.",
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
  });

  if (result.status === "created") {
    if (result.skills.length === 1) {
      redirect(`/skills/${result.skills[0].id}`);
    }

    redirect(`/skills?createdDrafts=${result.skills.length}`);
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
    revalidatePath("/skills");
    revalidatePath("/dashboard");

    return {
      status: "created",
      message: `Created ${result.skills.length} editable ${result.skills.length === 1 ? "draft" : "drafts"}.`,
      redirectTo:
        result.skills.length === 1
          ? `/skills/${result.skills[0].id}`
          : `/skills?createdDrafts=${result.skills.length}`,
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

  const result = await refillChoiceExercisesForSkill({
    userId: user.userId,
    skillId,
    now: new Date(),
  });

  revalidatePath(`/skills/${skillId}`);
  revalidatePath("/skills");
  revalidatePath("/dashboard");

  if (result.status === "refilled") {
    return {
      status: "saved",
      message: `Generated ${result.exerciseCount} new practice ${result.exerciseCount === 1 ? "exercise" : "exercises"}.`,
    };
  }

  return {
    status: result.status === "not-refilled" && result.reason === "already-at-target"
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

  const result = await refillExactInputExercisesForSkill({
    userId: user.userId,
    skillId,
    now: new Date(),
  });

  revalidatePath(`/skills/${skillId}`);
  revalidatePath("/skills");
  revalidatePath("/dashboard");

  if (result.status === "refilled") {
    return {
      status: "saved",
      message: `Generated ${result.exerciseCount} exact-input ${result.exerciseCount === 1 ? "exercise" : "exercises"}.`,
    };
  }

  return {
    status:
      result.status === "not-refilled" &&
      (result.reason === "already-at-target" || result.reason === "exact-input-locked")
        ? "saved"
        : "error",
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
