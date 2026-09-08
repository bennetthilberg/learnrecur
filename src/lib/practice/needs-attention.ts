import "server-only";

import {
  ExerciseAttemptResult,
  ExerciseEvidenceCorrectionStatus,
  ExerciseFlagAdjudicationStatus,
  ExerciseVerificationStatus,
  FsrsRating,
  GenerationJobStatus,
  Prisma,
  SkillStatus,
  AnswerKind,
} from "@/generated/prisma/client";
import {
  buildReadyExerciseSql,
  DEFAULT_READY_TEXT_POLICY_SQL,
} from "@/lib/practice/readiness-sql";
import {
  isPracticeReadModelExerciseReady,
  resolveReadModelTextPolicy,
} from "@/lib/practice/read-model-eligibility";
import { getPrisma } from "@/lib/prisma";

export const NEEDS_ATTENTION_REVIEW_WINDOW = 5;
export const NEEDS_ATTENTION_MISS_THRESHOLD = 3;
export const NEEDS_ATTENTION_DEFAULT_LIMIT = 20;
export const NEEDS_ATTENTION_MAX_LIMIT = 50;
export const NEEDS_ATTENTION_POLICY_VERSION = "needs-attention-v1";
const NEEDS_ATTENTION_MAX_CANDIDATE_SCANS = 2;

export type NeedsAttentionKind = "repeated-misses" | "preparation";

export type NeedsAttentionReviewEvidence = {
  id: string;
  reviewedAt: Date;
  isCorrect: boolean;
  finalRating: FsrsRating;
  scheduled: boolean;
  assisted?: boolean;
  practiceOnly?: boolean;
  exposure?: "PRACTICE_ONLY" | "SCHEDULED" | "practice-only";
  sessionMode?: "PRACTICE_ONLY" | "SCHEDULED";
  invalidated?: boolean;
};

export type NeedsAttentionReview = {
  id: string;
  reviewedAt: Date;
  isCorrect: boolean;
  finalRating: FsrsRating;
};

export type NeedsAttentionLinks = {
  skill: string;
  practice: string;
  guidance: string;
  source: string;
  controls: string;
};

export type RepeatedMissesFinding = {
  missCount: number;
  reviewCount: number;
  reviews: NeedsAttentionReviewEvidence[];
  lastReviewedAt: Date;
};

export type PreparationFinding = {
  reasonCode:
    "no-ready-exercises" | "preparation-failed" | "preparation-in-progress";
  latestJobStatus: GenerationJobStatus | null;
};

export type NeedsAttentionItem = {
  skillId: string;
  skillTitle: string;
  collectionName: string | null;
  kind: NeedsAttentionKind;
  reason: string;
  reasonCode: RepeatedMissesReasonCode | PreparationFinding["reasonCode"];
  lastReviewedAt: Date | null;
  dueAt: Date | null;
  reviews: NeedsAttentionReview[];
  repeatedMisses: RepeatedMissesFinding | null;
  preparation: PreparationFinding | null;
  links: NeedsAttentionLinks;
};

export type RepeatedMissesReasonCode = "repeated-misses";

export type GetNeedsAttentionInput = {
  userId: string;
  now: Date;
  limit?: number;
  cursor?: string | null;
  collectionId?: string | null;
};

export type GetNeedsAttentionResult = {
  status: "ready";
  items: NeedsAttentionItem[];
  nextCursor: string | null;
};

type RawReviewRow = {
  skill_id: string;
  skill_title: string;
  collection_name: string | null;
  due_at: Date | null;
  review_id: string;
  reviewed_at: Date;
  is_correct: boolean;
  final_rating: FsrsRating;
};

type RawFindingCandidate = {
  skill_id: string;
  skill_title: string;
  collection_name: string | null;
  due_at: Date | null;
  kind: NeedsAttentionKind;
  sort_at: Date;
  review_count: number | bigint;
  miss_count: number | bigint;
  latest_job_status: GenerationJobStatus | null;
};

const PREPARATION_EXERCISE_SCAN_LIMIT = 12;

type PreparationSkillRecord = {
  id: string;
  title: string;
  dueAt: Date | null;
  repetitions: number;
  alreadyStudied: boolean;
  textPolicy: Prisma.JsonValue | null;
  collection: { name: string; textPolicy: Prisma.JsonValue | null } | null;
  exercises: Array<{
    answerKind: AnswerKind;
    verificationStatus: ExerciseVerificationStatus;
    retiredAt: Date | null;
    choices: Prisma.JsonValue | null;
    answerSpec: Prisma.JsonValue;
  }>;
  generationJobs: Array<{
    status: GenerationJobStatus;
  }>;
};

