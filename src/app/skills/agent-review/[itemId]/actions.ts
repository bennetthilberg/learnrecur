"use server";

import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { resolveAgentDuplicateReview } from "@/lib/agent-access/settings";
import { getAlphaAccessPolicy, isAlphaUserAllowed } from "@/lib/alpha-access";

export async function resolveDuplicateReviewAction(formData: FormData) {
  const { userId } = await auth.protect();
  if (!(await isAlphaUserAllowed(userId, getAlphaAccessPolicy()))) {
    throw new Error("This LearnRecur alpha is invitation-only.");
  }
  const itemId = String(formData.get("itemId") ?? "").trim();
  const decision = String(formData.get("decision") ?? "");
  if (!itemId || (decision !== "use-existing" && decision !== "create-separately")) {
    redirect("/skills");
  }
  const result = await resolveAgentDuplicateReview({
    userId,
    itemId,
    decision,
    now: new Date(),
  });
  revalidatePath("/skills");
  revalidatePath(`/skills/agent-review/${itemId}`);
  redirect(result.status === "saved" ? "/skills" : `/skills/agent-review/${itemId}`);
}
