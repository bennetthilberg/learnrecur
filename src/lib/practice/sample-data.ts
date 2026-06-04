import "server-only";

import {
  AnswerKind,
  CollectionStatus,
  ExerciseType,
  ExerciseVerificationStatus,
  SkillStatus,
} from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import { createInitialSkillSchedule } from "@/lib/scheduling";

const SAMPLE_COLLECTION_NAME = "LearnRecur samples";
const SAMPLE_TAG = "learnrecur-sample";
const SAMPLE_FRESHNESS_PREFIX = "learnrecur-sample";

export type EnsureDevPracticeSampleDataInput = {
  userId: string;
  now?: Date;
};

export type EnsureDevPracticeSampleDataResult =
  | {
      status: "ready";
      collectionId: string;
      skillCount: number;
      exerciseCount: number;
      message: string;
    }
  | {
      status: "disabled";
      message: string;
    };

type SampleExerciseSeed = {
  key: string;
  prompt: string;
  choices: Array<{ id: string; label: string }>;
  correctChoiceId: string;
  correctAnswerDisplay: string;
  explanation: string;
  difficulty: number;
  expectedSeconds: number;
};

type SampleSkillSeed = {
  key: string;
  title: string;
  objective: string;
  tags: string[];
  exercises: SampleExerciseSeed[];
};

const SAMPLE_SKILLS: SampleSkillSeed[] = [
  {
    key: "ser-estar-identity-location",
    title: "Ser vs. estar for identity and location",
    objective: "Choose ser for identity and estar for location in short Spanish sentences.",
    tags: [SAMPLE_TAG, "spanish", "grammar"],
    exercises: [
      {
        key: "profession",
        prompt: "Choose the verb that best completes the sentence: Ella ___ profesora.",
        choices: [
          { id: "ser", label: "es" },
          { id: "estar", label: "está" },
          { id: "tener", label: "tiene" },
        ],
        correctChoiceId: "ser",
        correctAnswerDisplay: "es",
        explanation: "Use ser for identity and profession.",
        difficulty: 1,
        expectedSeconds: 18,
      },
      {
        key: "location",
        prompt: "Choose the verb that best completes the sentence: El libro ___ en la mesa.",
        choices: [
          { id: "ser", label: "es" },
          { id: "estar", label: "está" },
          { id: "hacer", label: "hace" },
        ],
        correctChoiceId: "estar",
        correctAnswerDisplay: "está",
        explanation: "Use estar for physical location.",
        difficulty: 1,
        expectedSeconds: 18,
      },
    ],
  },
  {
    key: "ser-estar-condition-trait",
    title: "Ser vs. estar for traits and conditions",
    objective: "Choose ser for stable traits and estar for temporary conditions.",
    tags: [SAMPLE_TAG, "spanish", "grammar"],
    exercises: [
      {
        key: "temporary-condition",
        prompt: "Choose the verb that best completes the sentence: Hoy nosotros ___ cansados.",
        choices: [
          { id: "ser", label: "somos" },
          { id: "estar", label: "estamos" },
          { id: "ir", label: "vamos" },
        ],
        correctChoiceId: "estar",
        correctAnswerDisplay: "estamos",
        explanation: "Use estar for a temporary condition such as being tired today.",
        difficulty: 2,
        expectedSeconds: 22,
      },
    ],
  },
];

export async function ensureDevPracticeSampleData(
  input: EnsureDevPracticeSampleDataInput,
): Promise<EnsureDevPracticeSampleDataResult> {
  if (process.env.NODE_ENV === "production") {
    return {
      status: "disabled",
      message: "Sample practice data is disabled in production.",
    };
  }

  const prisma = getPrisma();
  const now = input.now ?? new Date();
  const schedule = createInitialSkillSchedule(now);
  const collection =
    (await prisma.collection.findFirst({
      where: {
        userId: input.userId,
        name: SAMPLE_COLLECTION_NAME,
      },
    })) ??
    (await prisma.collection.create({
      data: {
        userId: input.userId,
        name: SAMPLE_COLLECTION_NAME,
        description: "Small local development sample set for the first practice flow.",
        status: CollectionStatus.ACTIVE,
      },
    }));

  for (const skillSeed of SAMPLE_SKILLS) {
    const existingSkill = await prisma.skill.findFirst({
      where: {
        userId: input.userId,
        title: skillSeed.title,
        tags: { has: SAMPLE_TAG },
      },
    });

    const skill = existingSkill
      ? await prisma.skill.update({
          where: { id: existingSkill.id },
          data: {
            collectionId: collection.id,
            objective: skillSeed.objective,
            tags: skillSeed.tags,
            status: SkillStatus.ACTIVE,
            ...schedule,
          },
        })
      : await prisma.skill.create({
          data: {
            userId: input.userId,
            collectionId: collection.id,
            title: skillSeed.title,
            objective: skillSeed.objective,
            tags: skillSeed.tags,
            status: SkillStatus.ACTIVE,
            ...schedule,
          },
        });

    for (const exerciseSeed of skillSeed.exercises) {
      const freshnessKey = `${SAMPLE_FRESHNESS_PREFIX}:${skillSeed.key}:${exerciseSeed.key}`;
      const existingExercise = await prisma.exercise.findFirst({
        where: {
          userId: input.userId,
          freshnessKey,
        },
      });
      const data = {
        skillId: skill.id,
        type: ExerciseType.MULTIPLE_CHOICE,
        answerKind: AnswerKind.CHOICE,
        prompt: exerciseSeed.prompt,
        choices: exerciseSeed.choices,
        answerSpec: {
          kind: "choice",
          correctChoiceId: exerciseSeed.correctChoiceId,
        },
        correctAnswerDisplay: exerciseSeed.correctAnswerDisplay,
        explanation: exerciseSeed.explanation,
        difficulty: exerciseSeed.difficulty,
        expectedSeconds: exerciseSeed.expectedSeconds,
        verificationStatus: ExerciseVerificationStatus.VERIFIED,
        retiredAt: null,
        retirementReason: null,
        freshnessKey,
      };

      if (existingExercise) {
        await prisma.exercise.update({
          where: { id: existingExercise.id },
          data,
        });
      } else {
        await prisma.exercise.create({
          data: {
            userId: input.userId,
            ...data,
          },
        });
      }
    }
  }

  const [skillCount, exerciseCount] = await Promise.all([
    prisma.skill.count({
      where: {
        userId: input.userId,
        tags: { has: SAMPLE_TAG },
      },
    }),
    prisma.exercise.count({
      where: {
        userId: input.userId,
        freshnessKey: { startsWith: `${SAMPLE_FRESHNESS_PREFIX}:` },
      },
    }),
  ]);

  return {
    status: "ready",
    collectionId: collection.id,
    skillCount,
    exerciseCount,
    message: "Sample practice is ready.",
  };
}
