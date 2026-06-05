import "server-only";

import {
  isExactInputUnlocked,
  isReadyChoiceExercise,
  isReadyExactInputExercise,
  type ChoiceExerciseInventoryRecord,
  type ExactInputExerciseInventoryRecord,
} from "@/lib/skills";

export type PracticeReadModelExercise = ChoiceExerciseInventoryRecord &
  ExactInputExerciseInventoryRecord;

export type PracticeReadModelSkill = {
  repetitions: number;
};

export function isPracticeReadModelExerciseReady(
  exercise: PracticeReadModelExercise,
  skill: PracticeReadModelSkill,
): boolean {
  if (isReadyChoiceExercise(exercise)) {
    return true;
  }

  if (!isExactInputUnlocked(skill.repetitions)) {
    return false;
  }

  return isReadyExactInputExercise(exercise);
}
