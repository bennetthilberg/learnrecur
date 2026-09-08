import "server-only";

import {
  AnswerKind,
  ExerciseFlagStatus,
  ExerciseVerificationStatus,
  GenerationJobStatus,
  Prisma,
  SkillStatus,
} from "@/generated/prisma/client";
import {
  authorizeAgentRead,
  withAgentMutation,
} from "@/lib/agent-access/access";
import type { AgentAuthContext } from "@/lib/agent-access/auth";
import {
  agentNeedsAttentionSchema,
  agentProgressSummarySchema,
  agentReadinessGetSchema,
  agentReadinessRepairSchema,
} from "@/lib/agent-access/contracts";
import { AgentOperationError } from "@/lib/agent-access/operations";
import { getDailyNewSkillAllowance } from "@/lib/practice/daily-limit";
import { flagPracticeExerciseAndQueueRefill } from "@/lib/practice";
import { getPrisma } from "@/lib/prisma";
import { updateSkillPracticeGuidance } from "@/lib/skills";
import { queueRetentionPreparation } from "@/lib/skills/retention-preparation";
import {
  isPracticeReadModelExerciseReady,
  resolveReadModelTextPolicy,
} from "@/lib/practice/read-model-eligibility";
import { getNeedsAttention } from "@/lib/practice/needs-attention";

type ReadinessExercise = {
  id: string;
  answerKind: AnswerKind;
  verificationStatus: ExerciseVerificationStatus;
  retiredAt: Date | null;
  choices: Prisma.JsonValue | null;
  answerSpec: Prisma.JsonValue;
};

function isReady(skill: {
  repetitions: number;
  alreadyStudied: boolean;
  textPolicy: Prisma.JsonValue | null;
  collection: { textPolicy: Prisma.JsonValue | null } | null;
  exercises: ReadinessExercise[];
}) {
  const textPolicy = resolveReadModelTextPolicy({
    skill: skill.textPolicy,
    collection: skill.collection?.textPolicy,
  });
  return skill.exercises.filter((exercise) =>
    isPracticeReadModelExerciseReady(exercise, { ...skill, textPolicy }),
  );
}

export async function getAgentProgressSummary(
  auth: AgentAuthContext,
  rawInput: unknown,
) {
  const input = agentProgressSummarySchema.parse(rawInput);
  await authorizeAgentRead(auth, "progress:read");
  const prisma = getPrisma();
  const now = new Date();
  const collectionId = input.collection_id ?? null;
  const [allowance, counts, attention, openFlagCount, failedJobs, pendingJobs] =
    await Promise.all([
      getDailyNewSkillAllowance(prisma, auth.userId, now),
      loadProgressCounts({ userId: auth.userId, now, collectionId }),
      getNeedsAttention({
        userId: auth.userId,
        now,
        limit: input.recent_limit,
        collectionId,
      }),
      prisma.exerciseFlag.count({
        where: {
          userId: auth.userId,
          status: ExerciseFlagStatus.OPEN,
          ...(collectionId ? { exercise: { skill: { collectionId } } } : {}),
        },
      }),
      prisma.generationJob.count({
        where: {
          userId: auth.userId,
          status: GenerationJobStatus.FAILED,
          ...(collectionId ? { skill: { collectionId } } : {}),
        },
      }),
      prisma.generationJob.count({
        where: {
          userId: auth.userId,
          status: {
            in: [GenerationJobStatus.PENDING, GenerationJobStatus.RUNNING],
          },
          ...(collectionId ? { skill: { collectionId } } : {}),
        },
      }),
    ]);
  const troubleSpots = attention.items
    .filter((item) => item.kind === "repeated-misses" && item.repeatedMisses)
    .slice(0, input.recent_limit)
    .map((item) => ({
      skill_id: item.skillId,
      title: item.skillTitle,
      collection_name: item.collectionName,
      miss_count: item.repeatedMisses?.missCount ?? 0,
      attempt_count: item.repeatedMisses?.reviewCount ?? 0,
      last_attempt_at: item.lastReviewedAt?.toISOString() ?? null,
      skill_uri: `learnrecur://skills/${item.skillId}`,
    }));
  return {
    as_of: now.toISOString(),
    scope: collectionId ? { collection_id: collectionId } : { kind: "account" },
    due: {
      skill_count: counts.dueSkillCount,
      ready_skill_count: counts.readyDueSkillCount,
      waiting_for_preparation_count:
        counts.dueSkillCount - counts.readyDueSkillCount,
    },
    new_skill_allowance: {
      limit: allowance.limit,
      remaining: allowance.remaining,
      timezone: allowance.timezone,
    },
    trouble_spots: troubleSpots,
    quality: { open_flag_count: openFlagCount },
    preparation: {
      pending_job_count: pendingJobs,
      failed_job_count: failedJobs,
    },
    totals: {
      active_skill_count: counts.activeSkillCount,
      introduced_skill_count: counts.introducedSkillCount,
      reviewed_skill_count: counts.reviewedSkillCount,
    },
  };
}

