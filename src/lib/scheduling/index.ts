import "server-only";

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import {
  createEmptyCard,
  default_request_retention,
  fsrs,
  Rating,
  State,
  type Card,
  type Grade,
} from "ts-fsrs";

import { FsrsRating, SkillFsrsState, SkillStatus } from "@/generated/prisma/client";

export const SCHEDULER_NAME = "ts-fsrs";
const nodeRequire = createRequire(import.meta.url);
const SCHEDULER_VERSION_FALLBACK = "unknown";
export const SCHEDULER_VERSION = resolveSchedulerVersion();

export type SkillScheduleFields = {
  dueAt: Date;
  stability: number;
  difficulty: number;
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  repetitions: number;
  lapses: number;
  fsrsState: SkillFsrsState;
  lastReviewedAt: Date | null;
};

export type ReviewLogSnapshot = {
  finalRating: FsrsRating;
  reviewedAt: Date;
  previousDueAt: Date;
  nextDueAt: Date;
  previousStability: number;
  nextStability: number;
  previousDifficulty: number;
  nextDifficulty: number;
  previousElapsedDays: number;
  nextElapsedDays: number;
  previousScheduledDays: number;
  nextScheduledDays: number;
  previousLearningSteps: number;
  nextLearningSteps: number;
  previousRepetitions: number;
  nextRepetitions: number;
  previousLapses: number;
  nextLapses: number;
  previousState: SkillFsrsState;
  nextState: SkillFsrsState;
  schedulerName: typeof SCHEDULER_NAME;
  schedulerVersion: typeof SCHEDULER_VERSION;
  desiredRetention: number;
  schedulerParameters: {
    source: "ts-fsrs-defaults";
  };
};

export type AdvanceSkillScheduleInput = {
  current: SkillScheduleFields;
  rating: FsrsRating;
  reviewedAt: Date;
};

export type AdvanceSkillScheduleResult = {
  rating: FsrsRating;
  skillUpdate: SkillScheduleFields;
  reviewLog: ReviewLogSnapshot;
};

export type MapAttemptToFsrsRatingInput = {
  isCorrect: boolean;
  responseMs?: number | null;
  expectedSeconds?: number | null;
  manualRating?: FsrsRating | null;
};

export type DueSkillInput = {
  id: string;
  status: SkillStatus;
  dueAt: Date | null;
};

export function createInitialSkillSchedule(now: Date): SkillScheduleFields {
  return fromFsrsCard(createEmptyCard(now));
}

export function mapAttemptToFsrsRating(input: MapAttemptToFsrsRatingInput): FsrsRating {
  if (!input.isCorrect) {
    return FsrsRating.AGAIN;
  }

  if (
    input.manualRating === FsrsRating.HARD ||
    input.manualRating === FsrsRating.GOOD ||
    input.manualRating === FsrsRating.EASY
  ) {
    return input.manualRating;
  }

  if (
    typeof input.responseMs === "number" &&
    Number.isFinite(input.responseMs) &&
    input.responseMs >= 0 &&
    typeof input.expectedSeconds === "number" &&
    Number.isFinite(input.expectedSeconds) &&
    input.expectedSeconds > 0 &&
    input.responseMs <= input.expectedSeconds * 500
  ) {
    return FsrsRating.EASY;
  }

  return FsrsRating.GOOD;
}

