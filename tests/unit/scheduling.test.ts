import { describe, expect, it } from "vitest";

import { FsrsRating, SkillFsrsState, SkillStatus } from "@/generated/prisma/client";
import {
  advanceSkillSchedule,
  createInitialSkillSchedule,
  getDueSkills,
  mapAttemptToFsrsRating,
  toFsrsCard,
} from "@/lib/scheduling";

const now = new Date("2026-06-02T12:00:00.000Z");

describe("createInitialSkillSchedule", () => {
  it("creates a new due FSRS skill state", () => {
    expect(createInitialSkillSchedule(now)).toEqual({
      dueAt: now,
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
      repetitions: 0,
      lapses: 0,
      fsrsState: SkillFsrsState.NEW,
      lastReviewedAt: null,
    });
  });
});

describe("mapAttemptToFsrsRating", () => {
  it("maps incorrect answers to Again regardless of timing or manual override", () => {
    expect(
      mapAttemptToFsrsRating({
        isCorrect: false,
        responseMs: 100,
        expectedSeconds: 30,
        manualRating: FsrsRating.EASY,
      }),
    ).toBe(FsrsRating.AGAIN);
  });

  it("maps fast correct answers to Easy using half the expected time", () => {
    expect(
      mapAttemptToFsrsRating({
        isCorrect: true,
        responseMs: 15_000,
        expectedSeconds: 30,
      }),
    ).toBe(FsrsRating.EASY);
  });

  it("maps normal and slow correct answers to Good", () => {
    expect(
      mapAttemptToFsrsRating({
        isCorrect: true,
        responseMs: 15_001,
        expectedSeconds: 30,
      }),
    ).toBe(FsrsRating.GOOD);
    expect(
      mapAttemptToFsrsRating({
        isCorrect: true,
        responseMs: 90_000,
        expectedSeconds: 30,
      }),
    ).toBe(FsrsRating.GOOD);
  });

  it("allows Hard, Good, and Easy manual overrides only on correct answers", () => {
    for (const manualRating of [FsrsRating.HARD, FsrsRating.GOOD, FsrsRating.EASY]) {
      expect(
        mapAttemptToFsrsRating({
          isCorrect: true,
          responseMs: 1_000,
          expectedSeconds: 30,
          manualRating,
        }),
      ).toBe(manualRating);
    }
  });

  it("defaults correct answers without timing inputs to Good", () => {
    expect(mapAttemptToFsrsRating({ isCorrect: true })).toBe(FsrsRating.GOOD);
    expect(
      mapAttemptToFsrsRating({
        isCorrect: true,
        responseMs: 100,
      }),
    ).toBe(FsrsRating.GOOD);
    expect(
      mapAttemptToFsrsRating({
        isCorrect: true,
        expectedSeconds: 30,
      }),
    ).toBe(FsrsRating.GOOD);
  });

  it("ignores manual Again on correct answers and impossible timing inputs", () => {
    expect(
      mapAttemptToFsrsRating({
        isCorrect: true,
        responseMs: 1_000,
        expectedSeconds: 30,
        manualRating: FsrsRating.AGAIN,
      }),
    ).toBe(FsrsRating.EASY);
    expect(
      mapAttemptToFsrsRating({
        isCorrect: true,
        responseMs: -1,
        expectedSeconds: 30,
      }),
    ).toBe(FsrsRating.GOOD);
    expect(
      mapAttemptToFsrsRating({
        isCorrect: true,
        responseMs: Number.NaN,
        expectedSeconds: 30,
      }),
    ).toBe(FsrsRating.GOOD);
  });
});

