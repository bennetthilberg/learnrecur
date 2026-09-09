import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  AnswerKind,
  ExerciseType,
  ExerciseVerificationStatus,
  Prisma,
} from "@/generated/prisma/client";
import { isPracticeReadModelExerciseReady, resolveReadModelTextPolicy } from "@/lib/practice/read-model-eligibility";
import {
  buildReadyExerciseSql,
  DEFAULT_READY_TEXT_POLICY_SQL,
} from "@/lib/practice/readiness-sql";
import {
  EXACT_TEXT_POLICY,
  NATURAL_TEXT_POLICY,
  textAnswerContract,
} from "@/lib/practice/policies";
import { getPrisma } from "@/lib/prisma";

import { createSkillFixture } from "./test-helpers";

const suite = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;

type ReadinessCase = {
  name: string;
  answerKind: AnswerKind;
  answerSpec: Prisma.InputJsonValue;
  choices?: Prisma.InputJsonValue;
  repetitions?: number;
  alreadyStudied?: boolean;
  textPolicy?: Prisma.InputJsonValue;
  verificationStatus?: ExerciseVerificationStatus;
  retiredAt?: Date | null;
  expected: boolean;
};

const readinessCases: ReadinessCase[] = [
  {
    name: "locked choice remains ready",
    answerKind: AnswerKind.CHOICE,
    answerSpec: { kind: "choice", correctChoiceId: "right" },
    choices: [
      { id: "right", label: "Right" },
      { id: "wrong", label: "Wrong" },
    ],
    expected: true,
  },
  {
    name: "choice identifiers use canonical trimming",
    answerKind: AnswerKind.CHOICE,
    answerSpec: { kind: "choice", correctChoiceId: " right " },
    choices: [
      { id: " right ", label: "Right" },
      { id: "wrong", label: "Wrong" },
    ],
    expected: true,
  },
  {
    name: "locked text remains unavailable",
    answerKind: AnswerKind.TEXT,
    answerSpec: textAnswerContract(["right"], NATURAL_TEXT_POLICY),
    expected: false,
  },
  {
    name: "already studied unlocks text",
    answerKind: AnswerKind.TEXT,
    answerSpec: textAnswerContract(["right"], NATURAL_TEXT_POLICY),
    alreadyStudied: true,
    expected: true,
  },
  {
    name: "matching exact policy unlocks text",
    answerKind: AnswerKind.TEXT,
    answerSpec: textAnswerContract(["right"], EXACT_TEXT_POLICY),
    repetitions: 3,
    textPolicy: EXACT_TEXT_POLICY,
    expected: true,
  },
  {
    name: "natural answer does not satisfy exact policy",
    answerKind: AnswerKind.TEXT,
    answerSpec: textAnswerContract(["right"], NATURAL_TEXT_POLICY),
    repetitions: 3,
    textPolicy: EXACT_TEXT_POLICY,
    expected: false,
  },
  {
    name: "valid numeric string is ready",
    answerKind: AnswerKind.NUMERIC,
    answerSpec: { kind: "numeric", accepted: ["1/2"] },
    repetitions: 3,
    expected: true,
  },
  {
    name: "valid math expression is ready",
    answerKind: AnswerKind.MATH,
    answerSpec: { kind: "math", acceptedExpressions: ["2x"] },
    repetitions: 3,
    expected: true,
  },
  {
    name: "unknown numeric accepted shape is rejected",
    answerKind: AnswerKind.NUMERIC,
    answerSpec: { kind: "numeric", accepted: [{ value: 1, junk: true }] },
    repetitions: 3,
    expected: false,
  },
  {
    name: "numeric string value is rejected without a cast error",
    answerKind: AnswerKind.NUMERIC,
    answerSpec: { kind: "numeric", accepted: [{ type: "integer", value: "1" }] },
    repetitions: 3,
    expected: false,
  },
  {
    name: "numeric fraction fields are rejected without a cast error",
    answerKind: AnswerKind.NUMERIC,
    answerSpec: {
      kind: "numeric",
      accepted: [{ type: "fraction", numerator: "1", denominator: 2 }],
    },
    repetitions: 3,
    expected: false,
  },
  {
    name: "null numeric value is rejected",
    answerKind: AnswerKind.NUMERIC,
    answerSpec: { kind: "numeric", accepted: [null] },
    repetitions: 3,
    expected: false,
  },
  {
    name: "oversized exponent number is rejected",
    answerKind: AnswerKind.NUMERIC,
    answerSpec: { kind: "numeric", accepted: [1e64] },
    repetitions: 3,
    expected: false,
  },
  {
    name: "non-string math expression is rejected",
    answerKind: AnswerKind.MATH,
    answerSpec: { kind: "math", acceptedExpressions: [123] },
    repetitions: 3,
    expected: false,
  },
  {
    name: "retired inventory is rejected",
    answerKind: AnswerKind.CHOICE,
    answerSpec: { kind: "choice", correctChoiceId: "right" },
    choices: [{ id: "right", label: "Right" }],
    repetitions: 3,
    retiredAt: new Date("2026-09-01T00:00:00.000Z"),
    expected: false,
  },
  {
    name: "unverified inventory is rejected",
    answerKind: AnswerKind.CHOICE,
    answerSpec: { kind: "choice", correctChoiceId: "right" },
    choices: [{ id: "right", label: "Right" }],
    repetitions: 3,
    verificationStatus: ExerciseVerificationStatus.UNVERIFIED,
    expected: false,
  },
];

