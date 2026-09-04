import { neon } from "@neondatabase/serverless";
import { randomUUID } from "node:crypto";

const E2E_EXACT_INPUT_UNLOCK_REPETITIONS = 3;

export const E2E_PRACTICE_KINDS = [
  "choice",
  "text",
  "numeric",
  "math",
] as const;
export type E2EPracticeKind = (typeof E2E_PRACTICE_KINDS)[number];

export type E2EPracticeExerciseFixture = {
  id: string;
  answerKind: E2EPracticeKind;
  correctAnswerDisplay: string;
  correctChoiceId: string | null;
  prompt: string;
  testAnswer: string;
};

export type E2EPracticeScenarioFixture = {
  userId: string;
  kind: E2EPracticeKind;
  collectionId: string;
  collectionName: string;
  collectionIds: string[];
  skillId: string;
  skillTitle: string;
  objective: string;
  skillIds: string[];
  exercise: E2EPracticeExerciseFixture;
  exercises: E2EPracticeExerciseFixture[];
  exerciseIds: string[];
};

export type E2ELearnerLifecycleFixture = {
  userId: string;
  runKey: string;
  scenarios: Record<E2EPracticeKind, E2EPracticeScenarioFixture>;
  collectionIds: string[];
  skillIds: string[];
  exerciseIds: string[];
};

export type E2EPracticeState = {
  dueAt: string | null;
  stability: number | null;
  difficulty: number | null;
  repetitions: number;
  lapses: number;
  fsrsState: string;
  lastReviewedAt: string | null;
  attemptCount: number;
  reviewLogCount: number;
  latestAttempt: {
    normalizedAnswer: string | null;
    isCorrect: boolean;
    result: string;
    finalRating: string | null;
  } | null;
  latestReview: {
    finalRating: string;
    nextDueAt: string | null;
  } | null;
};

export type E2EFlagState = {
  retiredAt: string | null;
  retirementReason: string | null;
  flagCount: number;
  attemptCount: number;
  reviewLogCount: number;
};

export async function deleteDatabaseTestUsers(userIds: string[]) {
  if (userIds.length === 0) {
    return;
  }

  const sql = getTestSql();
  await sql.query('DELETE FROM "users" WHERE "id" = ANY($1::text[])', [
    userIds,
  ]);
}

export async function createPrivateSkillFixture(input: {
  email: string;
  runId: string;
  userId: string;
}) {
  const sql = getTestSql();
  const now = new Date();
  const skillId = `e2e_${randomUUID().replaceAll("-", "")}`;

  await sql.query(
    `INSERT INTO "users" ("id", "email", "name", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT ("id") DO UPDATE SET "email" = EXCLUDED."email", "name" = EXCLUDED."name", "updatedAt" = EXCLUDED."updatedAt"`,
    [input.userId, input.email, "Other E2E learner", now],
  );
  await sql.query(
    `INSERT INTO "skills" ("id", "userId", "title", "objective", "tags", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5::text[], $6, $6)`,
    [
      skillId,
      input.userId,
      `Private E2E skill ${input.runId}`,
      "A private skill owned by another test learner.",
      [],
      now,
    ],
  );

  return skillId;
}

export async function createLearnerLifecycleFixture(input: {
  email: string;
  runId: string;
  userId: string;
}): Promise<E2ELearnerLifecycleFixture> {
  const scenarios = {} as Record<E2EPracticeKind, E2EPracticeScenarioFixture>;

  for (const kind of E2E_PRACTICE_KINDS) {
    scenarios[kind] = await createE2EPracticeScenario({
      email: input.email,
      kind,
      runId: input.runId,
      userId: input.userId,
    });
  }

  const fixture: E2ELearnerLifecycleFixture = {
    userId: input.userId,
    runKey: input.runId,
    scenarios,
    collectionIds: [],
    skillIds: [],
    exerciseIds: [],
  };

  for (const kind of E2E_PRACTICE_KINDS) {
    const scenario = scenarios[kind];
    fixture.collectionIds.push(...scenario.collectionIds);
    fixture.skillIds.push(...scenario.skillIds);
    fixture.exerciseIds.push(...scenario.exerciseIds);
  }

  return fixture;
}

