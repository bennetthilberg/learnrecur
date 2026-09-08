import "server-only";

import { randomUUID } from "node:crypto";

import {
  AnswerKind,
  CollectionStatus,
  ExerciseAttemptResult,
  ExerciseVerificationStatus,
  FsrsRating,
  Prisma,
  SkillStatus,
  type Exercise,
  type Skill,
} from "@/generated/prisma/client";
import {
  checkAnswer,
  choiceAnswerSpecSchema,
  isUsableChoicePresentation,
  isUsableMathAnswerSpec,
  numericAnswerSpecSchema,
  textAnswerSpecSchema,
  type AnswerCheckResult,
} from "@/lib/answer-checking";
import {
  getDailyNewSkillAllowance,
  recordSkillIntroduction,
} from "@/lib/practice/daily-limit";
import {
  commitPracticeOnlyAttemptInTransaction,
  commitPracticeReviewInTransaction,
  type PracticeExerciseSummary,
  type PracticeSubmittedAnswer,
  type PracticeSkillSummary,
} from "@/lib/practice";
import { getPrisma } from "@/lib/prisma";
import { isExactInputUnlocked } from "@/lib/skills";

import {
  customPracticeSessionCreateInputSchema,
  customPracticeSessionItemSchema,
  customPracticeSessionPlanSchema,
  customPracticeSessionRecordSchema,
  createCustomPracticeAttemptId,
  createCustomPracticeSessionItemKey,
  MAX_CUSTOM_PRACTICE_SESSION_ITEMS,
  MAX_CUSTOM_PRACTICE_SCOPE_SKILLS,
  normalizeCustomPracticeSessionScope,
  RECENTLY_MISSED_LOOKBACK_DAYS,
  type CustomPracticeSessionItem,
  type CustomPracticeSessionMode,
  type CustomPracticeSessionPlan,
  type CustomPracticeSessionRecord,
  type CustomPracticeSessionScope,
  type CustomPracticeSessionStatus,
  type CustomPracticeSessionSetupResult,
} from "./custom-session-contracts";
import { selectMixedReviewSkill } from "./mixed-review";

const CUSTOM_SESSION_MISSING_MESSAGE = "That practice session is no longer available.";
const CUSTOM_SESSION_STOPPED_MESSAGE = "This practice session is stopped. Resume it to continue.";
const CUSTOM_SESSION_COMPLETED_MESSAGE = "This practice session is complete.";
const CUSTOM_SESSION_PREPARING_MESSAGE =
  "No verified compatible exercises are ready in this session scope yet.";
const CUSTOM_SESSION_INVALID_SCOPE_MESSAGE =
  "One or more selected skills or collections are no longer available to this account.";
const CUSTOM_SESSION_DAILY_LIMIT_MESSAGE =
  "Your daily new-skill limit is reached. Resume this session after the limit resets or change it in Settings.";

const CUSTOM_ANSWER_KINDS = [
  AnswerKind.CHOICE,
  AnswerKind.TEXT,
  AnswerKind.NUMERIC,
  AnswerKind.MATH,
] as const;

type SessionDbClient = Prisma.TransactionClient;

type SessionSkill = Pick<
  Skill,
  | "id"
  | "userId"
  | "title"
  | "collectionId"
  | "status"
  | "dueAt"
  | "stability"
  | "difficulty"
  | "elapsedDays"
  | "scheduledDays"
  | "learningSteps"
  | "repetitions"
  | "lapses"
  | "fsrsState"
  | "lastReviewedAt"
  | "alreadyStudied"
  | "firstIntroducedAt"
  | "tags"
  | "objective"
>;

type SessionExercise = Pick<
  Exercise,
  | "id"
  | "userId"
  | "skillId"
  | "type"
  | "answerKind"
  | "prompt"
  | "choices"
  | "answerSpec"
  | "correctAnswerDisplay"
  | "explanation"
  | "difficulty"
  | "expectedSeconds"
  | "verificationStatus"
  | "retiredAt"
  | "createdAt"
> & { skill: SessionSkill };

type SessionCandidate = {
  exercise: SessionExercise;
  attempts: number;
};

export type CustomPracticeReadyItem = {
  status: "ready";
  session: CustomPracticeSessionRecord;
  sessionItem: CustomPracticeSessionItem;
  skill: PracticeSkillSummary;
  exercise: PracticeExerciseSummary;
};

export type CustomPracticeSessionView =
  | CustomPracticeReadyItem
  | {
      status: "completed" | "stopped" | "preparing" | "daily-limit" | "unavailable";
      session?: CustomPracticeSessionRecord;
      message: string;
    };

export type CustomPracticePreviewResult =
  | {
      status: "checked";
      answerCheck: AnswerCheckResult;
      correctChoiceId: string | null;
      correctAnswerDisplay: string;
      explanation: string | null;
    }
  | {
      status: "not-found" | "unavailable";
      message: string;
    };

export type CustomPracticeCommitResult =
  | {
      status: "committed";
      idempotent: boolean;
      completedCount: number;
      targetCount: number;
      next: CustomPracticeSessionView;
    }
  | {
      status:
        | "invalid-answer"
        | "not-found"
        | "conflict"
        | "not-presented"
        | "unavailable";
      message: string;
    };

export type CustomPracticeSessionMutationResult =
  | { status: "updated"; session: CustomPracticeSessionRecord }
  | { status: "not-found"; message: string }
  | { status: "conflict"; message: string };

