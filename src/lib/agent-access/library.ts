import "server-only";

import {
  AnswerKind,
  CollectionStatus,
  ExerciseVerificationStatus,
  ExerciseType,
  Prisma,
  SkillStatus,
} from "@/generated/prisma/client";
import { authorizeAgentRead, withAgentMutation } from "@/lib/agent-access/access";
import type { AgentAuthContext } from "@/lib/agent-access/auth";
import { AgentOperationError } from "@/lib/agent-access/operations";
import {
  agentCollectionCreateSchema,
  agentCollectionLifecycleSchema,
  agentCollectionUpdateSchema,
  agentSkillBatchUpdateSchema,
  agentSkillGetSchema,
  agentSkillLifecycleSchema,
  agentSkillSearchSchema,
  agentSkillUpdateSchema,
} from "@/lib/agent-access/contracts";
import { createCollection, restoreCollection, archiveCollection, updateCollection } from "@/lib/collections";
import { updateSkillDraft, updateSkillMetadata, updateSkillPracticeGuidance } from "@/lib/skills";
import {
  isPracticeReadModelExerciseReady,
  resolveReadModelTextPolicy,
} from "@/lib/practice/read-model-eligibility";
import {
  buildReadyExerciseSql,
  DEFAULT_READY_TEXT_POLICY_SQL,
} from "@/lib/practice/readiness-sql";
import { getPrisma } from "@/lib/prisma";

const MAX_GUIDANCE_ITEMS = 8;

type PublicExercisePreview = {
  exercise_id: string;
  type: string;
  answer_kind: string;
  prompt: string;
  choices: Array<{ id: string; label: string }> | null;
  difficulty: number | null;
  expected_seconds: number | null;
};

function jsonStringList(value: Prisma.JsonValue | null, limit = MAX_GUIDANCE_ITEMS) {
  const entries = Array.isArray(value)
    ? value
    : value && typeof value === "object"
      ? (() => {
          const record = value as Prisma.JsonObject;
          if (Array.isArray(record.items)) return record.items;
          if (typeof record.notes === "string") return record.notes.split("\n");
          return [];
        })()
      : typeof value === "string"
        ? value.split("\n")
        : [];
  return entries
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function jsonConstraintText(value: Prisma.JsonValue | null) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const notes = (value as Prisma.JsonObject).notes;
    return typeof notes === "string" ? notes : null;
  }
  return null;
}

function safeChoices(value: Prisma.JsonValue | null) {
  if (!Array.isArray(value)) return null;
  const choices = value.flatMap((choice) => {
    if (!choice || typeof choice !== "object" || Array.isArray(choice)) return [];
    const record = choice as Record<string, unknown>;
    return typeof record.id === "string" && typeof record.label === "string"
      ? [{ id: record.id, label: record.label }]
      : [];
  });
  return choices.length ? choices : null;
}

function previewExercise(exercise: {
  id: string;
          type: ExerciseType;
          answerKind: AnswerKind;
  prompt: string;
  choices: Prisma.JsonValue | null;
  difficulty: number | null;
  expectedSeconds: number | null;
}): PublicExercisePreview {
  // Deliberately omit answerSpec, correctAnswerDisplay, and explanations. A
  // search/read tool can help an agent understand coverage without becoming an
  // answer oracle for the learner.
  return {
    exercise_id: exercise.id,
    type: exercise.type,
    answer_kind: exercise.answerKind,
    prompt: exercise.prompt,
    choices: safeChoices(exercise.choices),
    difficulty: exercise.difficulty,
    expected_seconds: exercise.expectedSeconds,
  };
}

function sourceLink(source: {
  id: string;
  originalName: string;
  kind: string;
  status: string;
  locator: Prisma.JsonValue | null;
  note: string | null;
}) {
  return {
    source_id: source.id,
    source_uri: `learnrecur://sources/${source.id}`,
    name: source.originalName,
    kind: source.kind,
    status: source.status,
    locator: source.locator,
    note: source.note,
  };
}

