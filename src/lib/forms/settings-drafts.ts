import { z } from "zod";
const numericInput = z.union([z.number(), z.string().max(32)]);
export const practiceSettingsDraftSchema = z.object({
  preference: z.enum(["DEFAULT", "BALANCED", "RECALL_FIRST"]),
  profile: z.enum(["DEFAULT", "NATURAL", "EXACT", "CUSTOM"]),
  caseLenient: z.boolean(), spaceLenient: z.boolean(), studied: z.boolean(), unlimited: z.boolean(),
  dailyLimit: numericInput, timezone: z.string().max(100), useDefaultRetention: z.boolean(),
  retentionEdited: z.boolean(), retentionPercent: numericInput, dayStart: z.string().max(10),
});
export const reminderDraftSchema = z.object({
  enabled: z.boolean(), timezone: z.string().max(100), localHour: z.string().max(2), minimumDueCount: z.string().max(10),
});
