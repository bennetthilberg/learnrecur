"use server";

import { auth, currentUser } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

import {
  saveReminderPreference,
  type NormalizedReminderPreferenceInput,
} from "@/lib/reminders";
import { ensureDatabaseUser } from "@/lib/users";

export type ReminderSettingsActionState = {
  status: "idle" | "error" | "saved";
  message: string | null;
  fieldErrors?: Record<string, string[]>;
  preference?: NormalizedReminderPreferenceInput;
};

type SettingsActionUserResult =
  | {
      status: "ready";
      userId: string;
    }
  | {
      status: "error";
      message: string;
    };

export async function saveReminderSettingsAction(
  _previousState: ReminderSettingsActionState,
  formData: FormData,
): Promise<ReminderSettingsActionState> {
  const user = await requireSettingsActionUser();

  if (user.status === "error") {
    return user;
  }

  const result = await saveReminderPreference({
    userId: user.userId,
    input: formDataToReminderInput(formData),
  });

  if (result.status === "saved") {
    revalidatePath("/settings");
    revalidatePath("/dashboard");

    return {
      status: "saved",
      message: result.message,
      preference: result.preference,
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

async function requireSettingsActionUser(): Promise<SettingsActionUserResult> {
  const { userId } = await auth.protect();
  const clerkUser = await currentUser();

  if (!clerkUser) {
    return {
      status: "error",
      message: "Sign in again before changing reminders.",
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

function formDataToReminderInput(formData: FormData) {
  return {
    enabled: formData.get("enabled") === "on",
    email: getFormString(formData, "email"),
    localHour: getFormString(formData, "localHour"),
    timezone: getFormString(formData, "timezone"),
    minimumDueCount: getFormString(formData, "minimumDueCount"),
  };
}

function getFormString(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
