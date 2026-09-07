import "server-only";

import {
  isExactInputUnlocked,
  isReadyChoiceExercise,
  isReadyExactInputExercise,
  isReadyMathExercise,
  type ChoiceExerciseInventoryRecord,
  type ExactInputExerciseInventoryRecord,
} from "@/lib/skills";

export type PracticeReadModelExercise = ChoiceExerciseInventoryRecord &
  ExactInputExerciseInventoryRecord;

export type PracticeReadModelSkill = {
  repetitions: number;
  alreadyStudied?: boolean;
};

export function isPracticeReadModelExerciseReady(
  exercise: PracticeReadModelExercise,
  skill: PracticeReadModelSkill,
): boolean {
  if (isReadyChoiceExercise(exercise)) {
    return true;
  }

  if (!isExactInputUnlocked(skill.repetitions, skill.alreadyStudied)) {
    return false;
  }

  return isReadyExactInputExercise(exercise) || isReadyMathExercise(exercise);
}
