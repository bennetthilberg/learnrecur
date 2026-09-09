import "server-only";
import { isUsableChoicePresentation } from "@/lib/answer-checking";
import { AnswerKind } from "@/generated/prisma/client";

import {
  isExactInputUnlocked,
  isReadyChoiceExercise,
  isReadyExactInputExercise,
  isReadyMathExercise,
  type ChoiceExerciseInventoryRecord,
  type ExactInputExerciseInventoryRecord,
} from "@/lib/skills";
import {
  matchesTextPolicy,
  resolveTextPolicy,
  type TextPolicy,
} from "@/lib/practice/policies";

export type PracticeReadModelExercise = ChoiceExerciseInventoryRecord &
  ExactInputExerciseInventoryRecord;

export type PracticeReadModelSkill = {
  repetitions: number;
  alreadyStudied?: boolean;
  /**
   * When supplied, this is the already-resolved effective policy for the
   * skill. An explicit null means the stored policy was invalid and text
   * exercises must stay out of the practice read model until repaired.
   * Omitting the property preserves callers that do not load policy data.
   */
  textPolicy?: TextPolicy | null;
};

/**
 * Resolve the policy used by the practice read model without making a read
 * path throw because old or manually edited JSON is invalid. A null result
 * is deliberately different from an omitted policy: it suppresses text
 * inventory that cannot be proven compatible with the current rules.
 */
export function resolveReadModelTextPolicy(input: {
  skill?: unknown;
  collection?: unknown;
}): TextPolicy | null {
  try {
    return resolveTextPolicy(input);
  } catch {
    return null;
  }
}

export function isPracticeReadModelExerciseReady(
  exercise: PracticeReadModelExercise,
  skill: PracticeReadModelSkill,
): boolean {
  if (
    isReadyChoiceExercise(exercise) &&
    isUsableChoicePresentation(exercise.answerSpec, exercise.choices)
  ) {
    return true;
  }

  if (!isExactInputUnlocked(skill.repetitions, skill.alreadyStudied)) {
    return false;
  }

  if (
    exercise.answerKind === AnswerKind.TEXT &&
    skill.textPolicy !== undefined &&
    (skill.textPolicy === null ||
      !matchesTextPolicy(exercise.answerSpec, skill.textPolicy))
  ) {
    return false;
  }

  return isReadyExactInputExercise(exercise) || isReadyMathExercise(exercise);
}