type ProgressCountRow = {
  active_skill_count: bigint | number;
  due_skill_count: bigint | number;
  ready_due_skill_count: bigint | number;
  introduced_skill_count: bigint | number;
  reviewed_skill_count: bigint | number;
};

type ProgressCounts = {
  activeSkillCount: number;
  dueSkillCount: number;
  readyDueSkillCount: number;
  introducedSkillCount: number;
  reviewedSkillCount: number;
};

/**
 * Keep progress totals scalar and bounded. Readiness is an existence check in
 * SQL, so a summary cannot hydrate every exercise in a large library just to
 * answer whether each due skill has one usable item.
 */
async function loadProgressCounts(input: {
  userId: string;
  now: Date;
  collectionId: string | null;
}): Promise<ProgressCounts> {
  const collectionFilter = input.collectionId
    ? Prisma.sql`AND s."collectionId" = ${input.collectionId}`
    : Prisma.empty;
  const rows = await getPrisma().$queryRaw<ProgressCountRow[]>`
    SELECT
      COUNT(*) FILTER (
        WHERE s."status" = ${SkillStatus.ACTIVE}::"SkillStatus"
      ) AS active_skill_count,
      COUNT(*) FILTER (
        WHERE s."status" = ${SkillStatus.ACTIVE}::"SkillStatus"
          AND s."dueAt" IS NOT NULL
          AND s."dueAt" <= ${input.now}
      ) AS due_skill_count,
      COUNT(*) FILTER (
        WHERE s."status" = ${SkillStatus.ACTIVE}::"SkillStatus"
          AND s."dueAt" IS NOT NULL
          AND s."dueAt" <= ${input.now}
          AND EXISTS (
            SELECT 1
            FROM "exercises" e
            WHERE e."userId" = s."userId"
              AND e."skillId" = s."id"
              AND e."verificationStatus" = ${ExerciseVerificationStatus.VERIFIED}::"ExerciseVerificationStatus"
              AND e."retiredAt" IS NULL
              AND (
                (
                  e."answerKind" = ${AnswerKind.CHOICE}::"AnswerKind"
                  AND jsonb_typeof(e."choices") = 'array'
                  AND jsonb_array_length(
                    CASE
                      WHEN jsonb_typeof(e."choices") = 'array' THEN e."choices"
                      ELSE '[]'::jsonb
                    END
                  ) > 0
                  AND e."answerSpec"->>'kind' = 'choice'
                  AND EXISTS (
                    SELECT 1
                    FROM jsonb_array_elements(
                      CASE
                        WHEN jsonb_typeof(e."choices") = 'array' THEN e."choices"
                        ELSE '[]'::jsonb
                      END
                    ) choice
                    WHERE choice->>'id' = e."answerSpec"->>'correctChoiceId'
                  )
                )
                OR (
                  (s."alreadyStudied" = TRUE OR s."repetitions" >= 3)
                  AND (
                    (
                      e."answerKind" = ${AnswerKind.TEXT}::"AnswerKind"
                      AND e."answerSpec"->>'kind' = 'text'
                      AND jsonb_typeof(e."answerSpec"->'accepted') = 'array'
                      AND jsonb_array_length(
                        CASE
                          WHEN jsonb_typeof(e."answerSpec"->'accepted') = 'array' THEN e."answerSpec"->'accepted'
                          ELSE '[]'::jsonb
                        END
                      ) > 0
                      AND e."answerSpec"->>'policyVersion' = COALESCE(
                        s."textPolicy",
                        c."textPolicy",
                        '{"version":2,"profile":"NATURAL","normalizeCase":true,"normalizeWhitespace":true}'::jsonb
                      )->>'version'
                      AND e."answerSpec"->>'normalizeCase' = COALESCE(
                        s."textPolicy",
                        c."textPolicy",
                        '{"version":2,"profile":"NATURAL","normalizeCase":true,"normalizeWhitespace":true}'::jsonb
                      )->>'normalizeCase'
                      AND e."answerSpec"->>'normalizeWhitespace' = COALESCE(
                        s."textPolicy",
                        c."textPolicy",
                        '{"version":2,"profile":"NATURAL","normalizeCase":true,"normalizeWhitespace":true}'::jsonb
                      )->>'normalizeWhitespace'
                      AND e."answerSpec"->>'normalizeDiacritics' = 'false'
                      AND (
                        (COALESCE(
                          s."textPolicy",
                          c."textPolicy",
                          '{"version":2,"profile":"NATURAL","normalizeCase":true,"normalizeWhitespace":true}'::jsonb
                        )->>'profile' = 'CUSTOM')
                        OR (
                          COALESCE(
                            s."textPolicy",
                            c."textPolicy",
                            '{"version":2,"profile":"NATURAL","normalizeCase":true,"normalizeWhitespace":true}'::jsonb
                          )->>'profile' = 'NATURAL'
                          AND COALESCE(
                            s."textPolicy",
                            c."textPolicy",
                            '{"version":2,"profile":"NATURAL","normalizeCase":true,"normalizeWhitespace":true}'::jsonb
                          )->>'normalizeCase' = 'true'
                          AND COALESCE(
                            s."textPolicy",
                            c."textPolicy",
                            '{"version":2,"profile":"NATURAL","normalizeCase":true,"normalizeWhitespace":true}'::jsonb
                          )->>'normalizeWhitespace' = 'true'
                        )
                        OR (
                          COALESCE(
                            s."textPolicy",
                            c."textPolicy",
                            '{"version":2,"profile":"NATURAL","normalizeCase":true,"normalizeWhitespace":true}'::jsonb
                          )->>'profile' = 'EXACT'
                          AND COALESCE(
                            s."textPolicy",
                            c."textPolicy",
                            '{"version":2,"profile":"NATURAL","normalizeCase":true,"normalizeWhitespace":true}'::jsonb
                          )->>'normalizeCase' = 'false'
                          AND COALESCE(
                            s."textPolicy",
                            c."textPolicy",
                            '{"version":2,"profile":"NATURAL","normalizeCase":true,"normalizeWhitespace":true}'::jsonb
                          )->>'normalizeWhitespace' = 'false'
                        )
                      )
                    )
                    OR (
                      e."answerKind" = ${AnswerKind.NUMERIC}::"AnswerKind"
                      AND e."answerSpec"->>'kind' = 'numeric'
                      AND jsonb_typeof(e."answerSpec"->'accepted') = 'array'
                      AND jsonb_array_length(
                        CASE
                          WHEN jsonb_typeof(e."answerSpec"->'accepted') = 'array' THEN e."answerSpec"->'accepted'
                          ELSE '[]'::jsonb
                        END
                      ) > 0
                    )
                    OR (
                      e."answerKind" = ${AnswerKind.MATH}::"AnswerKind"
                      AND e."answerSpec"->>'kind' = 'math'
                      AND jsonb_typeof(e."answerSpec"->'acceptedExpressions') = 'array'
                      AND jsonb_array_length(
                        CASE
                          WHEN jsonb_typeof(e."answerSpec"->'acceptedExpressions') = 'array' THEN e."answerSpec"->'acceptedExpressions'
                          ELSE '[]'::jsonb
                        END
                      ) > 0
                    )
                  )
                )
              )
          )
      ) AS ready_due_skill_count,
      COUNT(*) FILTER (
        WHERE s."status" = ${SkillStatus.ACTIVE}::"SkillStatus"
          AND (
            s."firstIntroducedAt" IS NOT NULL
            OR s."lastReviewedAt" IS NOT NULL
            OR s."repetitions" > 0
          )
      ) AS introduced_skill_count,
      COUNT(*) FILTER (
        WHERE s."status" = ${SkillStatus.ACTIVE}::"SkillStatus"
          AND s."lastReviewedAt" IS NOT NULL
      ) AS reviewed_skill_count
    FROM "skills" s
    LEFT JOIN "collections" c
      ON c."id" = s."collectionId"
     AND c."userId" = s."userId"
    WHERE s."userId" = ${input.userId}
      ${collectionFilter}
  `;
  const row = rows[0];
  return {
    activeSkillCount: Number(row?.active_skill_count ?? 0),
    dueSkillCount: Number(row?.due_skill_count ?? 0),
    readyDueSkillCount: Number(row?.ready_due_skill_count ?? 0),
    introducedSkillCount: Number(row?.introduced_skill_count ?? 0),
    reviewedSkillCount: Number(row?.reviewed_skill_count ?? 0),
  };
}

