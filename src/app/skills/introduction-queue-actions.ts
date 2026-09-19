"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

import {
  IntroductionQueueError,
  updateIntroductionQueue,
} from "@/lib/practice/introduction-queue";
import { getPrisma } from "@/lib/prisma";

export async function updateIntroductionQueueAction(input: {
  collectionId: string | null;
  expectedVersion: number;
  skillIds: string[];
}): Promise<{ status: "saved" | "error"; message: string }> {
  const { userId } = await auth.protect();
  if (
    !Number.isInteger(input.expectedVersion) ||
    input.expectedVersion < 0 ||
    input.skillIds.length > 250 ||
    new Set(input.skillIds).size !== input.skillIds.length
  ) {
    return { status: "error", message: "The introduction queue update was invalid." };
  }

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
      return { status: "error", message: error.message };
    }
    return { status: "error", message: "The introduction order could not be saved. Refresh and try again." };
  }
}