type NeedsAttentionSortKey = {
  kind: NeedsAttentionKind;
  skillId: string;
  sortAt: Date;
};

type NeedsAttentionCursor = NeedsAttentionSortKey & {
  version: 1;
};

export class NeedsAttentionCursorError extends Error {
  readonly code = "invalid_cursor" as const;

  constructor() {
    super("Invalid needs-attention cursor.");
    this.name = "NeedsAttentionCursorError";
  }
}

/**
 * Returns the bounded evidence that is allowed to drive a persistent-failure
 * notice. Scheduled status is derived from the review snapshot, not from the
 * skill's current due date, so lifetime lapses and later schedule changes do
 * not manufacture a notice.
 */
export function selectNeedsAttentionReviews(input: {
  reviews: readonly NeedsAttentionReviewEvidence[];
  now: Date;
}): NeedsAttentionReviewEvidence[] {
  assertValidNow(input.now);

  return input.reviews
    .filter((review) => isValidNeedsAttentionReview(review, input.now))
    .toSorted(
      (left, right) =>
        left.reviewedAt.getTime() - right.reviewedAt.getTime() ||
        left.id.localeCompare(right.id),
    )
    .slice(-NEEDS_ATTENTION_REVIEW_WINDOW);
}

/**
 * Finds a narrow, observable pattern rather than attempting to diagnose a
 * misconception. Three misses in a short history are enough to be useful, but
 * an empty or one- or two-review history stays quiet by default.
 */
export function detectRepeatedMisses(input: {
  reviews: readonly NeedsAttentionReviewEvidence[];
  now: Date;
}): RepeatedMissesFinding | null {
  const reviews = selectNeedsAttentionReviews(input);

  if (reviews.length < NEEDS_ATTENTION_MISS_THRESHOLD) {
    return null;
  }

  const missCount = reviews.filter(isNeedsAttentionMiss).length;
  const latest = reviews.at(-1);

  if (
    missCount < NEEDS_ATTENTION_MISS_THRESHOLD ||
    !latest ||
    !isNeedsAttentionMiss(latest)
  ) {
    return null;
  }

  return {
    missCount,
    reviewCount: reviews.length,
    reviews,
    lastReviewedAt: latest.reviewedAt,
  };
}

export function isValidNeedsAttentionReview(
  review: NeedsAttentionReviewEvidence,
  now: Date,
): boolean {
  return (
    review.scheduled &&
    !review.assisted &&
    !review.practiceOnly &&
    review.exposure !== "PRACTICE_ONLY" &&
    review.exposure !== "practice-only" &&
    review.sessionMode !== "PRACTICE_ONLY" &&
    !review.invalidated &&
    review.reviewedAt <= now
  );
}

export function isNeedsAttentionMiss(review: {
  isCorrect: boolean;
  finalRating: FsrsRating;
}): boolean {
  return !review.isCorrect || review.finalRating === FsrsRating.AGAIN;
}

export function formatRepeatedMissesReason(
  finding: RepeatedMissesFinding,
): string {
  return `${finding.missCount} misses in the last ${finding.reviewCount} independent scheduled reviews, including the most recent review.`;
}

export function formatPreparationReason(finding: PreparationFinding): string {
  switch (finding.reasonCode) {
    case "preparation-failed":
      return "This due skill has no verified exercise ready, and its latest preparation failed.";
    case "preparation-in-progress":
      return "This due skill has no verified exercise ready while preparation is in progress.";
    case "no-ready-exercises":
      return "This due skill has no verified exercise ready yet.";
  }
}