export function advanceSkillSchedule(
  input: AdvanceSkillScheduleInput,
): AdvanceSkillScheduleResult {
  const scheduler = fsrs();
  const card = toFsrsCard(input.current);
  const result = scheduler.next(card, input.reviewedAt, toTsFsrsRating(input.rating));
  const skillUpdate = fromFsrsCard(result.card);

  return {
    rating: input.rating,
    skillUpdate,
    reviewLog: {
      finalRating: input.rating,
      reviewedAt: input.reviewedAt,
      previousDueAt: input.current.dueAt,
      nextDueAt: skillUpdate.dueAt,
      previousStability: input.current.stability,
      nextStability: skillUpdate.stability,
      previousDifficulty: input.current.difficulty,
      nextDifficulty: skillUpdate.difficulty,
      previousElapsedDays: input.current.elapsedDays,
      nextElapsedDays: skillUpdate.elapsedDays,
      previousScheduledDays: input.current.scheduledDays,
      nextScheduledDays: skillUpdate.scheduledDays,
      previousLearningSteps: input.current.learningSteps,
      nextLearningSteps: skillUpdate.learningSteps,
      previousRepetitions: input.current.repetitions,
      nextRepetitions: skillUpdate.repetitions,
      previousLapses: input.current.lapses,
      nextLapses: skillUpdate.lapses,
      previousState: input.current.fsrsState,
      nextState: skillUpdate.fsrsState,
      schedulerName: SCHEDULER_NAME,
      schedulerVersion: SCHEDULER_VERSION,
      desiredRetention: default_request_retention,
      schedulerParameters: {
        source: "ts-fsrs-defaults",
      },
    },
  };
}

export function toFsrsCard(schedule: SkillScheduleFields): Card {
  return {
    due: schedule.dueAt,
    stability: schedule.stability,
    difficulty: schedule.difficulty,
    elapsed_days: schedule.elapsedDays,
    scheduled_days: schedule.scheduledDays,
    learning_steps: schedule.learningSteps,
    reps: schedule.repetitions,
    lapses: schedule.lapses,
    state: toTsFsrsState(schedule.fsrsState),
    last_review: schedule.lastReviewedAt ?? undefined,
  };
}

export function getDueSkills<TSkill extends DueSkillInput>(skills: TSkill[], now: Date): TSkill[] {
  return skills
    .filter(
      (skill) =>
        skill.status === SkillStatus.ACTIVE &&
        skill.dueAt !== null &&
        skill.dueAt.getTime() <= now.getTime(),
    )
    .toSorted((left, right) => {
      const dueDifference = left.dueAt!.getTime() - right.dueAt!.getTime();

      if (dueDifference !== 0) {
        return dueDifference;
      }

      return left.id.localeCompare(right.id);
    });
}

function fromFsrsCard(card: Card): SkillScheduleFields {
  return {
    dueAt: card.due,
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    repetitions: card.reps,
    lapses: card.lapses,
    fsrsState: fromTsFsrsState(card.state),
    lastReviewedAt: card.last_review ?? null,
  };
}

function toTsFsrsRating(rating: FsrsRating): Grade {
  switch (rating) {
    case FsrsRating.AGAIN:
      return Rating.Again;
    case FsrsRating.HARD:
      return Rating.Hard;
    case FsrsRating.GOOD:
      return Rating.Good;
    case FsrsRating.EASY:
      return Rating.Easy;
  }
}

function toTsFsrsState(state: SkillFsrsState): State {
  switch (state) {
    case SkillFsrsState.NEW:
      return State.New;
    case SkillFsrsState.LEARNING:
      return State.Learning;
    case SkillFsrsState.REVIEW:
      return State.Review;
    case SkillFsrsState.RELEARNING:
      return State.Relearning;
  }
}

function fromTsFsrsState(state: State): SkillFsrsState {
  switch (state) {
    case State.New:
      return SkillFsrsState.NEW;
    case State.Learning:
      return SkillFsrsState.LEARNING;
    case State.Review:
      return SkillFsrsState.REVIEW;
    case State.Relearning:
      return SkillFsrsState.RELEARNING;
  }
}

function resolveSchedulerVersion(): string {
  try {
    let candidateDir = dirname(nodeRequire.resolve(SCHEDULER_NAME));

    for (let depth = 0; depth < 4; depth += 1) {
      const packageJsonPath = join(candidateDir, "package.json");

      try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
          name?: string;
          version?: string;
        };

        if (packageJson.name === SCHEDULER_NAME && packageJson.version) {
          return packageJson.version;
        }
      } catch {
        // Keep walking up from the resolved entrypoint until the package root is found.
      }

      const parentDir = dirname(candidateDir);

      if (parentDir === candidateDir) {
        break;
      }

      candidateDir = parentDir;
    }
  } catch {
    // Fall through to the safe default so module initialization never throws.
  }

  return SCHEDULER_VERSION_FALLBACK;
}
