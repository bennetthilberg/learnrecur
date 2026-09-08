import { describe, expect, it } from "vitest";
import {
  dailyNewSkillLimitSchema,
  practiceTimezoneSchema,
  getPracticeLocalDate,
} from "@/lib/practice/daily-limit-contracts";
import { agentUpdatePracticeSettingsSchema } from "@/lib/agent-access/practice-contracts";

describe("daily new skill limits", () => {
  it.each([null, 0, 1, 20, 1000])("accepts %s", (value) => {
    expect(dailyNewSkillLimitSchema.parse(value)).toBe(value);
    expect(
      agentUpdatePracticeSettingsSchema.parse({
        target: { scope: "user" },
        changes: { dailyNewSkillLimit: value },
      }).changes,
    ).toEqual({ dailyNewSkillLimit: value });
  });
  it.each([-1, 1.5, 1001, "20", true, NaN, Infinity])("rejects %s", (value) => {
    expect(dailyNewSkillLimitSchema.safeParse(value).success).toBe(false);
  });
  it("validates timezone and refuses a collection or skill cap", () => {
    expect(practiceTimezoneSchema.parse("America/Chicago")).toBe(
      "America/Chicago",
    );
    expect(practiceTimezoneSchema.safeParse("Mars/Olympus").success).toBe(
      false,
    );
    for (const scope of ["collection", "skill"]) {
      expect(
        agentUpdatePracticeSettingsSchema.safeParse({
          target: { scope, id: "s1" },
          changes: { dailyNewSkillLimit: 1 },
        }).success,
      ).toBe(false);
    }
  });
  it.each([
    ["2026-03-08T05:59:59Z", "2026-03-07"],
    ["2026-03-08T06:00:00Z", "2026-03-08"],
    ["2026-03-09T04:59:59Z", "2026-03-08"],
    ["2026-03-09T05:00:00Z", "2026-03-09"],
    ["2026-11-01T06:30:00Z", "2026-11-01"],
    ["2026-11-01T07:30:00Z", "2026-11-01"],
  ])("uses local dates across DST at %s", (instant, date) => {
    expect(getPracticeLocalDate(new Date(instant), "America/Chicago")).toBe(
      date,
    );
  });
});