function readyExercises(
  skill: {
    dueAt: Date | null;
    stability: number | null;
    difficulty: number | null;
    repetitions: number;
    alreadyStudied?: boolean;
    textPolicy?: Prisma.JsonValue | null;
    collection?: {
      id?: string;
      name?: string;
      status?: CollectionStatus;
      textPolicy?: Prisma.JsonValue | null;
    } | null;
  exercises: Array<{
    id: string;
    type: ExerciseType;
    answerKind: AnswerKind;
      prompt: string;
      choices: Prisma.JsonValue | null;
      difficulty: number | null;
      expectedSeconds: number | null;
      verificationStatus: ExerciseVerificationStatus;
      retiredAt: Date | null;
      answerSpec: Prisma.JsonValue;
    }>;
  },
) {
  const hasTextPolicy =
    skill.textPolicy !== undefined || skill.collection?.textPolicy !== undefined;
  const textPolicy = hasTextPolicy
    ? resolveReadModelTextPolicy({
        skill: skill.textPolicy,
        collection: skill.collection?.textPolicy,
      })
    : undefined;
  return skill.exercises.filter((exercise) =>
    isPracticeReadModelExerciseReady(exercise, { ...skill, textPolicy }),
  );
}

type ReadyExerciseIdRow = { exercise_id: string };

/**
 * Select ready IDs before applying the sample limit. This keeps old, locked,
 * malformed, or policy-incompatible inventory from consuming a preview slot
 * while bounding both the SQL result and the follow-up hydration query.
 */
async function loadReadySampleExercises(
  userId: string,
  skillId: string,
  limit: number,
) {
  if (limit <= 0) return [];

  const readyRows = await getPrisma().$queryRaw<ReadyExerciseIdRow[]>`
    WITH skill_policy AS (
      SELECT
        s."id",
        s."userId",
        s."repetitions",
        s."alreadyStudied",
        COALESCE(
          s."textPolicy",
          c."textPolicy",
          ${DEFAULT_READY_TEXT_POLICY_SQL}
        ) AS "effectivePolicy"
      FROM "skills" s
      LEFT JOIN "collections" c
        ON c."id" = s."collectionId"
       AND c."userId" = s."userId"
      WHERE s."userId" = ${userId}
        AND s."id" = ${skillId}
    )
    SELECT e."id" AS exercise_id
    FROM skill_policy sp
    JOIN "exercises" e
      ON e."userId" = sp."userId"
     AND e."skillId" = sp."id"
    WHERE ${buildReadyExerciseSql({
      repetitions: Prisma.sql`sp."repetitions"`,
      alreadyStudied: Prisma.sql`sp."alreadyStudied"`,
      textPolicy: Prisma.sql`sp."effectivePolicy"`,
    })}
    ORDER BY e."createdAt" ASC, e."id" ASC
    LIMIT ${limit}
  `;
  const exerciseIds = readyRows.map((row) => row.exercise_id);
  if (exerciseIds.length === 0) return [];

  const exercises = await getPrisma().exercise.findMany({
    where: { userId, id: { in: exerciseIds } },
    select: {
      id: true,
      type: true,
      answerKind: true,
      prompt: true,
      choices: true,
      difficulty: true,
      expectedSeconds: true,
      verificationStatus: true,
      retiredAt: true,
      answerSpec: true,
    },
  });
  const byId = new Map(exercises.map((exercise) => [exercise.id, exercise]));
  return exerciseIds.flatMap((exerciseId) => {
    const exercise = byId.get(exerciseId);
    return exercise ? [exercise] : [];
  });
}

type ReadinessCountRow = {
  skill_id: string;
  ready_exercise_count: bigint | number;
  verified_exercise_count: bigint | number;
};

type VerifiedReadinessCountRow = {
  skill_id: string;
  verified_exercise_count: bigint | number;
};

type ReadinessCounts = {
  readyExerciseCount: number;
  verifiedExerciseCount: number;
};

