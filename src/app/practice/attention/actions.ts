"use server";

import { revalidatePath } from "next/cache";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";

import {
  adjudicateExerciseQualityIncident,
  ExerciseQualityIncidentError,
} from "@/lib/practice";
import {
  queueExerciseReplacement,
  type ExerciseReplacementResult,
} from "@/lib/practice/quality-replacements";

type SavedQualityDecision = Extract<
  Awaited<ReturnType<typeof adjudicateExerciseQualityIncident>>,
  { status: "adjudicated" }
>;

export type SavedQualityDecisionWithReplacement = SavedQualityDecision & {
  replacement: ExerciseReplacementResult | null;
};

const resolveIssueInputSchema = z.strictObject({
  exerciseId: z.string().trim().min(1).max(200),
  resolution: z.enum(["confirmed", "rejected", "inconclusive"]),
  reason: z.string().trim().min(3).max(500),
  expectedUpdatedAt: z.iso.datetime({ offset: true }),
  idempotencyKey: z.string().trim().min(8).max(200),
});

export type ResolveExerciseIssueActionResult =
  | {
      status: "saved";
      result: SavedQualityDecisionWithReplacement;
    }
  | {
      status: "invalid" | "stale" | "already-resolved" | "failed";
      message: string;
    };

export async function resolveExerciseIssueAction(
  rawInput: unknown,
): Promise<ResolveExerciseIssueActionResult> {
  const parsed = resolveIssueInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      status: "invalid",
      message: "Choose a decision and add a reason of at least three characters.",
    };
  }

  const { userId } = await auth.protect();

  try {
    const now = new Date();
    const result = await adjudicateExerciseQualityIncident({
      userId,
      exerciseId: parsed.data.exerciseId,
      adjudication: parsed.data.resolution,
      adjudicationCode: parsed.data.reason,
      expectedUpdatedAt: new Date(parsed.data.expectedUpdatedAt),
      idempotencyKey: parsed.data.idempotencyKey,
      now,
    });

    if (result.status === "not-found") {
      return {
        status: "stale",
        message: "This report is no longer available. Refresh Needs attention to load the current state.",
      };
    }

    const replacement = result.adjudication === "confirmed"
      ? await queueExerciseReplacement({
          userId,
          exerciseId: parsed.data.exerciseId,
          now,
        })
      : null;

    revalidatePath("/practice/attention");
    revalidatePath("/history");
    return { status: "saved", result: { ...result, replacement } };
  } catch (error) {
    if (error instanceof ExerciseQualityIncidentError) {
      if (error.code === "stale") {
        return { status: "stale", message: error.message };
      }
      if (error.code === "already-confirmed") {
        return { status: "already-resolved", message: error.message };
      }
      return { status: "failed", message: error.message };
    }

    return {
      status: "failed",
      message: "The decision could not be saved. Try again.",
    };
  }
}
