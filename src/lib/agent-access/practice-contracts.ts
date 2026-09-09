import { z } from "zod";
import {
  dailyNewSkillLimitSchema,
  practiceTimezoneSchema,
} from "@/lib/practice/daily-limit-contracts";
import {
  collectionPracticePreferencesSchema,
  skillPracticePreferencesSchema,
  userPracticePreferencesSchema,
} from "@/lib/practice/preferences";
import {
  practicePreferenceOverrideSchema,
  textPolicySchema,
} from "@/lib/practice/policies";
import { practiceDayStartMinutesSchema } from "@/lib/practice/daily-limit-contracts";
import { desiredRetentionSchema } from "@/lib/scheduling/contracts";

const id = z.string().trim().min(1).max(200);
export const agentPracticeTargetSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("user") }),
  z.strictObject({ scope: z.literal("collection"), id }),
  z.strictObject({ scope: z.literal("skill"), id }),
]);
export type AgentPracticeTarget = z.infer<typeof agentPracticeTargetSchema>;
export const agentGetPracticeSettingsSchema = z.strictObject({
  target: agentPracticeTargetSchema,
});
export const agentListPracticeTargetsSchema = z.strictObject({
  scope: z.enum(["collection", "skill"]),
  query: z.string().trim().min(1).max(100).optional(),
  after_id: id.optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
export const agentUpdatePracticeSettingsSchema = z
  .strictObject({
    target: agentPracticeTargetSchema,
    changes: z.strictObject({
      practicePreference: practicePreferenceOverrideSchema.optional(),
      mixedReview: z.boolean().optional(),
      dailyNewSkillLimit: dailyNewSkillLimitSchema.optional(),
      practiceTimezone: practiceTimezoneSchema.optional(),
      desiredRetention: desiredRetentionSchema.optional(),
      practiceDayStartMinutes: practiceDayStartMinutesSchema.optional(),
      textPolicy: textPolicySchema.nullable().optional(),
      alreadyStudied: z.boolean().optional(),
    }),
  })
  .superRefine(({ target, changes }, context) => {
    const schema =
      target.scope === "user"
        ? userPracticePreferencesSchema
        : target.scope === "collection"
          ? collectionPracticePreferencesSchema
          : skillPracticePreferencesSchema;
    if (
      !Object.values(changes).some((value) => value !== undefined) ||
      !schema.partial().safeParse(changes).success
    ) {
      context.addIssue({
        code: "custom",
        path: ["changes"],
        message:
          "Supply at least one setting supported by this target. User settings: practicePreference (non-null), mixedReview, dailyNewSkillLimit (0-1000 or null for unlimited), practiceTimezone (IANA timezone), desiredRetention (0.70-0.99 or null for the ts-fsrs default), practiceDayStartMinutes (0-1439). Collection: practicePreference, textPolicy. Skill: practicePreference, textPolicy, alreadyStudied.",
      });
    }
  });