/**
 * Search returns a small exercise preview, but readiness is an inventory
 * property. Count compatible inventory in SQL so `include_samples` cannot
 * change the answer and a large skill never hydrates every exercise row.
 */
async function loadReadinessCounts(
  userId: string,
  skillIds: string[],
): Promise<Map<string, ReadinessCounts>> {
  if (skillIds.length === 0) return new Map();

  const prisma = getPrisma();
  const [rows, verifiedRows] = await Promise.all([
    prisma.$queryRaw<ReadinessCountRow[]>`
      WITH skill_policy AS (
        SELECT
          s."id",
          s."userId",
          s."repetitions",
          s."alreadyStudied",
          COALESCE(
            s."textPolicy",
            c."textPolicy",
            ${DEFAULT_READY_TEXT_POLICY_SQL}
          ) AS "effectivePolicy"
        FROM "skills" s
        LEFT JOIN "collections" c
          ON c."id" = s."collectionId"
         AND c."userId" = s."userId"
        WHERE s."userId" = ${userId}
          AND s."id" IN (${Prisma.join(skillIds)})
      )
      SELECT
        sp."id" AS skill_id,
        COUNT(*) FILTER (
          WHERE e."verificationStatus" = ${ExerciseVerificationStatus.VERIFIED}::"ExerciseVerificationStatus"
            AND e."retiredAt" IS NULL
        ) AS verified_exercise_count,
        COUNT(*) AS ready_exercise_count
      FROM skill_policy sp
      JOIN "exercises" e
        ON e."userId" = sp."userId"
       AND e."skillId" = sp."id"
      WHERE ${buildReadyExerciseSql({
        repetitions: Prisma.sql`sp."repetitions"`,
        alreadyStudied: Prisma.sql`sp."alreadyStudied"`,
        textPolicy: Prisma.sql`sp."effectivePolicy"`,
      })}
      GROUP BY sp."id"
    `,
    prisma.$queryRaw<VerifiedReadinessCountRow[]>`
      SELECT
        s."id" AS skill_id,
        COUNT(*) AS verified_exercise_count
      FROM "skills" s
      JOIN "exercises" e
        ON e."userId" = s."userId"
       AND e."skillId" = s."id"
      WHERE s."userId" = ${userId}
        AND s."id" IN (${Prisma.join(skillIds)})
        AND e."verificationStatus" = ${ExerciseVerificationStatus.VERIFIED}::"ExerciseVerificationStatus"
        AND e."retiredAt" IS NULL
      GROUP BY s."id"
    `,
  ]);

  const verifiedBySkill = new Map(
    verifiedRows.map((row) => [row.skill_id, Number(row.verified_exercise_count)]),
  );
  const readyBySkill = new Map(rows.map((row) => [row.skill_id, Number(row.ready_exercise_count)]));

  return new Map(
    skillIds.map((skillId) => [
      skillId,
      {
        readyExerciseCount: readyBySkill.get(skillId) ?? 0,
        verifiedExerciseCount: verifiedBySkill.get(skillId) ?? 0,
      },
    ]),
  );
}