export async function getNeedsAttention(
  input: GetNeedsAttentionInput,
): Promise<GetNeedsAttentionResult> {
  if (!input.userId.trim()) {
    throw new Error("getNeedsAttention requires an owning userId.");
  }
  assertValidNow(input.now);
  const limit = normalizeNeedsAttentionLimit(input.limit);
  const collectionId = input.collectionId?.trim() || null;
  let scanCursor = decodeNeedsAttentionCursor(input.cursor);
  const items: NeedsAttentionItem[] = [];
  let hasMoreCandidates = false;
  let lastScannedCursor: NeedsAttentionCursor | null = null;
  let scanCount = 0;

  // Candidate selection and detail loading are both bounded. A second scan is
  // only needed when a candidate's exact read-model check removes a SQL
  // candidate; this keeps pagination truthful without querying one skill at a
  // time.
  while (scanCount < NEEDS_ATTENTION_MAX_CANDIDATE_SCANS) {
    const candidates = await loadFindingCandidates({
      userId: input.userId,
      now: input.now,
      cursor: scanCursor,
      limit: limit + 1,
      collectionId,
    });
    scanCount += 1;
    if (candidates.length === 0) {
      // An exhausted query must terminate pagination. Keeping the previous
      // value here would return a cursor that repeats the same empty query.
      hasMoreCandidates = false;
      break;
    }

    const repeatedSkillIds = candidates
      .filter((candidate) => candidate.kind === "repeated-misses")
      .map((candidate) => candidate.skill_id);
    const preparationSkillIds = candidates
      .filter((candidate) => candidate.kind === "preparation")
      .map((candidate) => candidate.skill_id);
    const [reviewRows, preparationSkills] = await Promise.all([
      loadRecentReviewRows(
        input.userId,
        input.now,
        repeatedSkillIds,
        collectionId,
      ),
      loadPreparationSkills(input.userId, preparationSkillIds, collectionId),
    ]);

    items.push(
      ...buildNeedsAttentionItems({
        now: input.now,
        candidates,
        reviewRows,
        preparationSkills,
      }),
    );

    const lastCandidate = candidates.at(-1);
    if (!lastCandidate) {
      hasMoreCandidates = false;
      break;
    }
    lastScannedCursor = scanCursor = {
      version: 1,
      ...candidateToSortKey(lastCandidate),
    };
    hasMoreCandidates = candidates.length > limit;
    if (!hasMoreCandidates || items.length >= limit) break;
  }

  const orderedItems = items.toSorted(compareNeedsAttentionItems);
  const page = orderedItems.slice(0, limit);
  const hasMoreValidItems = orderedItems.length > limit;
  const nextCursorKey = hasMoreValidItems
    ? page.at(-1)
      ? toSortKey(page.at(-1)!)
      : null
    : hasMoreCandidates
      ? lastScannedCursor
      : null;

  return {
    status: "ready",
    items: page,
    nextCursor: nextCursorKey ? encodeNeedsAttentionCursor(nextCursorKey) : null,
  };
}