export async function getAgentNeedsAttention(
  auth: AgentAuthContext,
  rawInput: unknown,
) {
  const input = agentNeedsAttentionSchema.parse(rawInput);
  await authorizeAgentRead(auth, "progress:read");
  const result = await getNeedsAttention({
    userId: auth.userId,
    now: new Date(),
    limit: input.limit,
    cursor: input.cursor,
  });
  return {
    status: result.status,
    items: result.items.map((item) => ({
      skill_id: item.skillId,
      title: item.skillTitle,
      collection_name: item.collectionName,
      kind: item.kind,
      reason: item.reason,
      miss_count: item.repeatedMisses?.missCount ?? 0,
      window_size: item.repeatedMisses?.reviewCount ?? 0,
      recent_reviews: item.reviews.map((review) => ({
        id: review.id,
        reviewed_at: review.reviewedAt.toISOString(),
        is_correct: review.isCorrect,
        final_rating: review.finalRating,
      })),
      last_reviewed_at: item.lastReviewedAt?.toISOString() ?? null,
      due_at: item.dueAt?.toISOString() ?? null,
      links: {
        skill: item.links.skill,
        practice: item.links.practice,
        source: item.links.source,
        guidance: item.links.guidance,
        retry: item.links.controls,
      },
    })),
    next_cursor: result.nextCursor,
  };
}

