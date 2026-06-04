import "server-only";

import { AnswerKind, type Prisma } from "@/generated/prisma/client";
import { getNextPracticeItem } from "@/lib/practice";

import type { ChoiceOption, ChoicePracticeItem } from "./types";

const CHOICE_ANSWER_KINDS = [AnswerKind.CHOICE] as const;

export async function getNextChoicePracticeItemForUser(
  userId: string,
  now = new Date(),
): Promise<ChoicePracticeItem> {
  const result = await getNextPracticeItem({
    userId,
    now,
    answerKinds: CHOICE_ANSWER_KINDS,
  });

  if (result.status === "none-due") {
    return {
      status: "none-due",
      message: result.message,
    };
  }

  const parsedChoices = toChoiceOptions(result.exercise.choices);

  if (parsedChoices.length === 0) {
    return {
      status: "unavailable",
      message: "This exercise does not have valid answer choices.",
    };
  }

  return {
    status: "ready",
    skill: {
      id: result.skill.id,
      title: result.skill.title,
      fsrsState: result.skill.fsrsState,
      repetitions: result.skill.repetitions,
      lapses: result.skill.lapses,
    },
    exercise: {
      id: result.exercise.id,
      skillId: result.exercise.skillId,
      prompt: result.exercise.prompt,
      choices: parsedChoices,
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
