import "server-only";
import { isUsableChoicePresentation } from "@/lib/answer-checking";

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
  if (isReadyChoiceExercise(exercise) && isUsableChoicePresentation(exercise.answerSpec, exercise.choices)) {
    return true;
  }

  if (!isExactInputUnlocked(skill.repetitions, skill.alreadyStudied)) {
    return false;
  }

  return isReadyExactInputExercise(exercise) || isReadyMathExercise(exercise);
}
