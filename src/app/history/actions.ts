"use server";
import { auth } from "@clerk/nextjs/server";
import { z } from "zod";
import { getPracticeHistoryPage } from "@/lib/practice/history";
import { toHistoryReviewRow } from "./history-row";

const inputSchema = z.object({
  skillId: z.string().max(200).optional(),
  collectionId: z.string().max(200).optional(),
  incorrectOnly: z.boolean().optional(),
  mode: z.enum(["scheduled", "practice-only"]).optional(),
  cursor: z.object({ reviewedAt: z.iso.datetime(), id: z.string().min(1).max(200) }),
});
export async function loadMoreHistoryAction(input: unknown) {
  const { userId } = await auth.protect();
  const parsed = inputSchema.parse(input);
  const page = await getPracticeHistoryPage({ ...parsed, userId, now: new Date() });
  return { reviews: page.reviews.map(toHistoryReviewRow), nextCursor: page.nextCursor };
}
