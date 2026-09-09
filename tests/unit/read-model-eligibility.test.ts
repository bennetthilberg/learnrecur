import { describe, expect, it } from "vitest";

import {
  AnswerKind,
  ExerciseVerificationStatus,
} from "@/generated/prisma/client";
import {
  isPracticeReadModelExerciseReady,
  resolveReadModelTextPolicy,
} from "@/lib/practice/read-model-eligibility";
import {
  EXACT_TEXT_POLICY,
  NATURAL_TEXT_POLICY,
  textAnswerContract,
} from "@/lib/practice/policies";

function textExercise(
  answerSpec = textAnswerContract(["right"], NATURAL_TEXT_POLICY),
) {
  return {
    answerKind: AnswerKind.TEXT,
    verificationStatus: ExerciseVerificationStatus.VERIFIED,
    retiredAt: null,
    choices: null,
    answerSpec,
  };
}

describe("practice read-model eligibility", () => {
  it("keeps exact-input exercises locked until the skill is introduced", () => {
    const exercise = textExercise();

    expect(
      isPracticeReadModelExerciseReady(exercise, {
        repetitions: 0,
        alreadyStudied: false,
        textPolicy: NATURAL_TEXT_POLICY,
      }),
    ).toBe(false);
    expect(
      isPracticeReadModelExerciseReady(exercise, {
        repetitions: 0,
        alreadyStudied: true,
        textPolicy: NATURAL_TEXT_POLICY,
      }),
    ).toBe(true);
  });

  it("rejects text inventory whose saved answer contract does not match the effective policy", () => {
    const naturalExercise = textExercise();
    const exactExercise = textExercise(
      textAnswerContract(["right"], EXACT_TEXT_POLICY),
    );

    expect(
      isPracticeReadModelExerciseReady(naturalExercise, {
        repetitions: 3,
        alreadyStudied: false,
        textPolicy: EXACT_TEXT_POLICY,
      }),
    ).toBe(false);
    expect(
      isPracticeReadModelExerciseReady(exactExercise, {
        repetitions: 3,
        alreadyStudied: false,
        textPolicy: EXACT_TEXT_POLICY,
      }),
    ).toBe(true);
  });

  it("returns null for invalid stored policy JSON so callers can show repair state", () => {
    expect(resolveReadModelTextPolicy({ skill: { version: 3 } })).toBeNull();
    expect(
      resolveReadModelTextPolicy({ collection: EXACT_TEXT_POLICY }),
    ).toEqual(EXACT_TEXT_POLICY);
  });
});
