import { z } from "zod";

export const dailyNewSkillLimitSchema = z
  .number()
  .int()
  .min(0)
  .max(1000)
  .nullable();
export const practiceTimezoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((timezone) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: timezone });
      return true;
    } catch {
      return false;
    }
  }, "Choose a valid timezone.");

export function getPracticeLocalDate(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: string) =>
    parts.find((part) => part.type === type)!.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

type IntroductionEvidence = {
  firstIntroducedAt: Date | null;
  lastReviewedAt: Date | null;
  repetitions: number;
};
export function wasSkillIntroduced(skill: IntroductionEvidence): boolean {
  return (
    skill.firstIntroducedAt !== null ||
    skill.lastReviewedAt !== null ||
    skill.repetitions > 0
  );
}

// Read models describe available work without reserving an introduction.
export function countAvailablePracticeSkills(
  skills: readonly IntroductionEvidence[],
  remaining: number | null,
): number {
  if (remaining === null) return skills.length;
  const introduced = skills.filter(wasSkillIntroduced).length;
  return introduced + Math.min(remaining, skills.length - introduced);
}