async function loadFindingCandidates(input: {
  userId: string;
  now: Date;
  cursor: NeedsAttentionCursor | null;
  limit: number;
  collectionId: string | null;
}): Promise<RawFindingCandidate[]> {
  const cursorSortAt = input.cursor?.sortAt ?? null;
  const cursorKindRank = input.cursor
    ? attentionKindRank(input.cursor.kind)
    : null;
  const cursorSkillId = input.cursor?.skillId ?? null;
  const collectionFilter = input.collectionId
    ? Prisma.sql`AND s."collectionId" = ${input.collectionId}`
    : Prisma.empty;

  return getPrisma().$queryRaw<RawFindingCandidate[]>`
    WITH eligible_reviews AS (
      SELECT
        rl."skillId" AS skill_id,
        s."title" AS skill_title,
        c."name" AS collection_name,
        s."dueAt" AS due_at,
        rl."id" AS review_id,
        rl."reviewedAt" AS reviewed_at,
        ea."isCorrect" AS is_correct,
        rl."finalRating" AS final_rating,
        ROW_NUMBER() OVER (
          PARTITION BY rl."skillId"
          ORDER BY rl."reviewedAt" DESC, rl."id" DESC
        ) AS review_rank
      FROM "review_logs" rl
      INNER JOIN "exercise_attempts" ea
        ON ea."id" = rl."exerciseAttemptId"
       AND ea."userId" = rl."userId"
       AND ea."skillId" = rl."skillId"
      INNER JOIN "skills" s
        ON s."id" = rl."skillId"
       AND s."userId" = rl."userId"
       AND s."status" = ${SkillStatus.ACTIVE}::"SkillStatus"
      LEFT JOIN "collections" c
        ON c."id" = s."collectionId"
       AND c."userId" = s."userId"
      WHERE rl."userId" = ${input.userId}
        AND rl."reviewedAt" <= ${input.now}
        AND rl."previousDueAt" IS NOT NULL
        AND rl."previousDueAt" <= rl."reviewedAt"
        AND ea."result" IN (${ExerciseAttemptResult.CORRECT}::"ExerciseAttemptResult", ${ExerciseAttemptResult.INCORRECT}::"ExerciseAttemptResult")
        AND COALESCE(ea."practiceContext"->>'assistance', 'none') <> 'observed'
        AND COALESCE(ea."practiceContext"->>'practiceOnly', 'false') <> 'true'
        AND COALESCE(ea."practiceContext"->>'exposure', '') NOT IN ('PRACTICE_ONLY', 'practice-only')
        AND COALESCE(ea."practiceContext"->>'sessionMode', '') <> 'PRACTICE_ONLY'
        ${collectionFilter}
        AND NOT EXISTS (
          SELECT 1
          FROM "exercise_flags" ef
          WHERE ef."exerciseId" = ea."exerciseId"
            AND ef."userId" = ea."userId"
            AND (
              ef."adjudicationStatus" = ${ExerciseFlagAdjudicationStatus.CONFIRMED}::"ExerciseFlagAdjudicationStatus"
              OR ef."practiceEvidenceNeedsCorrection" = TRUE
              OR ef."evidenceCorrectionStatus" <> ${ExerciseEvidenceCorrectionStatus.NOT_REQUIRED}::"ExerciseEvidenceCorrectionStatus"
            )
        )
    ),
    recent_reviews AS (
      SELECT * FROM eligible_reviews
      WHERE review_rank <= ${NEEDS_ATTENTION_REVIEW_WINDOW}
    ),
    review_counts AS (
      SELECT
        skill_id,
        MAX(skill_title) AS skill_title,
        MAX(collection_name) AS collection_name,
        MAX(due_at) AS due_at,
        MAX(reviewed_at) AS sort_at,
        COUNT(*) AS review_count,
        COUNT(*) FILTER (
          WHERE NOT is_correct OR final_rating = ${FsrsRating.AGAIN}::"FsrsRating"
        ) AS miss_count
      FROM recent_reviews
      GROUP BY skill_id
    ),
    latest_reviews AS (
      SELECT DISTINCT ON (skill_id)
        skill_id,
        (NOT is_correct OR final_rating = ${FsrsRating.AGAIN}::"FsrsRating") AS latest_is_miss
      FROM recent_reviews
      ORDER BY skill_id, reviewed_at DESC, review_id DESC
    ),
    review_findings AS (
      SELECT
        counts.skill_id,
        counts.skill_title,
        counts.collection_name,
        counts.due_at,
        'repeated-misses'::text AS kind,
        counts.sort_at,
        counts.review_count,
        counts.miss_count,
        NULL::"GenerationJobStatus" AS latest_job_status
      FROM review_counts counts
      INNER JOIN latest_reviews latest ON latest.skill_id = counts.skill_id
      WHERE counts.review_count >= ${NEEDS_ATTENTION_MISS_THRESHOLD}
        AND counts.miss_count >= ${NEEDS_ATTENTION_MISS_THRESHOLD}
        AND latest.latest_is_miss = TRUE
    ),
    preparation_findings AS (
      SELECT
        s."id" AS skill_id,
        s."title" AS skill_title,
        c."name" AS collection_name,
        s."dueAt" AS due_at,
        'preparation'::text AS kind,
        s."dueAt" AS sort_at,
        0::bigint AS review_count,
        0::bigint AS miss_count,
        latest_job.status AS latest_job_status
      FROM "skills" s
      LEFT JOIN "collections" c
        ON c."id" = s."collectionId"
       AND c."userId" = s."userId"
      LEFT JOIN LATERAL (
        SELECT gj."status"
        FROM "generation_jobs" gj
        WHERE gj."skillId" = s."id"
          AND gj."userId" = s."userId"
        ORDER BY gj."createdAt" DESC, gj."id" DESC
        LIMIT 1
      ) latest_job ON TRUE
      WHERE s."userId" = ${input.userId}
        AND s."status" = ${SkillStatus.ACTIVE}::"SkillStatus"
        AND s."dueAt" IS NOT NULL
        AND s."dueAt" <= ${input.now}
        ${collectionFilter}
        AND (
          s."firstIntroducedAt" IS NOT NULL
          OR s."lastReviewedAt" IS NOT NULL
          OR s."repetitions" > 0
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "exercises" e
          WHERE e."userId" = s."userId"
            AND e."skillId" = s."id"
            AND ${buildReadyExerciseSql({
              repetitions: Prisma.sql`s."repetitions"`,
              alreadyStudied: Prisma.sql`s."alreadyStudied"`,
              textPolicy: Prisma.sql`COALESCE(
                s."textPolicy",
                c."textPolicy",
                ${DEFAULT_READY_TEXT_POLICY_SQL}
              )`,
            })}
        )
    ),
    all_findings AS (
      SELECT * FROM review_findings
      UNION ALL
      SELECT * FROM preparation_findings
    )
    SELECT
      skill_id,
      skill_title,
      collection_name,
      due_at,
      kind,
      sort_at,
      review_count,
      miss_count,
      latest_job_status
    FROM all_findings
    WHERE (
      ${cursorSortAt}::timestamptz IS NULL
      OR sort_at < ${cursorSortAt}
      OR (sort_at = ${cursorSortAt} AND
        CASE WHEN kind = 'repeated-misses' THEN 0 ELSE 1 END > ${cursorKindRank ?? 0})
      OR (sort_at = ${cursorSortAt} AND
        CASE WHEN kind = 'repeated-misses' THEN 0 ELSE 1 END = ${cursorKindRank ?? 0}
        AND skill_id > ${cursorSkillId ?? ""})
    )
    ORDER BY sort_at DESC,
      CASE WHEN kind = 'repeated-misses' THEN 0 ELSE 1 END ASC,
      skill_id ASC
    LIMIT ${input.limit}
  `;
}