export async function createCustomPracticeSession(input: {
  userId: string;
  mode?: CustomPracticeSessionMode;
  targetCount?: number;
  scope: CustomPracticeSessionScope;
  now?: Date;
  transaction?: Prisma.TransactionClient;
}): Promise<CustomPracticeSessionSetupResult> {
  const now = input.now ?? new Date();
  const parsed = customPracticeSessionCreateInputSchema.parse({
    mode: input.mode,
    targetCount: input.targetCount,
    scope: normalizeCustomPracticeSessionScope(input.scope),
  });
  const sessionId = randomUUID();

  const createInTransaction = async (tx: Prisma.TransactionClient) => {
    await lockUser(tx, input.userId);
    const invalidScopeMessage = await validateCustomPracticeSessionScope(
      tx,
      input.userId,
      parsed.scope,
    );
    if (invalidScopeMessage) {
      return { status: "unavailable" as const, message: invalidScopeMessage };
    }
    const plan = await buildSessionPlan(tx, {
      userId: input.userId,
      sessionId,
      mode: parsed.mode,
      targetCount: parsed.targetCount,
      scope: parsed.scope,
      now,
    });
    return createSessionRow(tx, {
      id: sessionId,
      userId: input.userId,
      mode: parsed.mode,
      targetCount: parsed.targetCount,
      scope: parsed.scope,
      plan,
      now,
    });
  };
  const created = input.transaction
    ? await createInTransaction(input.transaction)
    : await getPrisma().$transaction(createInTransaction);
  if (created.status === "unavailable") return created;
  const session = created;

  if (session.plan.length === 0) {
    return {
      status: "preparing",
      session,
      message: CUSTOM_SESSION_PREPARING_MESSAGE,
    };
  }

  return { status: "ready", session };
}

async function validateCustomPracticeSessionScope(
  tx: SessionDbClient,
  userId: string,
  scope: CustomPracticeSessionScope,
): Promise<string | null> {
  const [collections, skills] = await Promise.all([
    scope.collectionIds.length === 0
      ? Promise.resolve([])
      : tx.collection.findMany({
          where: {
            userId,
            id: { in: scope.collectionIds },
            status: CollectionStatus.ACTIVE,
          },
          select: { id: true },
        }),
    scope.skillIds.length === 0
      ? Promise.resolve([])
      : tx.skill.findMany({
          where: {
            userId,
            id: { in: scope.skillIds },
            status: SkillStatus.ACTIVE,
          },
          select: { id: true },
        }),
  ]);

  if (
    collections.length !== scope.collectionIds.length ||
    skills.length !== scope.skillIds.length
  ) {
    return CUSTOM_SESSION_INVALID_SCOPE_MESSAGE;
  }
  return null;
}

export async function getCustomPracticeSession(
  userId: string,
  sessionId: string,
): Promise<CustomPracticeSessionRecord | null> {
  const delegate = getSessionDelegate(getPrisma());
  const row = await delegate.findFirst({
    where: { id: sessionId, userId },
  });
  return row ? parseSessionRow(row) : null;
}

export async function presentCustomPracticeSessionItem(input: {
  userId: string;
  sessionId: string;
  now?: Date;
}): Promise<CustomPracticeSessionView> {
  const now = input.now ?? new Date();

  return getPrisma().$transaction(async (rawTx) => {
    const tx = rawTx;
    await lockUser(tx, input.userId);
    const session = await lockSession(tx, input.userId, input.sessionId);

    if (!session) {
      return { status: "unavailable" as const, message: CUSTOM_SESSION_MISSING_MESSAGE };
    }
    if (session.status === "STOPPED") {
      return { status: "stopped" as const, session, message: CUSTOM_SESSION_STOPPED_MESSAGE };
    }
    if (session.status === "COMPLETED") {
      return { status: "completed" as const, session, message: CUSTOM_SESSION_COMPLETED_MESSAGE };
    }

    let current = session;
    if (current.plan.length === 0) {
      const plan = await buildSessionPlan(tx, {
        userId: input.userId,
        sessionId: current.id,
        mode: current.mode,
        targetCount: current.targetCount,
        scope: current.scope,
        now,
      });
      if (plan.length > 0) {
        current = await updateSessionRow(tx, current, {
          plan,
          version: current.version + 1,
        });
      }
    }

    const allowance = await getDailyNewSkillAllowance(tx, input.userId, now);
    const selection = await selectNextSessionItem(tx, current, now, {
      allowUnintroduced: allowance.remaining !== 0,
    });
    if (selection.status !== "selected") {
      return selection.result;
    }

    const isIntroduced = isSkillIntroduced(selection.skill);
    if (!isIntroduced && allowance.remaining === 0) {
      return {
        status: "daily-limit" as const,
        session: current,
        message: CUSTOM_SESSION_DAILY_LIMIT_MESSAGE,
      };
    }

    if (!isIntroduced) {
      await recordSkillIntroduction(tx, input.userId, selection.skill.id, now);
    }

    const presentedItem = updatePlanItem(selection.sessionItem, {
      status: "PRESENTED",
      presentedAt: selection.sessionItem.presentedAt ?? now,
    });
    const nextSession = await updateSessionRow(tx, selection.session, {
      plan: replacePlanItem(selection.session.plan, presentedItem),
      nextIndex: presentedItem.ordinal,
      version: selection.session.version + 1,
    });

    return toReadyItem(nextSession, presentedItem, selection.exercise);
  });
}