export async function searchAgentSkills(
  auth: AgentAuthContext,
  rawInput: unknown,
): Promise<Record<string, unknown>> {
  const input = agentSkillSearchSchema.parse(rawInput);
  await authorizeAgentRead(auth, "skills:read");
  const prisma = getPrisma();
  const rows = await prisma.skill.findMany({
    where: {
      userId: auth.userId,
      ...(input.after_id ? { id: { gt: input.after_id } } : {}),
      ...(input.status ? { status: input.status } : {}),
      ...(input.collection_id ? { collectionId: input.collection_id } : {}),
      ...(input.tags?.length ? { tags: { hasEvery: input.tags } } : {}),
      ...(input.query
        ? {
            OR: [
              { title: { contains: input.query, mode: "insensitive" } },
              { objective: { contains: input.query, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { id: "asc" },
    take: input.limit + 1,
    select: {
      id: true,
      title: true,
      objective: true,
      rules: true,
      examples: true,
      exerciseConstraints: true,
      tags: true,
      status: true,
      textPolicy: true,
      alreadyStudied: true,
      dueAt: true,
      stability: true,
      difficulty: true,
      repetitions: true,
      lapses: true,
      firstIntroducedAt: true,
      lastReviewedAt: true,
      collection: { select: { id: true, name: true, status: true, textPolicy: true } },
      sourceRefs: {
        orderBy: { id: "asc" },
        take: 24,
        select: {
          locator: true,
          note: true,
          sourceFile: { select: { id: true, originalName: true, kind: true, status: true } },
        },
      },
      exercises: {
        where: { verificationStatus: ExerciseVerificationStatus.VERIFIED, retiredAt: null },
        orderBy: { createdAt: "asc" },
        take: 0,
        select: {
          id: true,
          type: true,
          answerKind: true,
          prompt: true,
          choices: true,
          difficulty: true,
          expectedSeconds: true,
          verificationStatus: true,
          retiredAt: true,
          answerSpec: true,
        },
      },
    },
  });
  const page = rows.slice(0, input.limit);
  const readinessCounts = await loadReadinessCounts(
    auth.userId,
    page.map((skill) => skill.id),
  );
  const sampleExercisesBySkill = new Map(
    input.include_samples
      ? await Promise.all(
          page.map(async (skill) => [
            skill.id,
            await loadReadySampleExercises(auth.userId, skill.id, 3),
          ] as const),
        )
      : [],
  );
  return {
    skills: page.map((skill) =>
      toPublicSkill(
        input.include_samples
          ? { ...skill, exercises: sampleExercisesBySkill.get(skill.id) ?? [] }
          : skill,
        input.include_samples,
        readinessCounts.get(skill.id)?.readyExerciseCount ?? 0,
      ),
    ),
    next_cursor: rows.length > input.limit ? page.at(-1)?.id ?? null : null,
  };
}

export async function getAgentSkill(
  auth: AgentAuthContext,
  rawInput: unknown,
): Promise<Record<string, unknown>> {
  const input = agentSkillGetSchema.parse(rawInput);
  await authorizeAgentRead(auth, "skills:read");
  const skill = await getPrisma().skill.findFirst({
    where: { id: input.skill_id, userId: auth.userId },
    select: {
      id: true,
      title: true,
      objective: true,
      rules: true,
      examples: true,
      exerciseConstraints: true,
      tags: true,
      status: true,
      dueAt: true,
      stability: true,
      difficulty: true,
      elapsedDays: true,
      scheduledDays: true,
      learningSteps: true,
      repetitions: true,
      alreadyStudied: true,
      lapses: true,
      fsrsState: true,
      firstIntroducedAt: true,
      lastReviewedAt: true,
      updatedAt: true,
      generationSpecStatus: true,
      textPolicy: true,
      collection: { select: { id: true, name: true, status: true, textPolicy: true } },
      sourceRefs: {
        orderBy: { id: "asc" },
        take: 24,
        select: {
          locator: true,
          note: true,
          sourceFile: { select: { id: true, originalName: true, kind: true, status: true } },
        },
      },
      exercises: {
        where: { verificationStatus: ExerciseVerificationStatus.VERIFIED, retiredAt: null },
        orderBy: { createdAt: "asc" },
        take: 0,
        select: {
          id: true,
          type: true,
          answerKind: true,
          prompt: true,
          choices: true,
          difficulty: true,
          expectedSeconds: true,
          verificationStatus: true,
          retiredAt: true,
          answerSpec: true,
        },
      },
      generationJobs: {
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: 3,
        select: {
          id: true,
          kind: true,
          status: true,
          stage: true,
          failureCategory: true,
          errorMessage: true,
          requestedCount: true,
          acceptedCount: true,
          rejectedCount: true,
          retryCount: true,
          createdAt: true,
          completedAt: true,
        },
      },
    },
  });
  if (!skill) throw new AgentOperationError("skill_not_found", "The skill was not found.");
  const readinessCounts = await loadReadinessCounts(auth.userId, [skill.id]);
  const counts = readinessCounts.get(skill.id) ?? {
    readyExerciseCount: 0,
    verifiedExerciseCount: 0,
  };
  const sampleExercises = await loadReadySampleExercises(auth.userId, skill.id, input.sample_limit);
  const previewExercises = sampleExercises.map(previewExercise);
  return {
    skill: {
      ...toPublicSkill({ ...skill, exercises: sampleExercises }, false, counts.readyExerciseCount),
      guidance: {
        rules: jsonStringList(skill.rules),
        examples: jsonStringList(skill.examples),
        exercise_constraints: jsonConstraintText(skill.exerciseConstraints),
      },
      schedule: {
        due_at: skill.dueAt?.toISOString() ?? null,
        stability: skill.stability,
        difficulty: skill.difficulty,
        elapsed_days: skill.elapsedDays,
        scheduled_days: skill.scheduledDays,
        learning_steps: skill.learningSteps,
        repetitions: skill.repetitions,
        lapses: skill.lapses,
        state: skill.fsrsState,
        first_introduced_at: skill.firstIntroducedAt?.toISOString() ?? null,
        last_reviewed_at: skill.lastReviewedAt?.toISOString() ?? null,
      },
      readiness: {
        ready_exercise_count: counts.readyExerciseCount,
        verified_exercise_count: counts.verifiedExerciseCount,
        status: counts.readyExerciseCount > 0 && skill.status === SkillStatus.ACTIVE ? "ready" : "needs_preparation",
        generation_spec_status: skill.generationSpecStatus,
      },
      sample_exercises: previewExercises,
      recent_generation_jobs: skill.generationJobs.map((job) => ({
        job_id: job.id,
        kind: job.kind,
        status: job.status,
        stage: job.stage,
        failure_category: job.failureCategory,
        error_message: job.errorMessage,
        requested_count: job.requestedCount,
        accepted_count: job.acceptedCount,
        rejected_count: job.rejectedCount,
        retry_count: job.retryCount,
        created_at: job.createdAt.toISOString(),
        completed_at: job.completedAt?.toISOString() ?? null,
      })),
    },
  };
}

function toPublicSkill(skill: {
  id: string;
  title: string;
  objective: string | null;
  rules: Prisma.JsonValue | null;
  examples: Prisma.JsonValue | null;
  exerciseConstraints: Prisma.JsonValue | null;
  tags: string[];
  status: SkillStatus;
  dueAt: Date | null;
  stability: number | null;
  difficulty: number | null;
  repetitions: number;
  alreadyStudied?: boolean;
  textPolicy?: Prisma.JsonValue | null;
  lapses: number;
  firstIntroducedAt: Date | null;
  lastReviewedAt: Date | null;
  collection: { id: string; name: string; status: CollectionStatus; textPolicy?: Prisma.JsonValue | null } | null;
  sourceRefs: Array<{
    locator: Prisma.JsonValue | null;
    note: string | null;
    sourceFile: { id: string; originalName: string; kind: string; status: string };
  }>;
  exercises: Array<{
    id: string;
    type: ExerciseType;
    answerKind: AnswerKind;
    prompt: string;
    choices: Prisma.JsonValue | null;
    difficulty: number | null;
    expectedSeconds: number | null;
    verificationStatus: ExerciseVerificationStatus;
    retiredAt: Date | null;
    answerSpec: Prisma.JsonValue;
  }>;
}, includeSamples: boolean, readyExerciseCount: number) {
  const ready = readyExercises(skill);
  return {
    skill_id: skill.id,
    title: skill.title,
    objective: skill.objective,
    status: skill.status,
    tags: skill.tags,
    guidance: {
      rules: jsonStringList(skill.rules),
      examples: jsonStringList(skill.examples),
      exercise_constraints: jsonConstraintText(skill.exerciseConstraints),
    },
    collection: skill.collection
      ? { collection_id: skill.collection.id, name: skill.collection.name, status: skill.collection.status }
      : null,
    source_links: skill.sourceRefs.map((ref) => sourceLink({ ...ref.sourceFile, locator: ref.locator, note: ref.note })),
    schedule: {
      due_at: skill.dueAt?.toISOString() ?? null,
      stability: skill.stability,
      difficulty: skill.difficulty,
      repetitions: skill.repetitions,
      lapses: skill.lapses,
      first_introduced_at: skill.firstIntroducedAt?.toISOString() ?? null,
      last_reviewed_at: skill.lastReviewedAt?.toISOString() ?? null,
    },
    readiness: {
      ready_exercise_count: readyExerciseCount,
      status: readyExerciseCount > 0 && skill.status === SkillStatus.ACTIVE ? "ready" : "needs_preparation",
    },
    ...(includeSamples
      ? { sample_exercises: ready.slice(0, 3).map(previewExercise) }
      : {}),
  };
}

export async function createAgentCollection(
  auth: AgentAuthContext,
  rawInput: unknown,
  transaction?: Prisma.TransactionClient,
) {
  const input = agentCollectionCreateSchema.parse(rawInput);
  return withAgentMutation(auth, "collections:write", async (tx) => {
    const result = await createCollection({ userId: auth.userId, input, transaction: tx });
    if (result.status !== "created") return { status: result.status, message: result.message, field_errors: "fieldErrors" in result ? result.fieldErrors : undefined };
    return { status: "created", collection: publicCollection(result.collection) };
  }, transaction);
}

export async function updateAgentCollection(auth: AgentAuthContext, rawInput: unknown, transaction?: Prisma.TransactionClient) {
  const input = agentCollectionUpdateSchema.parse(rawInput);
  return withAgentMutation(auth, "collections:write", async (tx) => {
    const current = await tx.collection.findFirst({ where: { id: input.collection_id, userId: auth.userId } });
    if (!current) throw new AgentOperationError("collection_not_found", "The collection was not found.");
    if (!matchesExpectedUpdatedAt(input.expected_updated_at, current.updatedAt)) {
      throw new AgentOperationError("stale_state", "The collection changed. Refresh it before updating.");
    }
    const result = await updateCollection({
      userId: auth.userId,
      collectionId: current.id,
      input: { name: input.changes.name ?? current.name, description: input.changes.description === undefined ? current.description : input.changes.description },
      transaction: tx,
    });
    if (result.status !== "updated") throw new AgentOperationError("collection_not_found", result.message);
    return { status: "updated", collection: publicCollection(result.collection) };
  }, transaction);
}

export async function lifecycleAgentCollection(auth: AgentAuthContext, rawInput: unknown, transaction?: Prisma.TransactionClient) {
  const input = agentCollectionLifecycleSchema.parse(rawInput);
  return withAgentMutation(auth, "collections:write", async (tx) => {
    const result = input.action === "archive"
      ? await archiveCollection({ userId: auth.userId, collectionId: input.collection_id, transaction: tx })
      : await restoreCollection({ userId: auth.userId, collectionId: input.collection_id, transaction: tx });
    if (result.status === "not-found") throw new AgentOperationError("collection_not_found", result.message);
    return {
      status: result.status,
      reason: "reason" in result ? result.reason : null,
      previous_status: "previousStatus" in result ? result.previousStatus : null,
      collection: "collection" in result ? publicCollection(result.collection) : null,
      message: result.message,
    };
  }, transaction);
}

export async function updateAgentSkill(auth: AgentAuthContext, rawInput: unknown) {
  const input = agentSkillUpdateSchema.parse(rawInput);
  return withAgentMutation(auth, "skills:write", async (tx) => {
    const current = await tx.skill.findFirst({
      where: { id: input.skill_id, userId: auth.userId },
      include: { collection: true },
    });
    if (!current) throw new AgentOperationError("skill_not_found", "The skill was not found.");
    if (!matchesExpectedUpdatedAt(input.expected_updated_at, current.updatedAt)) {
      throw new AgentOperationError("stale_state", "The skill changed. Refresh it before updating.");
    }
    const changes = input.changes;
    if (current.status === SkillStatus.ACTIVE && changes.objective !== undefined) {
      throw new AgentOperationError(
        "invalid_input",
        "Active skill objectives cannot be changed through agent library management. Create a new skill when the objective meaning changes so review history remains attached to its original objective.",
      );
    }
    if (current.status !== SkillStatus.DRAFT && changes.objective !== undefined) {
      throw new AgentOperationError("invalid_input", "Only draft skills can change their objective.");
    }

    if (current.status === SkillStatus.DRAFT) {
      const collectionName = changes.collection_id === undefined
        ? current.collection?.name ?? null
        : changes.collection_id
          ? (await tx.collection.findFirst({ where: { id: changes.collection_id, userId: auth.userId, status: CollectionStatus.ACTIVE }, select: { name: true } }))?.name ?? null
          : null;
      if (changes.collection_id && collectionName === null) {
        throw new AgentOperationError("collection_not_found", "The destination collection was not found or is archived.");
      }
      const result = await updateSkillDraft({
        userId: auth.userId,
        skillId: current.id,
        transaction: tx,
        input: {
          alreadyStudied: current.alreadyStudied,
          practicePreference: current.practicePreference,
          title: changes.title ?? current.title,
          objective: changes.objective ?? current.objective ?? "Review this skill objective before activation.",
          rules: (changes.rules ?? jsonStringList(current.rules)).join("\n"),
          examples: (changes.examples ?? jsonStringList(current.examples)).join("\n"),
          exerciseConstraints: changes.exercise_constraints ?? (jsonConstraintText(current.exerciseConstraints) ?? ""),
          tags: changes.tags ?? current.tags,
          collection: collectionName,
        },
      });
      if (result.status !== "updated") throw new AgentOperationError("invalid_input", "message" in result ? result.message : "The draft could not be updated.");
      return { status: "updated", skill: { skill_id: result.skill.id, updated_at: result.skill.updatedAt.toISOString(), status: result.skill.status, title: result.skill.title, objective: result.skill.objective, tags: result.skill.tags, collection_id: result.skill.collectionId, mastery_reset: false, guidance_updated: changes.rules !== undefined || changes.examples !== undefined || changes.exercise_constraints !== undefined } };
    }

    let guidanceUpdated = false;
    if (changes.rules !== undefined || changes.examples !== undefined || changes.exercise_constraints !== undefined) {
      const guidance = await updateSkillPracticeGuidance({
        userId: auth.userId,
        skillId: current.id,
        transaction: tx,
        input: {
          rules: (changes.rules ?? jsonStringList(current.rules)).join("\n"),
          examples: (changes.examples ?? jsonStringList(current.examples)).join("\n"),
          exerciseConstraints: changes.exercise_constraints ?? (jsonConstraintText(current.exerciseConstraints) ?? ""),
        },
      });
      if (guidance.status !== "updated") throw new AgentOperationError("skill_not_found", guidance.message);
      guidanceUpdated = true;
    }
    const metadata = await updateSkillMetadata({
      userId: auth.userId,
      skillId: current.id,
      transaction: tx,
      title: changes.title,
      tags: changes.tags,
      collectionId: changes.collection_id,
    });
    if (metadata.status === "not-found") throw new AgentOperationError("skill_not_found", metadata.message);
    if (metadata.status === "invalid") throw new AgentOperationError("invalid_input", metadata.message);
    return { status: "updated", skill: { skill_id: metadata.skillId, updated_at: metadata.updatedAt.toISOString(), status: current.status, title: changes.title ?? current.title, objective: current.objective, tags: metadata.tags, collection_id: metadata.collectionId, mastery_reset: false, guidance_updated: guidanceUpdated } };
  });
}

export async function lifecycleAgentSkill(auth: AgentAuthContext, rawInput: unknown) {
  const input = agentSkillLifecycleSchema.parse(rawInput);
  return withAgentMutation(auth, "skills:write", async (tx) => {
    const { pauseSkill, resumeSkill, archiveSkill, restoreArchivedSkill } = await import("@/lib/skills/lifecycle");
    const result = input.action === "pause"
      ? await pauseSkill({ userId: auth.userId, skillId: input.skill_id, transaction: tx })
      : input.action === "resume"
        ? await resumeSkill({ userId: auth.userId, skillId: input.skill_id, transaction: tx })
        : input.action === "archive"
          ? await archiveSkill({ userId: auth.userId, skillId: input.skill_id, transaction: tx })
          : await restoreArchivedSkill({ userId: auth.userId, skillId: input.skill_id, transaction: tx });
    if (result.status === "not-found") throw new AgentOperationError("skill_not_found", result.message);
    return { status: result.status, action: input.action, previous_status: "previousStatus" in result ? result.previousStatus : null, skill: "skill" in result ? result.skill : null, message: result.message };
  });
}

export async function batchUpdateAgentSkills(auth: AgentAuthContext, rawInput: unknown, transaction?: Prisma.TransactionClient) {
  const input = agentSkillBatchUpdateSchema.parse(rawInput);
  return withAgentMutation(auth, "skills:write", async (tx) => {
    const skills = await tx.skill.findMany({ where: { id: { in: input.skill_ids }, userId: auth.userId }, select: { id: true, tags: true, collectionId: true, updatedAt: true, status: true } });
    const byId = new Map(skills.map((skill) => [skill.id, skill]));
    const missing = input.skill_ids.filter((id) => !byId.has(id));
    if (missing.length) {
      throw new AgentOperationError("skill_not_found", "One or more skills were not found for this account.");
    }
    if (input.collection_id !== undefined && input.collection_id !== null) {
      const collection = await tx.collection.findFirst({ where: { id: input.collection_id, userId: auth.userId, status: CollectionStatus.ACTIVE }, select: { id: true } });
      if (!collection) throw new AgentOperationError("collection_not_found", "The destination collection was not found or is archived.");
    }
    const results: Array<Record<string, unknown>> = [];
    for (const id of input.skill_ids) {
      const current = byId.get(id)!;
      const expectedUpdatedAt =
        input.expected_updated_at_by_skill?.[id] ??
        (input.skill_ids.length === 1 ? input.expected_updated_at : undefined);
      if (!matchesExpectedUpdatedAt(expectedUpdatedAt, current.updatedAt)) {
        results.push({ skill_id: id, status: "stale" });
        continue;
      }
      const tags = input.set_tags ?? [...current.tags];
      const normalized = [...new Set([
        ...tags,
        ...(input.add_tags ?? []),
      ].filter((tag) => !(input.remove_tags ?? []).includes(tag)))];
      if (normalized.length > 12) {
        results.push({
          skill_id: id,
          status: "failed",
          message: "A skill can have at most 12 tags.",
        });
        continue;
      }
      const updated = await updateSkillMetadata({
        userId: auth.userId,
        skillId: id,
        transaction: tx,
        collectionId: input.collection_id,
        tags: normalized,
      });
      if (updated.status === "invalid") {
        results.push({ skill_id: id, status: "failed", message: updated.message });
        continue;
      }
      if (updated.status === "not-found") {
        throw new AgentOperationError("skill_not_found", updated.message);
      }
      results.push({ skill_id: id, status: "updated", collection_id: updated.collectionId, tags: updated.tags, updated_at: updated.updatedAt.toISOString() });
    }
    return {
      status: results.some((item) => item.status !== "updated") ? "partial" : "updated",
      results,
    };
  }, transaction);
}

function publicCollection(collection: { id: string; userId: string; name: string; description: string | null; status: CollectionStatus; updatedAt: Date }) {
  return { collection_id: collection.id, name: collection.name, description: collection.description, status: collection.status, updated_at: collection.updatedAt.toISOString() };
}

function matchesExpectedUpdatedAt(expected: string | undefined, actual: Date) {
  if (expected === undefined) return true;
  const expectedMillis = Date.parse(expected);
  return Number.isFinite(expectedMillis) && expectedMillis === actual.getTime();
}
