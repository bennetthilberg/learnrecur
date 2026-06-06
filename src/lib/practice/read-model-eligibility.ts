import "server-only";

import { AnswerKind, ExerciseVerificationStatus } from "@/generated/prisma/client";
import { isUsableMathAnswerSpec } from "@/lib/answer-checking";
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

  return isReadyExactInputExercise(exercise) || isReadyMathExercise(exercise);
}

function isReadyMathExercise(exercise: PracticeReadModelExercise): boolean {
  return (
    exercise.answerKind === AnswerKind.MATH &&
    exercise.verificationStatus === ExerciseVerificationStatus.VERIFIED &&
    exercise.retiredAt === null &&
    isUsableMathAnswerSpec(exercise.answerSpec)
  );
}