export async function previewCustomPracticeAnswer(input: {
  userId: string;
  sessionId: string;
  itemKey: string;
  exerciseId: string;
  submittedAnswer: PracticeSubmittedAnswer;
  now?: Date;
}): Promise<CustomPracticePreviewResult> {
  const session = await getCustomPracticeSession(input.userId, input.sessionId);
  if (!session) {
    return { status: "not-found", message: CUSTOM_SESSION_MISSING_MESSAGE };
  }
  if (session.status === "STOPPED") {
    return { status: "unavailable", message: CUSTOM_SESSION_STOPPED_MESSAGE };
  }
  if (session.status === "COMPLETED") {
    return { status: "unavailable", message: CUSTOM_SESSION_COMPLETED_MESSAGE };
  }
  const item = session.plan.find((candidate) => candidate.itemKey === input.itemKey);
  if (!item || item.exerciseId !== input.exerciseId || item.status !== "PRESENTED") {
    return { status: "unavailable", message: "This practice item is no longer available." };
  }

  const exercise = await findCurrentSessionExercise(
    getPrisma(),
    input.userId,
    session,
    item,
    input.now ?? new Date(),
  );
  if (!exercise) {
    return { status: "unavailable", message: "This exercise is no longer available in this session." };
  }

  const answerCheck = checkAnswer({
    answerSpec: exercise.answerSpec,
    choices: exercise.choices,
    submittedAnswer: input.submittedAnswer,
  });
  return {
    status: "checked",
    answerCheck,
    correctChoiceId: getCorrectChoiceId(exercise),
    correctAnswerDisplay: exercise.correctAnswerDisplay,
    explanation: exercise.explanation,
  };
}

export async function commitCustomPracticeAnswer(input: {
  userId: string;
  sessionId: string;
  itemKey: string;
  exerciseId: string;
  submittedAnswer: PracticeSubmittedAnswer;
  responseMs?: number | null;
  manualRating?: FsrsRating | null;
  reducedRuleCues?: boolean;
  now?: Date;
}): Promise<CustomPracticeCommitResult> {
  const now = input.now ?? new Date();

  const result = await getPrisma().$transaction(async (rawTx) => {
    const tx = rawTx;
    await lockUser(tx, input.userId);
    const session = await lockSession(tx, input.userId, input.sessionId);

    if (!session) {
      return {
        status: "not-found" as const,
        message: CUSTOM_SESSION_MISSING_MESSAGE,
      };
    }

    const sessionItem = session.plan.find((item) => item.itemKey === input.itemKey);
    if (!sessionItem || sessionItem.exerciseId !== input.exerciseId) {
      return { status: "not-found" as const, message: "This practice item is not in the session." };
    }
    if (sessionItem.status === "COMPLETED") {
      const existingAttempt = await tx.exerciseAttempt.findUnique({
        where: { id: sessionItem.attemptId },
      });
      if (
        !existingAttempt ||
        existingAttempt.userId !== input.userId ||
        existingAttempt.exerciseId !== sessionItem.exerciseId ||
        existingAttempt.skillId !== sessionItem.skillId
      ) {
        return {
          status: "conflict" as const,
          message: "This completed item is missing its saved attempt.",
        };
      }
      if (
        !(await replayAnswerMatchesAttempt(tx, existingAttempt, {
          userId: input.userId,
          exerciseId: input.exerciseId,
          expectedSkillId: sessionItem.skillId,
          submittedAnswer: input.submittedAnswer,
        }))
      ) {
        return {
          status: "conflict" as const,
          message: "This item was already saved with a different answer.",
        };
      }
      return {
        status: "committed" as const,
        idempotent: true,
        completedCount: session.completedCount,
        targetCount: session.targetCount,
        session,
      };
    }
    if (session.status === "STOPPED") {
      return { status: "unavailable" as const, message: CUSTOM_SESSION_STOPPED_MESSAGE };
    }
    if (session.status === "COMPLETED") {
      return { status: "unavailable" as const, message: CUSTOM_SESSION_COMPLETED_MESSAGE };
    }
    if (sessionItem.status === "PENDING") {
      return {
        status: "not-presented" as const,
        message: "Present this practice item before submitting an answer.",
      };
    }
    if (sessionItem.status === "SKIPPED") {
      return { status: "unavailable" as const, message: "This practice item was skipped." };
    }

    const exercise = await findCurrentSessionExercise(
      tx,
      input.userId,
      session,
      sessionItem,
      now,
    );
    if (!exercise) {
      return {
        status: "unavailable" as const,
        message: "This exercise is no longer available in this session.",
      };
    }

    const commonInput = {
      userId: input.userId,
      exerciseId: input.exerciseId,
      expectedSkillId: sessionItem.skillId,
      attemptId: sessionItem.attemptId,
      submittedAnswer: input.submittedAnswer,
      responseMs: input.responseMs,
      now,
      answerKinds: CUSTOM_ANSWER_KINDS,
      collectionId: session.scope.collectionIds.length === 1 ? session.scope.collectionIds[0] : null,
      mixedReview: session.scope.mixedReview,
      reducedRuleCues: session.scope.mixedReview && input.reducedRuleCues === true,
    } as const;

    const attemptResult =
      session.mode === "PRACTICE_ONLY"
        ? await commitPracticeOnlyAttemptInTransaction(tx, {
            ...commonInput,
            sessionContext: {
              sessionId: session.id,
              sessionMode: "PRACTICE_ONLY",
              exposure: "PRACTICE_ONLY",
            },
          })
        : await commitPracticeReviewInTransaction(tx, {
            ...commonInput,
            reviewedAt: now,
            manualRating: input.manualRating ?? null,
            allowNotDue: false,
            sessionContext: {
              sessionId: session.id,
              sessionMode: "SCHEDULED",
              exposure: "SCHEDULED",
            },
          });

    if (attemptResult.status !== "committed") {
      return toCustomCommitFailure(attemptResult);
    }

    const completedItem = updatePlanItem(sessionItem, {
      status: "COMPLETED",
      completedAt: sessionItem.completedAt ?? now,
      presentedAt: sessionItem.presentedAt ?? now,
    });
    const completedCount = session.completedCount + 1;
    const nextIndex = findNextPlanIndex(session.plan, completedItem.ordinal + 1);
    // Let the post-commit presentation step replenish an undersized plan before
    // deciding that no eligible inventory remains.
    const sessionStatus = completedCount >= session.targetCount ? "COMPLETED" : "ACTIVE";
    const updatedSession = await updateSessionRow(tx, session, {
      plan: replacePlanItem(session.plan, completedItem),
      completedCount,
      nextIndex: nextIndex ?? session.plan.length,
      status: sessionStatus,
      completedAt: sessionStatus === "COMPLETED" ? now : null,
      version: session.version + 1,
    });

    return {
      status: "committed" as const,
      idempotent: attemptResult.idempotent,
      completedCount: updatedSession.completedCount,
      targetCount: updatedSession.targetCount,
      session: updatedSession,
    };
  });

  if (result.status !== "committed") {
    return result;
  }

  const next = await presentCustomPracticeSessionItem({
    userId: input.userId,
    sessionId: input.sessionId,
    now,
  });
  return {
    status: "committed",
    idempotent: result.idempotent,
    completedCount: result.completedCount,
    targetCount: result.targetCount,
    next,
  };
}

