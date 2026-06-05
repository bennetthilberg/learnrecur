import "server-only";

import {
  SkillStatus,
  type ExerciseVerificationStatus,
  type AnswerKind,
  type Prisma,
} from "@/generated/prisma/client";
import { isPracticeReadModelExerciseReady } from "@/lib/practice/read-model-eligibility";
import { getPrisma } from "@/lib/prisma";

export type SkillLifecycleInput = {
  userId: string;
  skillId: string;
};

export type SkillLifecycleUpdatedResult = {
  status: "updated";
  message: string;
  previousStatus: SkillStatus;
  skill: {
    id: string;
    status: SkillStatus;
  };
};

export type SkillLifecycleNotFoundResult = {
  status: "not-found";
  message: string;
};

export type SkillLifecycleInvalidTransitionResult = {
  status: "invalid-transition";
  message: string;
  currentStatus: SkillStatus;
};

export type SkillLifecycleResult =
  | SkillLifecycleUpdatedResult
  | SkillLifecycleNotFoundResult
  | SkillLifecycleInvalidTransitionResult;

type LifecycleSkillRecord = {
  id: string;
  status: SkillStatus;
  dueAt: Date | null;
  stability: number | null;
  difficulty: number | null;
  repetitions: number;
  exercises: Array<{
    answerKind: AnswerKind;
    verificationStatus: ExerciseVerificationStatus;
    retiredAt: Date | null;
    choices: Prisma.JsonValue | null;
    answerSpec: Prisma.JsonValue;
  }>;
};

export async function pauseSkill(input: SkillLifecycleInput): Promise<SkillLifecycleResult> {
  return transitionSkill({
    ...input,
    allowedStatuses: [SkillStatus.ACTIVE],
    nextStatus: SkillStatus.PAUSED,
    successMessage: "Skill paused. It will stay out of practice until resumed.",
    invalidMessage: "Only active skills can be paused.",
  });
}

export async function resumeSkill(input: SkillLifecycleInput): Promise<SkillLifecycleResult> {
  return transitionSkill({
    ...input,
    allowedStatuses: [SkillStatus.PAUSED],
    nextStatus: SkillStatus.ACTIVE,
    successMessage: "Skill resumed. It is back in the practice schedule.",
    invalidMessage: "Only paused skills can be resumed.",
  });
}

export async function archiveSkill(input: SkillLifecycleInput): Promise<SkillLifecycleResult> {
  return transitionSkill({
    ...input,
    allowedStatuses: [SkillStatus.DRAFT, SkillStatus.ACTIVE, SkillStatus.PAUSED],
    nextStatus: SkillStatus.ARCHIVED,
    successMessage: "Skill archived. Practice history and source links were preserved.",
    invalidMessage: "This skill cannot be archived from its current state.",
  });
}

export async function restoreArchivedSkill(
  input: SkillLifecycleInput,
): Promise<SkillLifecycleResult> {
  const prisma = getPrisma();
  const skill = await prisma.skill.findFirst({
    where: {
      id: input.skillId,
      userId: input.userId,
    },
    select: {
      id: true,
      status: true,
      dueAt: true,
      stability: true,
      difficulty: true,
      repetitions: true,
      exercises: {
        select: {
          answerKind: true,
          verificationStatus: true,
          retiredAt: true,
          choices: true,
          answerSpec: true,
        },
      },
    },
  });

  if (!skill) {
    return notFound();
  }

  if (skill.status !== SkillStatus.ARCHIVED) {
    return invalidTransition(skill.status, "Only archived skills can be restored.");
  }

  const nextStatus = shouldRestoreAsActive(skill) ? SkillStatus.ACTIVE : SkillStatus.DRAFT;
  const updateResult = await prisma.skill.updateMany({
    where: {
      id: input.skillId,
      userId: input.userId,
      status: skill.status,
    },
    data: {
      status: nextStatus,
    },
  });

  if (updateResult.count !== 1) {
    const current = await prisma.skill.findFirst({
      where: {
        id: input.skillId,
        userId: input.userId,
      },
      select: {
        status: true,
      },
    });

    return current
      ? invalidTransition(current.status, "Skill status changed before restore.")
      : notFound();
  }

  return {
    status: "updated",
    message:
      nextStatus === SkillStatus.ACTIVE
        ? "Skill restored to the active practice schedule."
        : "Skill restored as a draft for review.",
    previousStatus: skill.status,
    skill: {
      id: skill.id,
      status: nextStatus,
    },
  };
}

async function transitionSkill(input: {
  userId: string;
  skillId: string;
  allowedStatuses: readonly SkillStatus[];
  nextStatus: SkillStatus;
  successMessage: string;
  invalidMessage: string;
}): Promise<SkillLifecycleResult> {
  const prisma = getPrisma();
  const skill = await prisma.skill.findFirst({
    where: {
      id: input.skillId,
      userId: input.userId,
    },
    select: {
      id: true,
      status: true,
    },
  });

  if (!skill) {
    return notFound();
  }

  if (!input.allowedStatuses.includes(skill.status)) {
    return invalidTransition(skill.status, input.invalidMessage);
  }

  const updateResult = await prisma.skill.updateMany({
    where: {
      id: input.skillId,
      userId: input.userId,
      status: skill.status,
    },
    data: {
      status: input.nextStatus,
    },
  });

  if (updateResult.count !== 1) {
    const current = await prisma.skill.findFirst({
      where: {
        id: input.skillId,
        userId: input.userId,
      },
      select: {
        status: true,
      },
    });

    return current
      ? invalidTransition(current.status, "Skill status changed before update.")
      : notFound();
  }

  return {
    status: "updated",
    message: input.successMessage,
    previousStatus: skill.status,
    skill: {
      id: skill.id,
      status: input.nextStatus,
    },
  };
}

function shouldRestoreAsActive(skill: LifecycleSkillRecord): boolean {
  return (
    skill.dueAt !== null &&
    skill.stability !== null &&
    skill.difficulty !== null &&
    skill.exercises.some((exercise) => isPracticeReadModelExerciseReady(exercise, skill))
  );
}

function notFound(): SkillLifecycleNotFoundResult {
  return {
    status: "not-found",
    message: "Skill was not found.",
  };
}

function invalidTransition(
  currentStatus: SkillStatus,
  message: string,
): SkillLifecycleInvalidTransitionResult {
  return {
    status: "invalid-transition",
    message,
    currentStatus,
  };
}