async function loadRecentReviewRows(
  userId: string,
  now: Date,
  skillIds: readonly string[],
  collectionId: string | null,
): Promise<RawReviewRow[]> {
  if (skillIds.length === 0) return [];
  const collectionFilter = collectionId
    ? Prisma.sql`AND s."collectionId" = ${collectionId}`
    : Prisma.empty;

  // The row_number window keeps history bounded to five eligible reviews per
  // selected owned skill without an N+1 query. Confirmed, pending, in-progress,
  // blocked, and completed evidence corrections all leave the signal.
  return getPrisma().$queryRaw<RawReviewRow[]>`
    WITH ranked_reviews AS (
      SELECT
        rl."skillId" AS skill_id,
        s."title" AS skill_title,
        c."name" AS collection_name,
        s."dueAt" AS due_at,
        rl."id" AS review_id,
        rl."reviewedAt" AS reviewed_at,
        ea."isCorrect" AS is_correct,
        rl."finalRating" AS final_rating,
        ROW_NUMBER() OVER (
          PARTITION BY rl."skillId"
          ORDER BY rl."reviewedAt" DESC, rl."id" DESC
        ) AS review_rank
      FROM "review_logs" rl
      INNER JOIN "exercise_attempts" ea
        ON ea."id" = rl."exerciseAttemptId"
       AND ea."userId" = rl."userId"
       AND ea."skillId" = rl."skillId"
        INNER JOIN "skills" s
        ON s."id" = rl."skillId"
       AND s."userId" = rl."userId"
       AND s."status" = ${SkillStatus.ACTIVE}::"SkillStatus"
        LEFT JOIN "collections" c
          ON c."id" = s."collectionId"
         AND c."userId" = s."userId"
      WHERE rl."userId" = ${userId}
        AND rl."skillId" IN (${Prisma.join(skillIds)})
        AND rl."reviewedAt" <= ${now}
        AND rl."previousDueAt" IS NOT NULL
        AND rl."previousDueAt" <= rl."reviewedAt"
        ${collectionFilter}
        AND ea."result" IN (${ExerciseAttemptResult.CORRECT}::"ExerciseAttemptResult", ${ExerciseAttemptResult.INCORRECT}::"ExerciseAttemptResult")
        AND COALESCE(ea."practiceContext"->>'assistance', 'none') <> 'observed'
        AND COALESCE(ea."practiceContext"->>'practiceOnly', 'false') <> 'true'
        AND COALESCE(ea."practiceContext"->>'exposure', '') NOT IN ('PRACTICE_ONLY', 'practice-only')
        AND COALESCE(ea."practiceContext"->>'sessionMode', '') <> 'PRACTICE_ONLY'
        AND NOT EXISTS (
          SELECT 1
          FROM "exercise_flags" ef
          WHERE ef."exerciseId" = ea."exerciseId"
            AND ef."userId" = ea."userId"
            AND (
              ef."adjudicationStatus" = ${ExerciseFlagAdjudicationStatus.CONFIRMED}::"ExerciseFlagAdjudicationStatus"
              OR ef."practiceEvidenceNeedsCorrection" = TRUE
              OR ef."evidenceCorrectionStatus" <> ${ExerciseEvidenceCorrectionStatus.NOT_REQUIRED}::"ExerciseEvidenceCorrectionStatus"
            )
        )
    )
    SELECT skill_id, skill_title, collection_name, due_at, review_id, reviewed_at, is_correct, final_rating
    FROM ranked_reviews
    WHERE review_rank <= ${NEEDS_ATTENTION_REVIEW_WINDOW}
    ORDER BY skill_id ASC, reviewed_at ASC, review_id ASC
  `;
}