suite("readiness SQL parity", () => {
  const prisma = getPrisma();
  const userId = `readiness_sql_${randomUUID()}`;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId } });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it.each(readinessCases)("$name matches canonical TypeScript readiness", async (fixture) => {
    const collection = fixture.textPolicy
      ? await prisma.collection.create({
          data: {
            userId,
            name: `${fixture.name} collection`,
            textPolicy: fixture.textPolicy,
          },
        })
      : null;
    const skill = await createSkillFixture(prisma, {
      userId,
      title: fixture.name,
      collectionId: collection?.id,
      repetitions: fixture.repetitions ?? 0,
    });
    if (fixture.alreadyStudied) {
      await prisma.skill.update({
        where: { id: skill.id },
        data: { alreadyStudied: true },
      });
    }
    const exercise = await prisma.exercise.create({
      data: {
        userId,
        skillId: skill.id,
        type:
          fixture.answerKind === AnswerKind.CHOICE
            ? ExerciseType.MULTIPLE_CHOICE
            : ExerciseType.EXACT_INPUT,
        answerKind: fixture.answerKind,
        prompt: fixture.name,
        choices: fixture.choices,
        answerSpec: fixture.answerSpec,
        correctAnswerDisplay: "right",
        verificationStatus: fixture.verificationStatus ?? ExerciseVerificationStatus.VERIFIED,
        retiredAt: fixture.retiredAt ?? null,
      },
    });
    const storedSkill = await prisma.skill.findUniqueOrThrow({
      where: { id: skill.id },
    });
    const storedCollection = collection
      ? await prisma.collection.findUniqueOrThrow({ where: { id: collection.id } })
      : null;
    const effectivePolicy = resolveReadModelTextPolicy({
      skill: storedSkill.textPolicy,
      collection: storedCollection?.textPolicy,
    });
    const canonical = isPracticeReadModelExerciseReady(exercise, {
      repetitions: storedSkill.repetitions,
      alreadyStudied: storedSkill.alreadyStudied,
      textPolicy: effectivePolicy,
    });
    expect(canonical).toBe(fixture.expected);

    const [row] = await prisma.$queryRaw<Array<{ ready: boolean | null }>>`
      SELECT ${buildReadyExerciseSql({
        repetitions: Prisma.sql`s."repetitions"`,
        alreadyStudied: Prisma.sql`s."alreadyStudied"`,
        textPolicy: Prisma.sql`COALESCE(
          s."textPolicy",
          c."textPolicy",
          ${DEFAULT_READY_TEXT_POLICY_SQL}
        )`,
      })} AS ready
      FROM "exercises" e
      INNER JOIN "skills" s ON s."id" = e."skillId" AND s."userId" = e."userId"
      LEFT JOIN "collections" c ON c."id" = s."collectionId" AND c."userId" = s."userId"
      WHERE e."id" = ${exercise.id}
    `;
    expect(row?.ready ?? false).toBe(canonical);
  });
});