async function replayAnswerMatchesAttempt(
  tx: SessionDbClient,
  existingAttempt: {
    userId: string;
    exerciseId: string;
    skillId: string;
    isCorrect: boolean;
    normalizedAnswer: string | null;
  },
  input: {
    userId: string;
    exerciseId: string;
    expectedSkillId: string;
    submittedAnswer: PracticeSubmittedAnswer;
  },
): Promise<boolean> {
  const exercise = await tx.exercise.findFirst({
    where: {
      id: input.exerciseId,
      userId: input.userId,
      skillId: input.expectedSkillId,
      verificationStatus: ExerciseVerificationStatus.VERIFIED,
    },
    select: { answerSpec: true, choices: true },
  });
  if (!exercise) return false;
  const answerCheck = checkAnswer({
    answerSpec: exercise.answerSpec,
    choices: exercise.choices,
    submittedAnswer: input.submittedAnswer,
  });
  return (
    (answerCheck.status === "correct" || answerCheck.status === "incorrect") &&
    answerCheck.isCorrect === existingAttempt.isCorrect &&
    answerCheck.normalizedAnswer === existingAttempt.normalizedAnswer
  );
}

export async function stopCustomPracticeSession(input: {
  userId: string;
  sessionId: string;
  now?: Date;
  transaction?: Prisma.TransactionClient;
}): Promise<CustomPracticeSessionMutationResult> {
  const now = input.now ?? new Date();
  return mutateCustomPracticeSession(input, {
    status: "STOPPED",
    stoppedAt: now,
  });
}

export async function resumeCustomPracticeSession(input: {
  userId: string;
  sessionId: string;
  now?: Date;
  transaction?: Prisma.TransactionClient;
}): Promise<CustomPracticeSessionMutationResult> {
  return mutateCustomPracticeSession(input, {
    status: "ACTIVE",
    stoppedAt: null,
  });
}

async function mutateCustomPracticeSession(
  input: {
    userId: string;
    sessionId: string;
    now?: Date;
    transaction?: Prisma.TransactionClient;
  },
  data: { status: CustomPracticeSessionStatus; stoppedAt: Date | null },
): Promise<CustomPracticeSessionMutationResult> {
  const mutateInTransaction = async (tx: Prisma.TransactionClient) => {
    await lockUser(tx, input.userId);
    const session = await lockSession(tx, input.userId, input.sessionId);
    if (!session) {
      return { status: "not-found" as const, message: CUSTOM_SESSION_MISSING_MESSAGE };
    }
    if (session.status === "COMPLETED") {
      return { status: "conflict" as const, message: CUSTOM_SESSION_COMPLETED_MESSAGE };
    }
    return {
      status: "updated" as const,
      session: await updateSessionRow(tx, session, {
        ...data,
        version: session.version + 1,
      }),
    };
  };
  return input.transaction
    ? mutateInTransaction(input.transaction)
    : getPrisma().$transaction(mutateInTransaction);
}

async function selectNextSessionItem(
  tx: SessionDbClient,
  session: CustomPracticeSessionRecord,
  now: Date,
  options: { allowUnintroduced?: boolean } = {},
  refillAttempt = 0,
): Promise<
  | {
      status: "selected";
      session: CustomPracticeSessionRecord;
      sessionItem: CustomPracticeSessionItem;
      exercise: SessionExercise;
      skill: SessionSkill;
    }
  | { status: "result"; result: CustomPracticeSessionView }