export async function getAgentReadiness(
  auth: AgentAuthContext,
  rawInput: unknown,
) {
  const input = agentReadinessGetSchema.parse(rawInput);
  await authorizeAgentRead(auth, "progress:read");
  const rows = await getPrisma().skill.findMany({
    where: {
      userId: auth.userId,
      ...(input.skill_id ? { id: input.skill_id } : {}),
      ...(input.collection_id ? { collectionId: input.collection_id } : {}),
      ...(input.after_id ? { id: { gt: input.after_id } } : {}),
      status: {
        in: [SkillStatus.ACTIVE, SkillStatus.PAUSED, SkillStatus.DRAFT],
      },
    },
    orderBy: { id: "asc" },
    take: input.limit + 1,
    select: {
      id: true,
      title: true,
      status: true,
      dueAt: true,
      stability: true,
      difficulty: true,
      repetitions: true,
      alreadyStudied: true,
      textPolicy: true,
      generationSpecStatus: true,
      collection: { select: { id: true, name: true, textPolicy: true } },
      exercises: {
        where: { retiredAt: null },
        select: {
          id: true,
          answerKind: true,
          verificationStatus: true,
          retiredAt: true,
          choices: true,
          answerSpec: true,
        },
      },
      generationJobs: {
        orderBy: [{ createdAt: "desc" }, { id: "asc" }],
        take: 1,
        select: {
          id: true,
          status: true,
          stage: true,
          failureCategory: true,
          errorMessage: true,
          retryCount: true,
          completedAt: true,
        },
      },
    },
  });
  const page = rows.slice(0, input.limit);
  return {
    skills: page.map((skill) => {
      const ready = isReady(skill);
      const job = skill.generationJobs[0] ?? null;
      return {
        skill_id: skill.id,
        title: skill.title,
        status: skill.status,
        collection: skill.collection
          ? { collection_id: skill.collection.id, name: skill.collection.name }
          : null,
        ready_exercise_count: ready.length,
        due_at: skill.dueAt?.toISOString() ?? null,
        generation_spec_status: skill.generationSpecStatus,
        latest_job: job
          ? {
              job_id: job.id,
              status: job.status,
              stage: job.stage,
              failure_category: job.failureCategory,
              error_message: job.errorMessage,
              retry_count: job.retryCount,
              completed_at: job.completedAt?.toISOString() ?? null,
            }
          : null,
        status_reason:
          skill.status !== SkillStatus.ACTIVE
            ? "skill_not_active"
            : ready.length === 0
              ? "needs_preparation"
              : "ready",
      };
    }),
    next_cursor: rows.length > input.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

export async function repairAgentReadiness(
  auth: AgentAuthContext,
  rawInput: unknown,
) {
  const input = agentReadinessRepairSchema.parse(rawInput);
  // Claim the write permission and ownership before invoking the existing
  // generation/flag/guidance services. Those services have their own CAS and
  // idempotent job guards; this preflight prevents a foreign skill from being
  // handed to them.
  const skill = await withAgentMutation(auth, "skills:write", async (tx) => {
    const row = await tx.skill.findFirst({
      where: { id: input.skill_id, userId: auth.userId },
      select: { id: true, status: true },
    });
    if (!row)
      throw new AgentOperationError(
        "skill_not_found",
        "The skill was not found.",
      );
    return row;
  });
  const now = new Date();
  if (input.action === "update_guidance") {
    const result = await updateSkillPracticeGuidance({
      userId: auth.userId,
      skillId: skill.id,
      input: {
        rules: (input.rules ?? []).join("\n"),
        examples: (input.examples ?? []).join("\n"),
        exerciseConstraints: input.exercise_constraints ?? "",
      },
    });
    if (result.status !== "updated")
      throw new AgentOperationError("skill_not_found", result.message);
    return { status: "updated", action: input.action, skill_id: skill.id };
  }
  if (input.action === "flag_exercise") {
    const result = await flagPracticeExerciseAndQueueRefill({
      userId: auth.userId,
      exerciseId: input.exercise_id!,
      reasons: input.reasons!,
      otherNote: input.other_note,
      flaggedAt: now,
      model: undefined,
    });
    if (result.status !== "flagged")
      return {
        status: result.status,
        action: input.action,
        message: result.message,
      };
    return {
      status: "updated",
      action: input.action,
      skill_id: result.skillId,
      exercise_id: result.exerciseId,
      refill: result.refill,
    };
  }
  if (skill.status !== SkillStatus.ACTIVE) {
    throw new AgentOperationError(
      "skill_not_active",
      "Only active skills can be prepared or retried.",
    );
  }
  const queued = await queueRetentionPreparation({
    userId: auth.userId,
    skillId: skill.id,
    now,
  });
  return {
    status: "queued",
    action: input.action,
    skill_id: skill.id,
    preparation: queued ?? [],
  };
}
