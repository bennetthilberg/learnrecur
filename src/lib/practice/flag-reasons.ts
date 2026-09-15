import { ExerciseFlagReason } from "@/generated/prisma/enums";

export const FLAG_REASON_OPTIONS: Array<{ reason: ExerciseFlagReason; label: string }> = [
  {
    reason: ExerciseFlagReason.INCORRECT_ANSWER,
    label: "Correct answer seems wrong",
  },
  {
    reason: ExerciseFlagReason.UNCLEAR_PROMPT,
    label: "Prompt is unclear",
  },
  {
    reason: ExerciseFlagReason.UNFAIR,
    label: "Feels unfair or tricky",
  },
  {
    reason: ExerciseFlagReason.STALE,
    label: "Stale or outdated",
  },
  {
    reason: ExerciseFlagReason.NOT_USEFUL,
    label: "Not useful for this skill",
  },
  {
    reason: ExerciseFlagReason.OFF_TOPIC,
    label: "Off topic",
  },
  {
    reason: ExerciseFlagReason.OTHER,
    label: "Something else",
  },
];