> {
  let current = session;
  current = await replenishSessionPlan(tx, current, now);
  const plan = [...current.plan].sort((left, right) => left.ordinal - right.ordinal);
  const pendingItems = plan.filter(
    (item) => item.status === "PENDING" || item.status === "PRESENTED",
  );
  const eligibleExercises = await findCurrentSessionExercises(
    tx,
    session.userId,
    current,
    pendingItems,
    now,
  );
  let blockedByDailyLimit = false;
  const ineligibleItems = pendingItems.filter((item) => !eligibleExercises.has(item.itemKey));
  if (ineligibleItems.length > 0) {
    const ineligibleKeys = new Set(ineligibleItems.map((item) => item.itemKey));
    const nextPlan = current.plan.map((item) =>
      ineligibleKeys.has(item.itemKey)
        ? updatePlanItem(item, { status: "SKIPPED", completedAt: null })
        : item,
    );
    current = await updateSessionRow(tx, current, {
      plan: customPracticeSessionPlanSchema.parse(nextPlan),
      nextIndex: findNextPlanIndex(nextPlan, 0) ?? nextPlan.length,
      version: current.version + 1,
    });
  }

  for (const item of current.plan) {
    if (item.status === "COMPLETED" || item.status === "SKIPPED") {
      continue;
    }
    const exercise = eligibleExercises.get(item.itemKey);
    if (!exercise) continue;
    if (!options.allowUnintroduced && !isSkillIntroduced(exercise.skill)) {
      blockedByDailyLimit = true;
      continue;
    }
    return { status: "selected", session: current, sessionItem: item, exercise, skill: exercise.skill };
  }

  const hasPendingInventory = current.plan.some(
    (item) => item.status === "PENDING" || item.status === "PRESENTED",
  );
  if (ineligibleItems.length > 0 && refillAttempt < MAX_CUSTOM_PRACTICE_SESSION_ITEMS) {
    return selectNextSessionItem(tx, current, now, options, refillAttempt + 1);
  }
  if (blockedByDailyLimit) {
    return {
      status: "result",
      result: {
        status: "daily-limit",
        session: current,
        message: CUSTOM_SESSION_DAILY_LIMIT_MESSAGE,
      },
    };
  }
  if (current.completedCount >= current.targetCount || !hasPendingInventory) {
    const completed =
      current.status === "COMPLETED"
        ? current
        : await updateSessionRow(tx, current, {
            status: "COMPLETED",
            completedAt: now,
            nextIndex: current.plan.length,
            version: current.version + 1,
          });
    return {
      status: "result",
      result: {
        status: "completed",
        session: completed,
        message:
          completed.completedCount >= completed.targetCount
            ? CUSTOM_SESSION_COMPLETED_MESSAGE
            : "This session ended because no selected exercise remains available.",
      },
    };
  }

  return {
    status: "result",
    result: {
      status: "preparing",
      session: current,
      message: CUSTOM_SESSION_PREPARING_MESSAGE,
    },
  };
}

type SessionPlanBuildInput = {
  userId: string;
  sessionId: string;
  mode: CustomPracticeSessionMode;
  targetCount: number;
  scope: CustomPracticeSessionScope;
  now: Date;
};

async function buildSessionPlan(
  tx: SessionDbClient,
  input: SessionPlanBuildInput,
): Promise<CustomPracticeSessionPlan> {
  const candidates = await buildSessionCandidates(tx, input);
  return customPracticeSessionPlanSchema.parse(
    candidates
      .slice(0, input.targetCount)
      .map(({ exercise }, ordinal) => createSessionItem(input.sessionId, exercise, ordinal)),
  );
}