export async function createE2EPracticeScenario(input: {
  email: string;
  exerciseCount?: number;
  kind: E2EPracticeKind;
  runId: string;
  userId: string;
}): Promise<E2EPracticeScenarioFixture> {
  const exerciseCount = input.exerciseCount ?? 1;
  if (
    !Number.isInteger(exerciseCount) ||
    exerciseCount < 1 ||
    exerciseCount > 5
  ) {
    throw new Error(
      "E2E fixture exerciseCount must be an integer between 1 and 5.",
    );
  }

  const sql = getTestSql();
  const now = new Date();
  const fixtureKey = `${input.runId}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const collectionId = `e2e_collection_${randomUUID().replaceAll("-", "")}`;
  const skillId = `e2e_skill_${randomUUID().replaceAll("-", "")}`;
  const collectionName = `E2E ${input.kind} collection ${fixtureKey}`;
  const skillTitle = `E2E ${input.kind} skill ${fixtureKey}`;
  const objective = `Deterministic ${input.kind} practice fixture for authenticated browser tests.`;
  const dueAt = new Date(now.getTime() - 5 * 60 * 1_000);
  const schedule = getE2ESchedule(input.kind, dueAt);

  await ensureE2EUser(sql, {
    email: input.email,
    id: input.userId,
    name: "LearnRecur E2E learner",
    now,
  });

  await sql.query(
    `INSERT INTO "collections" ("id", "userId", "name", "description", "status", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $5)`,
    [
      collectionId,
      input.userId,
      collectionName,
      "Deterministic authenticated E2E study area.",
      now,
    ],
  );

  await sql.query(
    `INSERT INTO "skills" ("id", "userId", "collectionId", "title", "objective", "rules", "examples", "exerciseConstraints", "tags", "status", "dueAt", "stability", "difficulty", "elapsedDays", "scheduledDays", "learningSteps", "repetitions", "lapses", "fsrsState", "lastReviewedAt", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::jsonb, ARRAY['e2e-test', $9]::text[], 'ACTIVE', $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)`,
    [
      skillId,
      input.userId,
      collectionId,
      skillTitle,
      objective,
      JSON.stringify([`Use the deterministic ${input.kind} answer rule.`]),
      JSON.stringify([`E2E ${input.kind} example.`]),
      JSON.stringify(
        "Use the seeded answer contract; no provider call is required.",
      ),
      input.kind,
      schedule.dueAt,
      schedule.stability,
      schedule.difficulty,
      schedule.elapsedDays,
      schedule.scheduledDays,
      schedule.learningSteps,
      schedule.repetitions,
      schedule.lapses,
      schedule.fsrsState,
      schedule.lastReviewedAt,
      now,
      now,
    ],
  );

  const exercises: E2EPracticeExerciseFixture[] = [];
  for (let index = 0; index < exerciseCount; index += 1) {
    const exercise = getE2EExerciseSeed(input.kind, index + 1);
    const exerciseId = `e2e_exercise_${randomUUID().replaceAll("-", "")}`;
    const exerciseCreatedAt = new Date(now.getTime() + index);

    await sql.query(
      `INSERT INTO "exercises" ("id", "userId", "skillId", "type", "answerKind", "prompt", "choices", "answerSpec", "correctAnswerDisplay", "explanation", "difficulty", "expectedSeconds", "verificationStatus", "freshnessKey", "generationMetadata", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, 'VERIFIED', $13, $14::jsonb, $15, $15)`,
      [
        exerciseId,
        input.userId,
        skillId,
        exercise.type,
        input.kind === "choice" ? "CHOICE" : input.kind.toUpperCase(),
        exercise.prompt,
        exercise.choices ? JSON.stringify(exercise.choices) : null,
        JSON.stringify(exercise.answerSpec),
        exercise.correctAnswerDisplay,
        exercise.explanation,
        exercise.difficulty,
        exercise.expectedSeconds,
        `e2e:${fixtureKey}:${input.kind}:${index + 1}`,
        JSON.stringify({
          fixture: "authenticated-e2e",
          generated: true,
          verification: "deterministic",
        }),
        exerciseCreatedAt,
      ],
    );

    exercises.push({
      id: exerciseId,
      answerKind: input.kind,
      correctAnswerDisplay: exercise.correctAnswerDisplay,
      correctChoiceId: exercise.correctChoiceId,
      prompt: exercise.prompt,
      testAnswer: exercise.testAnswer,
    });
  }

  return {
    userId: input.userId,
    kind: input.kind,
    collectionId,
    collectionName,
    collectionIds: [collectionId],
    skillId,
    skillTitle,
    objective,
    skillIds: [skillId],
    exercise: exercises[0]!,
    exercises,
    exerciseIds: exercises.map((exercise) => exercise.id),
  };
}

export async function deleteE2EPracticeFixture(input: {
  collectionIds: readonly string[];
  skillIds: readonly string[];
  userId: string;
}) {
  const sql = getTestSql();

  if (input.skillIds.length > 0) {
    await sql.query(
      `DELETE FROM "skills" WHERE "userId" = $1 AND "id" = ANY($2::text[])`,
      [input.userId, [...input.skillIds]],
    );
  }

  if (input.collectionIds.length > 0) {
    await sql.query(
      `DELETE FROM "collections" WHERE "userId" = $1 AND "id" = ANY($2::text[])`,
      [input.userId, [...input.collectionIds]],
    );
  }
}

export async function readE2EPracticeState(input: {
  exerciseId: string;
  skillId: string;
  userId: string;
}): Promise<E2EPracticeState> {
  const sql = getTestSql();
  const [
    skillRows,
    attemptCountRows,
    latestAttemptRows,
    reviewCountRows,
    latestReviewRows,
  ] = await Promise.all([
    sql.query(
      `SELECT "dueAt", "stability", "difficulty", "repetitions", "lapses", "fsrsState", "lastReviewedAt"
         FROM "skills" WHERE "id" = $1 AND "userId" = $2`,
      [input.skillId, input.userId],
    ),
    sql.query(
      `SELECT COUNT(*)::int AS "attemptCount" FROM "exercise_attempts"
         WHERE "skillId" = $1 AND "userId" = $2`,
      [input.skillId, input.userId],
    ),
    sql.query(
      `SELECT "normalizedAnswer", "isCorrect", "result", "finalRating"
         FROM "exercise_attempts"
         WHERE "exerciseId" = $1 AND "userId" = $2
         ORDER BY "createdAt" DESC, "id" DESC LIMIT 1`,
      [input.exerciseId, input.userId],
    ),
    sql.query(
      `SELECT COUNT(*)::int AS "reviewLogCount" FROM "review_logs"
         WHERE "skillId" = $1 AND "userId" = $2`,
      [input.skillId, input.userId],
    ),
    sql.query(
      `SELECT "finalRating", "nextDueAt" FROM "review_logs"
         WHERE "skillId" = $1 AND "userId" = $2
         ORDER BY "reviewedAt" DESC, "id" DESC LIMIT 1`,
      [input.skillId, input.userId],
    ),
  ]);

  const skill = skillRows[0] as Record<string, unknown> | undefined;
  if (!skill) {
    throw new Error(`E2E skill fixture ${input.skillId} was not found.`);
  }

  const attempt = latestAttemptRows[0] as Record<string, unknown> | undefined;
  const review = latestReviewRows[0] as Record<string, unknown> | undefined;
  const attemptCount = attemptCountRows[0] as
    Record<string, unknown> | undefined;
  const reviewCount = reviewCountRows[0] as Record<string, unknown> | undefined;

  return {
    dueAt: toIsoString(skill.dueAt),
    stability: toNullableNumber(skill.stability),
    difficulty: toNullableNumber(skill.difficulty),
    repetitions: toNumber(skill.repetitions),
    lapses: toNumber(skill.lapses),
    fsrsState: String(skill.fsrsState),
    lastReviewedAt: toIsoString(skill.lastReviewedAt),
    attemptCount: toNumber(attemptCount?.attemptCount),
    reviewLogCount: toNumber(reviewCount?.reviewLogCount),
    latestAttempt: attempt
      ? {
          normalizedAnswer: toNullableString(attempt.normalizedAnswer),
          isCorrect: attempt.isCorrect === true,
          result: String(attempt.result),
          finalRating: toNullableString(attempt.finalRating),
        }
      : null,
    latestReview: review
      ? {
          finalRating: String(review.finalRating),
          nextDueAt: toIsoString(review.nextDueAt),
        }
      : null,
  };
}

export async function readE2EFlagState(input: {
  exerciseId: string;
  skillId: string;
  userId: string;
}): Promise<E2EFlagState> {
  const sql = getTestSql();
  const rows = await sql.query(
    `SELECT
       (SELECT "retiredAt" FROM "exercises" WHERE "id" = $1 AND "userId" = $3) AS "retiredAt",
       (SELECT "retirementReason" FROM "exercises" WHERE "id" = $1 AND "userId" = $3) AS "retirementReason",
       (SELECT COUNT(*)::int FROM "exercise_flags" WHERE "exerciseId" = $1 AND "userId" = $3) AS "flagCount",
       (SELECT COUNT(*)::int FROM "exercise_attempts" WHERE "exerciseId" = $1 AND "skillId" = $2 AND "userId" = $3) AS "attemptCount",
       (SELECT COUNT(*)::int FROM "review_logs" WHERE "skillId" = $2 AND "userId" = $3) AS "reviewLogCount"`,
    [input.exerciseId, input.skillId, input.userId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row || row.retiredAt === undefined) {
    throw new Error(`E2E exercise fixture ${input.exerciseId} was not found.`);
  }

  return {
    retiredAt: toIsoString(row.retiredAt),
    retirementReason: toNullableString(row.retirementReason),
    flagCount: toNumber(row.flagCount),
    attemptCount: toNumber(row.attemptCount),
    reviewLogCount: toNumber(row.reviewLogCount),
  };
}

function getE2ESchedule(kind: E2EPracticeKind, dueAt: Date) {
  const exactInput = kind !== "choice";

  return {
    dueAt,
    stability: exactInput ? 7 : 0,
    difficulty: exactInput ? 4 : 0,
    elapsedDays: exactInput ? 3 : 0,
    scheduledDays: exactInput ? 3 : 0,
    learningSteps: 0,
    repetitions: exactInput ? E2E_EXACT_INPUT_UNLOCK_REPETITIONS : 0,
    lapses: 0,
    fsrsState: exactInput ? "REVIEW" : "NEW",
    lastReviewedAt: exactInput
      ? new Date(dueAt.getTime() - 24 * 60 * 60 * 1_000)
      : null,
  };
}

function getE2EExerciseSeed(kind: E2EPracticeKind, itemNumber: number) {
  switch (kind) {
    case "choice":
      return {
        type: "MULTIPLE_CHOICE",
        prompt: `Choose the identity verb for deterministic item ${itemNumber}: Ella ___ profesora.`,
        choices: [
          { id: "correct", label: "es" },
          { id: "wrong", label: "está" },
        ],
        answerSpec: { kind: "choice", correctChoiceId: "correct" },
        correctAnswerDisplay: "es",
        correctChoiceId: "correct",
        testAnswer: "correct",
        explanation: "Use ser for identity and profession.",
        difficulty: 1,
        expectedSeconds: 20,
      };
    case "text":
      return {
        type: "EXACT_INPUT",
        prompt: `Type the normalized answer for deterministic item ${itemNumber}: café.`,
        choices: null,
        answerSpec: {
          kind: "text",
          accepted: ["cafe", "café"],
          normalizeCase: true,
          normalizeWhitespace: true,
          normalizeDiacritics: true,
        },
        correctAnswerDisplay: "café",
        correctChoiceId: null,
        testAnswer: "CAFE",
        explanation:
          "The accepted text normalizes case, whitespace, and the accent.",
        difficulty: 1,
        expectedSeconds: 25,
      };
    case "numeric":
      return {
        type: "EXACT_INPUT",
        prompt: `Enter one half for deterministic item ${itemNumber}.`,
        choices: null,
        answerSpec: {
          kind: "numeric",
          accepted: ["1/2", 0.5],
          tolerance: 0,
        },
        correctAnswerDisplay: "0.5",
        correctChoiceId: null,
        testAnswer: "1/2",
        explanation: "One half equals 0.5.",
        difficulty: 1,
        expectedSeconds: 25,
      };
    case "math":
      return {
        type: "EXACT_INPUT",
        prompt: `Simplify x + x for deterministic item ${itemNumber}.`,
        choices: null,
        answerSpec: {
          kind: "math",
          acceptedExpressions: ["2x"],
          equivalence: "basic-symbolic",
        },
        correctAnswerDisplay: "2x",
        correctChoiceId: null,
        testAnswer: "2*x",
        explanation: "Combine like terms to get 2x.",
        difficulty: 1,
        expectedSeconds: 30,
      };
  }
}

async function ensureE2EUser(
  sql: ReturnType<typeof getTestSql>,
  input: { email: string; id: string; name: string; now: Date },
) {
  await sql.query(
    `INSERT INTO "users" ("id", "email", "name", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, $4)
     ON CONFLICT ("id") DO NOTHING`,
    [input.id, input.email, input.name, input.now],
  );
}

function toIsoString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : String(value);
}

function toNullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function toNullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : toNumber(value);
}

function toNumber(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getTestSql() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("Authenticated E2E database helpers require DATABASE_URL.");
  }
  return neon(connectionString);
}
