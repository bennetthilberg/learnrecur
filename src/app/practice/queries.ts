import "server-only";

import { AnswerKind, type Prisma } from "@/generated/prisma/client";
import { getNextPracticeItem } from "@/lib/practice";

import type { ChoiceOption, PracticeItem } from "./types";

const CHOICE_ANSWER_KINDS = [AnswerKind.CHOICE] as const;
const PRACTICE_ANSWER_KINDS = [AnswerKind.CHOICE, AnswerKind.TEXT, AnswerKind.NUMERIC] as const;

export async function getNextChoicePracticeItemForUser(
  userId: string,
  now = new Date(),
): Promise<PracticeItem> {
  const result = await getNextPracticeItem({
    userId,
    now,
    answerKinds: CHOICE_ANSWER_KINDS,
  });

  return toPracticeItem(result);
}

export async function getNextPracticeItemForUser(
  userId: string,
  now = new Date(),
): Promise<PracticeItem> {
  const result = await getNextPracticeItem({
    userId,
    now,
    answerKinds: PRACTICE_ANSWER_KINDS,
  });

  return toPracticeItem(result);
}

function toPracticeItem(
  result: Awaited<ReturnType<typeof getNextPracticeItem>>,
): PracticeItem {
  if (result.status === "none-due") {
    return {
      status: "none-due",
      message: result.message,
    };
  }

  const skill = {
    id: result.skill.id,
    title: result.skill.title,
    fsrsState: result.skill.fsrsState,
    repetitions: result.skill.repetitions,
    lapses: result.skill.lapses,
  };

  if (result.exercise.answerKind === AnswerKind.CHOICE) {
    const parsedChoices = toChoiceOptions(result.exercise.choices);

    if (
      !Array.isArray(result.exercise.choices) ||
      result.exercise.choices.length === 0 ||
      parsedChoices.length !== result.exercise.choices.length
    ) {
      return {
        status: "unavailable",
        message: "This exercise does not have valid answer choices.",
      };
    }

    return {
      status: "ready",
      skill,
      exercise: {
        id: result.exercise.id,
        skillId: result.exercise.skillId,
        answerKind: result.exercise.answerKind,
        prompt: result.exercise.prompt,
        choices: parsedChoices,
        difficulty: result.exercise.difficulty,
        expectedSeconds: result.exercise.expectedSeconds,
      },
    };
  }

  if (
    result.exercise.answerKind !== AnswerKind.TEXT &&
    result.exercise.answerKind !== AnswerKind.NUMERIC
  ) {
    return {
      status: "unavailable",
      message: "This exercise type is not available in practice yet.",
    };
  }

  return {
    status: "ready",
    skill,
    exercise: {
      id: result.exercise.id,
      skillId: result.exercise.skillId,
      answerKind: result.exercise.answerKind,
      prompt: result.exercise.prompt,
      difficulty: result.exercise.difficulty,
      expectedSeconds: result.exercise.expectedSeconds,
    },
  };
}

function toChoiceOptions(choices: Prisma.JsonValue | null): ChoiceOption[] {
  if (!Array.isArray(choices)) {
    return [];
  }

  return choices.flatMap((choice) => {
    if (
      typeof choice === "object" &&
      choice !== null &&
      !Array.isArray(choice) &&
      typeof choice.id === "string" &&
      typeof choice.label === "string"
    ) {
      return [
        {
          id: choice.id,
          label: choice.label,
        },
      ];
    }

    return [];
  });
}
