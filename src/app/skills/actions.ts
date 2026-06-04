"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

import {
  activateSkillDraft,
  createSkillDraft,
  updateSkillDraft,
} from "@/lib/skills";
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

function getFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function getOptionalFormString(formData: FormData, key: string): string | null {
  const value = getFormString(formData, key).trim();
  return value.length > 0 ? value : null;
}
