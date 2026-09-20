"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import {
  IntroductionQueueError,
  updateIntroductionQueue,
} from "@/lib/practice/introduction-queue";
import { getPrisma } from "@/lib/prisma";

const introductionQueueActionInputSchema = z.object({
  collectionId: z.string().nullable(),
  expectedVersion: z.number().int().nonnegative(),
  skillIds: z.array(z.string().min(1)).max(250),
}).superRefine((input, context) => {
  if (new Set(input.skillIds).size !== input.skillIds.length) {
    context.addIssue({ code: "custom", path: ["skillIds"], message: "Skill IDs must be unique." });
  }
});

type IntroductionQueueActionResult =
  | { status: "saved"; message: string }
  | { status: "error"; message: string; code?: IntroductionQueueError["code"] };

export async function updateIntroductionQueueAction(
  rawInput: unknown,
): Promise<IntroductionQueueActionResult> {
  const { userId } = await auth.protect();
  const parsed = introductionQueueActionInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { status: "error", message: "The introduction queue update was invalid." };
  }
  const input = parsed.data;

  try {
    await getPrisma().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR UPDATE`;
      await updateIntroductionQueue(tx, {
        userId,
        collectionId: input.collectionId,
        expectedVersion: input.expectedVersion,
        skillIds: input.skillIds,
      });
    }, { timeout: 15_000 });
    revalidatePath("/skills");
    return { status: "saved", message: "Introduction order saved." };
  } catch (error) {
    if (error instanceof IntroductionQueueError) {
      return { status: "error", code: error.code, message: error.message };
    }
    return { status: "error", message: "The introduction order could not be saved. Refresh and try again." };
  }
}
