import { z } from "zod";

export const skillOrganizationSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("rename"), title: z.string().trim().min(1, "Enter a skill name.").max(120, "Use 120 characters or fewer.") }),
  z.object({ mode: z.literal("move"), collectionId: z.string().max(200).nullable() }),
]);
export const skillOrganizationDraftSchema = z.object({ title: z.string().max(120), collectionId: z.string().max(200) });