describe("advanceSkillSchedule", () => {
  it("advances a new skill and returns update fields plus review-log snapshots", () => {
    const current = createInitialSkillSchedule(now);
    const reviewedAt = new Date("2026-06-02T12:05:00.000Z");

    const result = advanceSkillSchedule({
      current,
      rating: FsrsRating.GOOD,
      reviewedAt,
    });

    expect(result.rating).toBe(FsrsRating.GOOD);
    expect(result.skillUpdate).toMatchObject({
      stability: expect.any(Number),
      difficulty: expect.any(Number),
      elapsedDays: expect.any(Number),
      scheduledDays: expect.any(Number),
      learningSteps: expect.any(Number),
      repetitions: 1,
      lapses: 0,
      fsrsState: SkillFsrsState.LEARNING,
      lastReviewedAt: reviewedAt,
    });
    expect(result.skillUpdate.dueAt.getTime()).toBeGreaterThan(reviewedAt.getTime());
    expect(result.reviewLog).toMatchObject({
      finalRating: FsrsRating.GOOD,
      reviewedAt,
      previousDueAt: now,
      previousStability: 0,
      previousDifficulty: 0,
      previousElapsedDays: 0,
      previousScheduledDays: 0,
      previousLearningSteps: 0,
      previousRepetitions: 0,
      previousLapses: 0,
      previousState: SkillFsrsState.NEW,
      nextStability: result.skillUpdate.stability,
      nextDifficulty: result.skillUpdate.difficulty,
      nextElapsedDays: result.skillUpdate.elapsedDays,
      nextScheduledDays: result.skillUpdate.scheduledDays,
      nextLearningSteps: result.skillUpdate.learningSteps,
      nextRepetitions: result.skillUpdate.repetitions,
      nextLapses: result.skillUpdate.lapses,
      nextState: result.skillUpdate.fsrsState,
      schedulerName: "ts-fsrs",
      schedulerVersion: "5.4.1",
    });
    expect(result.reviewLog.nextDueAt?.getTime()).toBe(result.skillUpdate.dueAt.getTime());
    expect(result.reviewLog.schedulerParameters).toEqual({ source: "ts-fsrs-defaults" });
  });

  it("converts app skill schedule fields to a ts-fsrs card", () => {
    expect(toFsrsCard(createInitialSkillSchedule(now))).toMatchObject({
      due: now,
      stability: 0,
      difficulty: 0,
      elapsed_days: 0,
      scheduled_days: 0,
      learning_steps: 0,
      reps: 0,
      lapses: 0,
      state: 0,
      last_review: undefined,
    });
  });
});

describe("getDueSkills", () => {
  it("excludes non-active, missing-due, and future-due skills", () => {
    expect(
      getDueSkills(
        [
          { id: "active-due", status: SkillStatus.ACTIVE, dueAt: new Date("2026-06-02T11:59:00Z") },
          { id: "draft-due", status: SkillStatus.DRAFT, dueAt: new Date("2026-06-02T11:00:00Z") },
          { id: "paused-due", status: SkillStatus.PAUSED, dueAt: new Date("2026-06-02T11:00:00Z") },
          { id: "archived-due", status: SkillStatus.ARCHIVED, dueAt: new Date("2026-06-02T11:00:00Z") },
          { id: "missing-due", status: SkillStatus.ACTIVE, dueAt: null },
          { id: "future-due", status: SkillStatus.ACTIVE, dueAt: new Date("2026-06-02T12:01:00Z") },
        ],
        now,
      ).map((skill) => skill.id),
    ).toEqual(["active-due"]);
  });

  it("sorts due skills by oldest due date and then ID", () => {
    expect(
      getDueSkills(
        [
          { id: "c", status: SkillStatus.ACTIVE, dueAt: new Date("2026-06-02T10:00:00Z") },
          { id: "b", status: SkillStatus.ACTIVE, dueAt: new Date("2026-06-02T09:00:00Z") },
          { id: "a", status: SkillStatus.ACTIVE, dueAt: new Date("2026-06-02T09:00:00Z") },
        ],
        now,
      ).map((skill) => skill.id),
    ).toEqual(["a", "b", "c"]);
  });
});