async function loadPreparationSkills(
  userId: string,
  skillIds: readonly string[],
  collectionId: string | null,
): Promise<PreparationSkillRecord[]> {
  if (skillIds.length === 0) return [];

  return getPrisma().skill.findMany({
    where: {
      userId,
      id: { in: [...skillIds] },
      ...(collectionId ? { collectionId } : {}),
    },
    select: {
      id: true,
      title: true,
      dueAt: true,
      repetitions: true,
      alreadyStudied: true,
      textPolicy: true,
      collection: { select: { name: true, textPolicy: true } },
      exercises: {
        where: {
          verificationStatus: ExerciseVerificationStatus.VERIFIED,
          retiredAt: null,
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: PREPARATION_EXERCISE_SCAN_LIMIT,
        select: {
          answerKind: true,
          verificationStatus: true,
          retiredAt: true,
          choices: true,
          answerSpec: true,
        },
      },
      generationJobs: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { status: true },
      },
    },
  });
}

function buildNeedsAttentionItems(input: {
  now: Date;
  candidates: readonly RawFindingCandidate[];
  reviewRows: readonly RawReviewRow[];
  preparationSkills: readonly PreparationSkillRecord[];
}): NeedsAttentionItem[] {
  const reviewsBySkill = new Map<string, NeedsAttentionReviewEvidence[]>();

  for (const row of input.reviewRows) {
    const reviews = reviewsBySkill.get(row.skill_id) ?? [];
    reviews.push({
      id: row.review_id,
      reviewedAt: row.reviewed_at,
      isCorrect: row.is_correct,
      finalRating: row.final_rating,
      scheduled: true,
    });
    reviewsBySkill.set(row.skill_id, reviews);
  }

  const items: NeedsAttentionItem[] = [];
  const preparationBySkill = new Map(
    input.preparationSkills.map((skill) => [skill.id, skill]),
  );

  for (const candidate of input.candidates) {
    if (candidate.kind === "repeated-misses") {
      const reviews = reviewsBySkill.get(candidate.skill_id) ?? [];
      const finding = detectRepeatedMisses({ reviews, now: input.now });
      if (!finding) continue;

      items.push({
        skillId: candidate.skill_id,
        skillTitle: candidate.skill_title,
        collectionName: candidate.collection_name,
        kind: "repeated-misses",
        reason: formatRepeatedMissesReason(finding),
        reasonCode: "repeated-misses",
        lastReviewedAt: finding.lastReviewedAt,
        dueAt: candidate.due_at,
        reviews: finding.reviews.map(toPublicReview),
        repeatedMisses: finding,
        preparation: null,
        links: buildNeedsAttentionLinks(candidate.skill_id),
      });
      continue;
    }

    const skill = preparationBySkill.get(candidate.skill_id);
    if (!skill) continue;
    const textPolicy = resolveReadModelTextPolicy({
      skill: skill.textPolicy,
      collection: skill.collection?.textPolicy,
    });
    const ready = skill.exercises.some((exercise) =>
      isPracticeReadModelExerciseReady(exercise, { ...skill, textPolicy }),
    );
    if (ready) continue;

    const latestJobStatus =
      skill.generationJobs[0]?.status ?? candidate.latest_job_status;
    const reasonCode = resolvePreparationReasonCode(latestJobStatus);
    const finding: PreparationFinding = { reasonCode, latestJobStatus };
    items.push({
      skillId: candidate.skill_id,
      skillTitle: candidate.skill_title,
      collectionName: candidate.collection_name,
      kind: "preparation",
      reason: formatPreparationReason(finding),
      reasonCode,
      lastReviewedAt: null,
      dueAt: candidate.due_at,
      reviews: [],
      repeatedMisses: null,
      preparation: finding,
      links: buildNeedsAttentionLinks(candidate.skill_id),
    });
  }

  return items;
}

