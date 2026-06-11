import "server-only";

import { AnswerKind, CollectionStatus, type Prisma } from "@/generated/prisma/client";
import { getNextPracticeItem } from "@/lib/practice";
import { getPrisma } from "@/lib/prisma";

import type { ChoiceOption, PracticeItem, PracticeScope } from "./types";

const CHOICE_ANSWER_KINDS = [AnswerKind.CHOICE] as const;
const PRACTICE_ANSWER_KINDS = [
  AnswerKind.CHOICE,
  AnswerKind.TEXT,
  AnswerKind.NUMERIC,
  AnswerKind.MATH,
] as const;
const COLLECTION_SCOPE_UNAVAILABLE_MESSAGE =
  "That collection is not available for practice.";

export type PracticeScopeInput = {
  collectionId?: string | null;
};

type PracticeScopeResult =
  | {
      status: "ready";
      scope: PracticeScope;
      collectionId?: string;
    }
  | {
      status: "unavailable";
      message: string;
    };

export async function getNextChoicePracticeItemForUser(
  userId: string,
  now = new Date(),
  scopeInput: PracticeScopeInput = {},
): Promise<PracticeItem> {
  const scope = await resolvePracticeScopeForUser(userId, scopeInput);

  if (scope.status === "unavailable") {
    return {
      status: "unavailable",
      message: scope.message,
    };
  }

  const result = await getNextPracticeItem({
    userId,
    now,
    answerKinds: CHOICE_ANSWER_KINDS,
    collectionId: scope.collectionId,
  });

  return toPracticeItem(result, scope.scope);
}

export async function getNextPracticeItemForUser(
  userId: string,
  now = new Date(),
  scopeInput: PracticeScopeInput = {},
): Promise<PracticeItem> {
  const scope = await resolvePracticeScopeForUser(userId, scopeInput);

  if (scope.status === "unavailable") {
    return {
      status: "unavailable",
      message: scope.message,
    };
  }

  const result = await getNextPracticeItem({
    userId,
    now,
    answerKinds: PRACTICE_ANSWER_KINDS,
    collectionId: scope.collectionId,
  });

  return toPracticeItem(result, scope.scope);
}

export async function resolvePracticeScopeForUser(
  userId: string,
  input: PracticeScopeInput = {},
): Promise<PracticeScopeResult> {
  if (!input.collectionId) {
    return {
      status: "ready",
      scope: {
        kind: "all",
      },
    };
  }

  const collection = await getPrisma().collection.findFirst({
    where: {
      id: input.collectionId,
      userId,
      status: CollectionStatus.ACTIVE,
    },
    select: {
      id: true,
      name: true,
    },
  });

  if (!collection) {
    return {
      status: "unavailable",
      message: COLLECTION_SCOPE_UNAVAILABLE_MESSAGE,
    };
  }

  return {
    status: "ready",
    collectionId: collection.id,
    scope: {
      kind: "collection",
      collectionId: collection.id,
      collectionName: collection.name,
    },
  };
}

function toPracticeItem(
  result: Awaited<ReturnType<typeof getNextPracticeItem>>,
  scope: PracticeScope,
): PracticeItem {
  if (result.status === "none-due") {
    return {
      status: "none-due",
      message:
        scope.kind === "collection"
          ? `No due exercise is ready in ${scope.collectionName}.`
          : result.message,
      scope,
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
        scope,
      };
    }

    return {
      status: "ready",
      scope,
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
    result.exercise.answerKind !== AnswerKind.NUMERIC &&
    result.exercise.answerKind !== AnswerKind.MATH
  ) {
    return {
      status: "unavailable",
      message: "This exercise type is not available in practice yet.",
      scope,
    };
  }

  return {
    status: "ready",
    scope,
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