async function buildSessionCandidates(
  tx: SessionDbClient,
  input: SessionPlanBuildInput & { excludeExerciseIds?: readonly string[] },
): Promise<SessionCandidate[]> {
  const missedSince = new Date(
    input.now.getTime() - RECENTLY_MISSED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  const skillWhere: Prisma.SkillWhereInput = {
    userId: input.userId,
    status: SkillStatus.ACTIVE,
    ...(input.scope.collectionIds.length > 0
      ? { collectionId: { in: input.scope.collectionIds } }
      : {}),
    ...(input.scope.skillIds.length > 0
      ? { id: { in: input.scope.skillIds } }
      : {}),
    ...(input.scope.tags.length > 0
      ? { tags: { hasEvery: input.scope.tags } }
      : {}),
    ...(input.scope.recentlyMissed
      ? {
          attempts: {
            some: {
              userId: input.userId,
              result: ExerciseAttemptResult.INCORRECT,
              createdAt: { gte: missedSince, lte: input.now },
            },
          },
        }
      : {}),
    ...(input.mode === "SCHEDULED"
      ? { dueAt: { not: null, lte: input.now } }
      : {}),
    stability: { not: null },
    difficulty: { not: null },
  };

  const skills = (await tx.skill.findMany({
    where: skillWhere,
    orderBy: [{ dueAt: "asc" }, { id: "asc" }],
    take: MAX_CUSTOM_PRACTICE_SCOPE_SKILLS,
  })) as SessionSkill[];
  if (skills.length === 0) return [];

  const exercises = (await tx.exercise.findMany({
    where: {
      userId: input.userId,
      skillId: { in: skills.map((skill) => skill.id) },
      verificationStatus: ExerciseVerificationStatus.VERIFIED,
      retiredAt: null,
      answerKind: { in: [...CUSTOM_ANSWER_KINDS] },
      ...(input.excludeExerciseIds && input.excludeExerciseIds.length > 0
        ? { id: { notIn: [...input.excludeExerciseIds] } }
        : {}),
    },
    include: { skill: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  })) as unknown as SessionExercise[];
  const allowedSkillIds = new Set(skills.map((skill) => skill.id));
  const eligibleExercises = exercises.filter(
    (exercise) =>
      allowedSkillIds.has(exercise.skillId) &&
      hasCompatibleSessionAnswerSpec(exercise) &&
      isSessionExerciseUnlocked(exercise),
  );
  if (eligibleExercises.length === 0) return [];

  const attemptStats = await tx.exerciseAttempt.groupBy({
    by: ["exerciseId"],
    where: {
      userId: input.userId,
      exerciseId: { in: eligibleExercises.map((exercise) => exercise.id) },
    },
    _count: { id: true },
    _max: { createdAt: true },
  });
  const attemptStatsByExerciseId = new Map(
    attemptStats.map((stat) => [
      stat.exerciseId,
      { count: stat._count.id, lastAttemptedAt: stat._max.createdAt },
    ]),
  );
  const sortedBySkill = new Map<string, SessionExercise[]>();
  for (const exercise of eligibleExercises) {
    const skillExercises = sortedBySkill.get(exercise.skillId) ?? [];
    skillExercises.push(exercise);
    sortedBySkill.set(exercise.skillId, skillExercises);
  }
  for (const [skillId, skillExercises] of sortedBySkill) {
    skillExercises.sort((left, right) =>
      compareSessionExercises(left, right, attemptStatsByExerciseId),
    );
    sortedBySkill.set(skillId, skillExercises);
  }

  const skillById = new Map(skills.map((skill) => [skill.id, skill]));
  const orderedSkills = orderSessionSkills(
    [...sortedBySkill.keys()]
      .map((skillId) => skillById.get(skillId))
      .filter((skill): skill is SessionSkill => Boolean(skill))
      .sort(compareSessionSkills),
    input.scope.mixedReview,
  );
  const orderedSkillIds = orderedSkills.map((skill) => skill.id);
  const candidates: SessionCandidate[] = [];
  for (let offset = 0; ; offset += 1) {
    let added = false;
    for (const skillId of orderedSkillIds) {
      const exercise = sortedBySkill.get(skillId)?.[offset];
      if (!exercise) continue;
      candidates.push({
        exercise,
        attempts: attemptStatsByExerciseId.get(exercise.id)?.count ?? 0,
      });
      added = true;
    }
    if (!added) break;
  }
  return candidates;
}

function compareSessionSkills(left: SessionSkill, right: SessionSkill): number {
  const leftDue = left.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const rightDue = right.dueAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  return leftDue - rightDue || left.id.localeCompare(right.id);
}

function orderSessionSkills(
  skills: readonly SessionSkill[],
  mixedReview: boolean,
): SessionSkill[] {
  if (!mixedReview) return [...skills];

  const dueSkills = skills.filter(
    (skill): skill is SessionSkill & { dueAt: Date } => skill.dueAt instanceof Date,
  );
  const undatedSkills = skills.filter((skill) => skill.dueAt === null);
  const ordered: SessionSkill[] = [];
  const remaining = [...dueSkills];
  let previous: (SessionSkill & { dueAt: Date }) | null = null;

  while (remaining.length > 0) {
    const selected: (SessionSkill & { dueAt: Date }) | null = selectMixedReviewSkill(
      remaining,
      previous,
    );
    if (!selected) break;
    ordered.push(selected);
    remaining.splice(remaining.indexOf(selected), 1);
    previous = selected;
  }

  return [...ordered, ...undatedSkills];
}

function createSessionItem(
  sessionId: string,
  exercise: SessionExercise,
  ordinal: number,
): CustomPracticeSessionItem {
  return customPracticeSessionItemSchema.parse({
    ordinal,
    itemKey: createCustomPracticeSessionItemKey(ordinal),
    skillId: exercise.skillId,
    exerciseId: exercise.id,
    attemptId: createCustomPracticeAttemptId(sessionId, ordinal),
    status: "PENDING",
    presentedAt: null,
    completedAt: null,
  });
}

async function replenishSessionPlan(
  tx: SessionDbClient,
  session: CustomPracticeSessionRecord,
  now: Date,
): Promise<CustomPracticeSessionRecord> {
  if (
    session.plan.length >= session.targetCount &&
    !session.plan.some((item) => item.status === "SKIPPED")
  ) {
    return session;
  }

  const candidates = await buildSessionCandidates(tx, {
    userId: session.userId,
    sessionId: session.id,
    mode: session.mode,
    targetCount: session.targetCount,
    scope: session.scope,
    now,
    excludeExerciseIds: session.plan.map((item) => item.exerciseId),
  });
  if (candidates.length === 0) return session;

  const candidateExercises = candidates.map((candidate) => candidate.exercise);
  const skippedItems = session.plan
    .filter((item) => item.status === "SKIPPED")
    .sort((left, right) => left.ordinal - right.ordinal);
  const plan = [...session.plan];
  let candidateIndex = 0;
  for (const skipped of skippedItems) {
    const exercise = candidateExercises[candidateIndex++];
    if (!exercise) break;
    const itemIndex = plan.findIndex((item) => item.itemKey === skipped.itemKey);
    plan[itemIndex] = {
      ...createSessionItem(session.id, exercise, skipped.ordinal),
      // The old item was skipped before an attempt could use its deterministic
      // key. Keeping that key makes a replacement idempotent across reloads.
      attemptId: skipped.attemptId,
    };
  }

  const nextOrdinal =
    plan.reduce((maximum, item) => Math.max(maximum, item.ordinal), -1) + 1;
  while (plan.length < session.targetCount && candidateIndex < candidateExercises.length) {
    plan.push(createSessionItem(session.id, candidateExercises[candidateIndex++], nextOrdinal + plan.length - session.plan.length));
  }

  plan.sort((left, right) => left.ordinal - right.ordinal);
  if (
    plan.length === session.plan.length &&
    plan.every(
      (item, index) =>
        item.exerciseId === session.plan[index]?.exerciseId &&
        item.status === session.plan[index]?.status,
    )
  ) {
    return session;
  }
  return updateSessionRow(tx, session, {
    plan: customPracticeSessionPlanSchema.parse(plan),
    version: session.version + 1,
  });
}

function compareSessionExercises(
  left: SessionExercise,
  right: SessionExercise,
  stats: ReadonlyMap<string, { count: number; lastAttemptedAt: Date | null }>,
): number {
  const leftStats = stats.get(left.id) ?? { count: 0, lastAttemptedAt: null };
  const rightStats = stats.get(right.id) ?? { count: 0, lastAttemptedAt: null };
  return (
    Number(leftStats.count > 0) - Number(rightStats.count > 0) ||
    (leftStats.lastAttemptedAt?.getTime() ?? 0) -
      (rightStats.lastAttemptedAt?.getTime() ?? 0) ||
    leftStats.count - rightStats.count ||
    left.createdAt.getTime() - right.createdAt.getTime() ||
    left.id.localeCompare(right.id)
  );
}

function hasCompatibleSessionAnswerSpec(exercise: SessionExercise): boolean {
  if (exercise.answerKind === AnswerKind.CHOICE) {
    return isUsableChoicePresentation(exercise.answerSpec, exercise.choices);
  }
  if (exercise.answerKind === AnswerKind.TEXT) {
    return textAnswerSpecSchema.safeParse(exercise.answerSpec).success;
  }
  if (exercise.answerKind === AnswerKind.NUMERIC) {
    return numericAnswerSpecSchema.safeParse(exercise.answerSpec).success;
  }
  if (exercise.answerKind === AnswerKind.MATH) {
    return isUsableMathAnswerSpec(exercise.answerSpec);
  }
  return false;
}

function isSessionExerciseUnlocked(exercise: SessionExercise): boolean {
  if (
    exercise.answerKind === AnswerKind.TEXT ||
    exercise.answerKind === AnswerKind.NUMERIC ||
    exercise.answerKind === AnswerKind.MATH
  ) {
    return isExactInputUnlocked(exercise.skill.repetitions, exercise.skill.alreadyStudied);
  }
  return true;
}

export async function findCurrentSessionExercises(
  client: SessionDbClient | ReturnType<typeof getPrisma>,
  userId: string,
  session: CustomPracticeSessionRecord,
  items: readonly CustomPracticeSessionItem[],
  now: Date,
): Promise<ReadonlyMap<string, SessionExercise>> {
  if (items.length === 0) return new Map();

  const missedSince = new Date(
    now.getTime() - RECENTLY_MISSED_LOOKBACK_DAYS * 24 * 60 * 60 * 1000,
  );
  const itemByExerciseId = new Map<string, CustomPracticeSessionItem[]>();
  for (const item of items) {
    const matchingItems = itemByExerciseId.get(item.exerciseId) ?? [];
    matchingItems.push(item);
    itemByExerciseId.set(item.exerciseId, matchingItems);
  }

  const exercises = (await client.exercise.findMany({
    where: {
      id: { in: [...itemByExerciseId.keys()] },
      userId,
      skillId: { in: [...new Set(items.map((item) => item.skillId))] },
      verificationStatus: ExerciseVerificationStatus.VERIFIED,
      retiredAt: null,
      answerKind: { in: [...CUSTOM_ANSWER_KINDS] },
      skill: buildCurrentSessionSkillWhere(userId, session, now, missedSince),
    },
    include: { skill: true },
  })) as unknown as SessionExercise[];

  const eligibleByItemKey = new Map<string, SessionExercise>();
  for (const exercise of exercises) {
    const matchingItems = itemByExerciseId.get(exercise.id) ?? [];
    for (const item of matchingItems) {
      if (isCurrentSessionExerciseEligible(exercise, item)) {
        eligibleByItemKey.set(item.itemKey, exercise);
      }
    }
  }
  return eligibleByItemKey;
}

async function findCurrentSessionExercise(
  client: SessionDbClient | ReturnType<typeof getPrisma>,
  userId: string,
  session: CustomPracticeSessionRecord,
  item: CustomPracticeSessionItem,
  now: Date,
): Promise<SessionExercise | null> {
  return (
    (await findCurrentSessionExercises(client, userId, session, [item], now)).get(item.itemKey) ??
    null
  );
}

function buildCurrentSessionSkillWhere(
  userId: string,
  session: CustomPracticeSessionRecord,
  now: Date,
  missedSince: Date,
): Prisma.SkillWhereInput {
  return {
    userId,
    status: SkillStatus.ACTIVE,
    ...(session.scope.collectionIds.length > 0
      ? { collectionId: { in: session.scope.collectionIds } }
      : {}),
    ...(session.scope.skillIds.length > 0
      ? { id: { in: session.scope.skillIds } }
      : {}),
    ...(session.scope.tags.length > 0
      ? { tags: { hasEvery: session.scope.tags } }
      : {}),
    ...(session.scope.recentlyMissed
      ? {
          attempts: {
            some: {
              userId,
              result: ExerciseAttemptResult.INCORRECT,
              createdAt: { gte: missedSince, lte: now },
            },
          },
        }
      : {}),
    ...(session.mode === "SCHEDULED"
      ? { dueAt: { not: null, lte: now } }
      : {}),
    stability: { not: null },
    difficulty: { not: null },
  };
}

function isCurrentSessionExerciseEligible(
  exercise: SessionExercise,
  item: CustomPracticeSessionItem,
): boolean {
  return (
    exercise.skillId === item.skillId &&
    hasCompatibleSessionAnswerSpec(exercise) &&
    isSessionExerciseUnlocked(exercise)
  );
}

function updatePlanItem(
  item: CustomPracticeSessionItem,
  patch: Partial<CustomPracticeSessionItem>,
): CustomPracticeSessionItem {
  return customPracticeSessionItemSchema.parse({ ...item, ...patch });
}

function replacePlanItem(
  plan: CustomPracticeSessionPlan,
  item: CustomPracticeSessionItem,
): CustomPracticeSessionPlan {
  return customPracticeSessionPlanSchema.parse(
    plan.map((candidate) => (candidate.itemKey === item.itemKey ? item : candidate)),
  );
}

function findNextPlanIndex(
  plan: CustomPracticeSessionPlan,
  start: number,
): number | null {
  return (
    plan
      .filter(
        (item) =>
          item.ordinal >= start &&
          (item.status === "PENDING" || item.status === "PRESENTED"),
      )
      .sort((left, right) => left.ordinal - right.ordinal)[0]?.ordinal ?? null
  );
}

function isSkillIntroduced(skill: SessionSkill): boolean {
  return Boolean(skill.firstIntroducedAt || skill.lastReviewedAt || skill.repetitions > 0);
}

function getCorrectChoiceId(exercise: SessionExercise): string | null {
  const parsed = choiceAnswerSpecSchema.safeParse(exercise.answerSpec);
  return parsed.success ? parsed.data.correctChoiceId : null;
}

function toReadyItem(
  session: CustomPracticeSessionRecord,
  sessionItem: CustomPracticeSessionItem,
  exercise: SessionExercise,
): CustomPracticeReadyItem {
  return {
    status: "ready",
    session,
    sessionItem,
    skill: {
      id: exercise.skill.id,
      title: exercise.skill.title,
      collectionId: exercise.skill.collectionId,
      dueAt: exercise.skill.dueAt,
      stability: exercise.skill.stability,
      difficulty: exercise.skill.difficulty,
      fsrsState: exercise.skill.fsrsState,
      repetitions: exercise.skill.repetitions,
      alreadyStudied: exercise.skill.alreadyStudied,
      lapses: exercise.skill.lapses,
      lastReviewedAt: exercise.skill.lastReviewedAt,
    },
    exercise: {
      id: exercise.id,
      skillId: exercise.skillId,
      type: exercise.type,
      answerKind: exercise.answerKind,
      prompt: exercise.prompt,
      choices: exercise.choices,
      correctAnswerDisplay: exercise.correctAnswerDisplay,
      explanation: exercise.explanation,
      difficulty: exercise.difficulty,
      expectedSeconds: exercise.expectedSeconds,
    },
  };
}

function toCustomCommitFailure(
  result: { status: string; message: string },
): {
  status: "invalid-answer" | "not-found" | "conflict" | "unavailable";
  message: string;
} {
  if (result.status === "not-found") {
    return { status: "not-found", message: result.message };
  }
  if (result.status === "conflict") {
    return { status: "conflict", message: result.message };
  }
  if (result.status === "not-committed") {
    return { status: "invalid-answer", message: result.message };
  }
  return { status: "unavailable", message: result.message };
}

function getSessionDelegate(
  client: Prisma.TransactionClient | ReturnType<typeof getPrisma>,
): ReturnType<typeof getPrisma>["practiceSession"] {
  return client.practiceSession;
}

async function lockUser(tx: SessionDbClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR NO KEY UPDATE`;
}

async function lockSession(
  tx: SessionDbClient,
  userId: string,
  sessionId: string,
): Promise<CustomPracticeSessionRecord | null> {
  await tx.$queryRaw`SELECT "id" FROM "practice_sessions" WHERE "id" = ${sessionId} AND "userId" = ${userId} FOR UPDATE`;
  const row = await tx.practiceSession.findFirst({
    where: { id: sessionId, userId },
  });
  return row ? parseSessionRow(row) : null;
}

async function createSessionRow(
  tx: SessionDbClient,
  input: {
    id: string;
    userId: string;
    mode: CustomPracticeSessionMode;
    targetCount: number;
    scope: CustomPracticeSessionScope;
    plan: CustomPracticeSessionPlan;
    now: Date;
  },
): Promise<CustomPracticeSessionRecord> {
  const row = await tx.practiceSession.create({
    data: {
      id: input.id,
      userId: input.userId,
      mode: input.mode,
      status: "ACTIVE",
      targetCount: input.targetCount,
      completedCount: 0,
      nextIndex: 0,
      version: 0,
      scope: input.scope as unknown as Prisma.InputJsonValue,
      plan: serializePlan(input.plan),
      startedAt: input.now,
    },
  });
  return parseSessionRow(row);
}

async function updateSessionRow(
  tx: SessionDbClient,
  session: CustomPracticeSessionRecord,
  patch: {
    status?: CustomPracticeSessionStatus;
    plan?: CustomPracticeSessionPlan;
    scope?: CustomPracticeSessionScope;
    completedCount?: number;
    nextIndex?: number;
    version?: number;
    stoppedAt?: Date | null;
    completedAt?: Date | null;
  },
): Promise<CustomPracticeSessionRecord> {
  const data: Prisma.PracticeSessionUpdateInput = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.plan !== undefined) data.plan = serializePlan(patch.plan);
  if (patch.scope !== undefined) data.scope = patch.scope as unknown as Prisma.InputJsonValue;
  if (patch.completedCount !== undefined) data.completedCount = patch.completedCount;
  if (patch.nextIndex !== undefined) data.nextIndex = patch.nextIndex;
  if (patch.version !== undefined) data.version = patch.version;
  if (patch.stoppedAt !== undefined) data.stoppedAt = patch.stoppedAt;
  if (patch.completedAt !== undefined) data.completedAt = patch.completedAt;
  const row = await tx.practiceSession.update({
    where: { id: session.id },
    data,
  });
  return parseSessionRow(row);
}

function serializePlan(plan: CustomPracticeSessionPlan): Prisma.InputJsonValue {
  return plan.map((item) => ({
    ...item,
    presentedAt: item.presentedAt?.toISOString() ?? null,
    completedAt: item.completedAt?.toISOString() ?? null,
  })) as unknown as Prisma.InputJsonValue;
}

function parseSessionRow(row: unknown): CustomPracticeSessionRecord {
  return customPracticeSessionRecordSchema.parse(row);
}