function resolvePreparationReasonCode(
  status: GenerationJobStatus | null,
): PreparationFinding["reasonCode"] {
  if (status === GenerationJobStatus.FAILED) return "preparation-failed";
  if (
    status === GenerationJobStatus.PENDING ||
    status === GenerationJobStatus.RUNNING
  ) {
    return "preparation-in-progress";
  }
  return "no-ready-exercises";
}

function toPublicReview(
  review: NeedsAttentionReviewEvidence,
): NeedsAttentionReview {
  return {
    id: review.id,
    reviewedAt: review.reviewedAt,
    isCorrect: review.isCorrect,
    finalRating: review.finalRating,
  };
}

export function buildNeedsAttentionLinks(skillId: string): NeedsAttentionLinks {
  const encodedSkillId = encodeURIComponent(skillId);
  const skill = `/skills/${encodedSkillId}`;
  return {
    skill,
    practice: `/practice/custom?skillId=${encodedSkillId}`,
    guidance: `${skill}#skill-detail-guidance`,
    source: `${skill}#skill-source-title`,
    controls: `${skill}#skill-lifecycle-title`,
  };
}

function candidateToSortKey(
  candidate: RawFindingCandidate,
): NeedsAttentionSortKey {
  return {
    kind: candidate.kind,
    skillId: candidate.skill_id,
    sortAt: candidate.sort_at,
  };
}

function toSortKey(item: NeedsAttentionItem): NeedsAttentionSortKey {
  return {
    kind: item.kind,
    skillId: item.skillId,
    sortAt: item.lastReviewedAt ?? item.dueAt ?? new Date(0),
  };
}

function compareNeedsAttentionItems(
  left: NeedsAttentionItem,
  right: NeedsAttentionItem,
): number {
  return compareSortKey(toSortKey(left), toSortKey(right));
}

function compareSortKey(
  left: NeedsAttentionSortKey,
  right: NeedsAttentionSortKey,
): number {
  const timeDifference = right.sortAt.getTime() - left.sortAt.getTime();
  if (timeDifference !== 0) return timeDifference;

  const kindDifference =
    attentionKindRank(left.kind) - attentionKindRank(right.kind);
  if (kindDifference !== 0) return kindDifference;

  return left.skillId.localeCompare(right.skillId);
}

function attentionKindRank(kind: NeedsAttentionKind): number {
  return kind === "repeated-misses" ? 0 : 1;
}

function encodeNeedsAttentionCursor(key: NeedsAttentionSortKey): string {
  const cursor: NeedsAttentionCursor = {
    version: 1,
    kind: key.kind,
    skillId: key.skillId,
    sortAt: key.sortAt,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeNeedsAttentionCursor(
  value: string | null | undefined,
): NeedsAttentionCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as {
      version?: unknown;
      kind?: unknown;
      skillId?: unknown;
      sortAt?: unknown;
    };
    if (
      parsed.version !== 1 ||
      (parsed.kind !== "repeated-misses" && parsed.kind !== "preparation") ||
      typeof parsed.skillId !== "string" ||
      typeof parsed.sortAt !== "string"
    ) {
      throw new NeedsAttentionCursorError();
    }
    const sortAt = new Date(parsed.sortAt);
    if (!parsed.skillId.trim() || !Number.isFinite(sortAt.getTime()))
      throw new NeedsAttentionCursorError();
    return { version: 1, kind: parsed.kind, skillId: parsed.skillId, sortAt };
  } catch (error) {
    if (error instanceof NeedsAttentionCursorError) throw error;
    throw new NeedsAttentionCursorError();
  }
}

function normalizeNeedsAttentionLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit))
    return NEEDS_ATTENTION_DEFAULT_LIMIT;
  return Math.min(NEEDS_ATTENTION_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

function assertValidNow(now: Date) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new Error("getNeedsAttention requires a valid now Date.");
  }
}
