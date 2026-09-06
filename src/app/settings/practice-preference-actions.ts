"use server";
import { auth } from "@clerk/nextjs/server";
import { after } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  saveCollectionPracticePreferences,
  saveSkillPracticePreferences,
  saveUserPracticePreferences,
} from "@/lib/practice/preferences";
import { queueRetentionPreparation } from "@/lib/skills/retention-preparation";

const targetSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("user") }),
  z.strictObject({
    scope: z.literal("collection"),
    id: z.string().min(1).max(200),
  }),
  z.strictObject({ scope: z.literal("skill"), id: z.string().min(1).max(200) }),
]);
export async function savePracticePreferencesAction(
  targetInput: unknown,
  values: unknown,
) {
  const { userId } = await auth.protect();
  try {
    const target = targetSchema.parse(targetInput);
    const now = new Date();
    if (target.scope === "user") {
      await saveUserPracticePreferences(userId, values);
    } else {
      const result =
        target.scope === "skill"
          ? await saveSkillPracticePreferences({
              userId,
              skillId: target.id,
              input: values,
              now,
            })
          : await saveCollectionPracticePreferences({
              userId,
              collectionId: target.id,
              input: values,
              now,
            });
      if (result.status === "not-found")
        return {
          status: "error" as const,
          message: "These practice settings are no longer available.",
        };
      if (result.status === "too-large")
        return {
          status: "error" as const,
          message:
            "A text policy edit can affect at most 500 inheriting skills. Split this collection before changing its text policy.",
        };
      after(async () => {
        for (const skillId of result.skillIds) {
          try {
            await queueRetentionPreparation({
              userId,
              skillId,
              now: new Date(),
            });
          } catch (error) {
            console.error("Retention preparation could not be queued.", {
              skillId,
              errorType: error instanceof Error ? error.name : "UnknownError",
            });
          }
        }
      });
    }
    for (const path of [
      "/settings",
      "/collections",
      "/skills",
      "/practice",
      "/dashboard",
    ])
      revalidatePath(path);
    if (target.scope === "skill") revalidatePath(`/skills/${target.id}`);
    return { status: "saved" as const, message: "Practice preferences saved." };
  } catch (error) {
    console.error("Practice preferences could not be saved.", {
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      status: "error" as const,
      message:
        error instanceof z.ZodError
          ? "Check the selected practice options."
          : "Could not save practice preferences. Try again.",
    };
  }
}
