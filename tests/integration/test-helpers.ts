import {
  AnswerKind,
  ExerciseRetirementReason,
  ExerciseType,
  ExerciseVerificationStatus,
  type Prisma,
  SkillStatus,
} from "@/generated/prisma/client";
import type { getPrisma } from "@/lib/prisma";
import { createInitialSkillSchedule } from "@/lib/scheduling";

type TestPrismaClient = ReturnType<typeof getPrisma>;

export const DEFAULT_TEST_DUE_AT = new Date("2026-06-03T09:00:00.000Z");

export async function createSkillFixture(
  prisma: TestPrismaClient,
  {
    userId,
    title,
    collectionId,
    dueAt = DEFAULT_TEST_DUE_AT,
    status = SkillStatus.ACTIVE,
    initialized = true,
    repetitions = 0,
    tags = [],
    objective,
  }: {
    userId: string;
    title: string;
    collectionId?: string | null;
    dueAt?: Date;
    status?: SkillStatus;
    initialized?: boolean;
    repetitions?: number;
    tags?: string[];
    objective?: string | null;
  },
) {
  const schedule =
    status === SkillStatus.ACTIVE && initialized ? createInitialSkillSchedule(dueAt) : {};

  return prisma.skill.create({
    data: {
      userId,
      collectionId,
      title,
      objective:
        objective === undefined ? `${title} objective for a compact practice target.` : objective,
      tags,
      status,
      ...schedule,
      repetitions,
    },
  });
}

export async function createTextExercise(
  prisma: TestPrismaClient,
  userId: string,
  skillId: string,
  {
    answerSpec = {
      kind: "text",
      accepted: ["right"],
    },
    verificationStatus = ExerciseVerificationStatus.VERIFIED,
    retiredAt = null,
  }: {
    answerSpec?: Prisma.InputJsonValue;
    verificationStatus?: ExerciseVerificationStatus;
    retiredAt?: Date | null;
  } = {},
) {
  return prisma.exercise.create({
    data: {
      userId,
      skillId,
      type: ExerciseType.EXACT_INPUT,
      answerKind: AnswerKind.TEXT,
      prompt: "Type the right answer.",
      answerSpec,
      correctAnswerDisplay: "right",
      verificationStatus,
      retiredAt,
      retirementReason: retiredAt ? ExerciseRetirementReason.MANUAL : null,
    },
  });
}

type NumericExerciseOverrides = Partial<
  Pick<
    Prisma.ExerciseUncheckedCreateInput,
    | "prompt"
    | "answerSpec"
    | "correctAnswerDisplay"
    | "verificationStatus"
    | "retiredAt"
    | "retirementReason"
    | "difficulty"
    | "expectedSeconds"
  >
>;

export async function createNumericExercise(
  prisma: TestPrismaClient,
  userId: string,
  skillId: string,
  overrides: NumericExerciseOverrides = {},
) {
  const retiredAt = overrides.retiredAt ?? null;

  return prisma.exercise.create({
    data: {
      userId,
      skillId,
      type: ExerciseType.EXACT_INPUT,
      answerKind: AnswerKind.NUMERIC,
      prompt: "Enter one half.",
      answerSpec: {
        kind: "numeric",
        accepted: ["1/2", 0.5],
        tolerance: 0,
      },
      correctAnswerDisplay: "0.5",
      verificationStatus: ExerciseVerificationStatus.VERIFIED,
      retiredAt,
      retirementReason: retiredAt ? ExerciseRetirementReason.MANUAL : null,
      ...overrides,
    },
  });
}
