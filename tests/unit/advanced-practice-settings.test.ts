import { describe, expect, it } from "vitest";

import { FsrsRating, SkillFsrsState } from "@/generated/prisma/client";
import {
  getPracticeDayBoundary,
  getPracticeDayBounds,
  getPracticeLocalDate,
  practiceDayStartMinutesSchema,
} from "@/lib/practice/daily-limit-contracts";
import {
  DEFAULT_DESIRED_RETENTION,
  desiredRetentionSchema,
  advanceSkillSchedule,
} from "@/lib/scheduling";

describe("advanced practice settings contracts", () => {
  it("uses the ts-fsrs default when retention is reset", () => {
    expect(desiredRetentionSchema.parse(null)).toBeNull();
    expect(DEFAULT_DESIRED_RETENTION).toBe(0.9);
    expect(desiredRetentionSchema.safeParse(0.7).success).toBe(true);
    expect(desiredRetentionSchema.safeParse(0.99).success).toBe(true);
    expect(desiredRetentionSchema.safeParse(0.69).success).toBe(false);
    expect(desiredRetentionSchema.safeParse(1).success).toBe(false);
    expect(desiredRetentionSchema.safeParse(Number.NaN).success).toBe(false);
    expect(practiceDayStartMinutesSchema.safeParse(0).success).toBe(true);
    expect(practiceDayStartMinutesSchema.safeParse(1439).success).toBe(true);
    expect(practiceDayStartMinutesSchema.safeParse(1440).success).toBe(false);
  });

  it("passes an explicit retention to FSRS and snapshots it on the review log", () => {
    const current = {
      dueAt: new Date("2026-01-01T12:00:00.000Z"),
      stability: 12,
      difficulty: 5,
      elapsedDays: 4,
      scheduledDays: 12,
      learningSteps: 0,
      repetitions: 4,
      lapses: 0,
      fsrsState: SkillFsrsState.REVIEW,
      lastReviewedAt: new Date("2025-12-28T12:00:00.000Z"),
    };
    const reviewedAt = new Date("2026-01-01T12:00:00.000Z");
    const defaultResult = advanceSkillSchedule({
      current,
      rating: FsrsRating.GOOD,
      reviewedAt,
    });
    const customResult = advanceSkillSchedule({
      current,
      rating: FsrsRating.GOOD,
      reviewedAt,
      desiredRetention: 0.99,
    });

    expect(defaultResult.reviewLog.desiredRetention).toBe(0.9);
    expect(defaultResult.reviewLog.schedulerParameters).toEqual({
      source: "ts-fsrs-defaults",
    });
    expect(customResult.reviewLog.desiredRetention).toBe(0.99);
    expect(customResult.reviewLog.schedulerParameters).toEqual({
      source: "user-setting",
      requestRetention: 0.99,
    });
    expect(customResult.skillUpdate.dueAt.getTime()).toBeLessThan(
      defaultResult.skillUpdate.dueAt.getTime(),
    );
  });
});

describe("practice-day boundaries", () => {
  const timezone = "America/New_York";

  it("uses the earliest occurrence when a fall-back boundary repeats", () => {
    expect(
      getPracticeDayBoundary("2026-11-01", timezone, 90).toISOString(),
    ).toBe("2026-11-01T05:30:00.000Z");
  });

  it("advances a missing spring-forward boundary to the first valid time", () => {
    expect(
      getPracticeDayBoundary("2026-03-08", timezone, 150).toISOString(),
    ).toBe("2026-03-08T07:00:00.000Z");
  });

  it("returns consecutive local boundaries across a 23-hour DST day", () => {
    const bounds = getPracticeDayBounds(
      new Date("2026-03-08T07:00:00.000Z"),
      timezone,
      150,
    );
    expect(bounds.localDate).toBe("2026-03-08");
    expect(bounds.start.toISOString()).toBe("2026-03-08T07:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-03-09T06:30:00.000Z");
  });

  it("returns consecutive local boundaries across a 25-hour DST day", () => {
    const bounds = getPracticeDayBounds(
      new Date("2026-11-01T06:00:00.000Z"),
      timezone,
      90,
    );
    expect(bounds.localDate).toBe("2026-11-01");
    expect(bounds.start.toISOString()).toBe("2026-11-01T05:30:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-11-02T06:30:00.000Z");
  });

  it("moves the practice date back before the local start time", () => {
    expect(
      getPracticeLocalDate(
        new Date("2026-06-02T04:00:00.000Z"),
        "America/Chicago",
        300,
      ),
    ).toBe("2026-06-01");
  });

  it("keeps bounds ordered when a timezone skips a local calendar date", () => {
    const now = new Date("2011-12-30T12:00:00.000Z");
    const bounds = getPracticeDayBounds(now, "Pacific/Apia", 240);

    expect(bounds.start.getTime()).toBeLessThanOrEqual(now.getTime());
    expect(now.getTime()).toBeLessThan(bounds.end.getTime());
  });
});
