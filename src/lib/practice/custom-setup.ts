import { z } from "zod";

export type CustomSetupSkill = { id: string; title: string; collectionId: string | null; tags: string[]; dueAt: string | null; recentlyMissed: boolean };
export const customSetupDraftSchema = z.object({
  mode: z.enum(["PRACTICE_ONLY", "SCHEDULED"]), targetCount: z.string().max(10), collectionId: z.string().max(200),
  selectedTags: z.array(z.string()).max(100), selectedSkills: z.array(z.string()).max(500), recentlyMissed: z.boolean(),
});
export type CustomSetupDraft = z.infer<typeof customSetupDraftSchema>;
export function matchingCustomSkills(skills: CustomSetupSkill[], filters: CustomSetupDraft, now: number) {
  return skills.filter((skill) => (!filters.collectionId || skill.collectionId === filters.collectionId) &&
    filters.selectedTags.every((tag) => skill.tags.includes(tag)) && (!filters.recentlyMissed || skill.recentlyMissed) &&
    (filters.mode !== "SCHEDULED" || (skill.dueAt !== null && Date.parse(skill.dueAt) <= now)));
}
export function customExerciseCount(value: string): number | null {
  const count = Number(value);
  return value.trim() && Number.isInteger(count) && count >= 1 && count <= 100 ? count : null;
}
