import { describe, expect, it } from "vitest";

import {
  getPracticeHistory,
  getSkillPracticeHistory,
} from "@/lib/practice/history";

describe("practice history inputs", () => {
  it("rejects invalid now dates before querying history", async () => {
    const invalidNow = new Date("not a date");

    await expect(
      getPracticeHistory({
        userId: "user_test",
        now: invalidNow,
      }),
    ).rejects.toThrow(/getPracticeHistory requires a valid now Date/);

    await expect(
      getSkillPracticeHistory({
        userId: "user_test",
        skillId: "skill_test",
        now: invalidNow,
      }),
    ).rejects.toThrow(/getSkillPracticeHistory requires a valid now Date/);
  });

  it("rejects a cursor created for a different activity mode", async () => {
    await expect(
      getPracticeHistory({
        userId: "user_test",
        now: new Date("2026-09-17T12:00:00.000Z"),
        mode: "practice-only",
        cursor: {
          mode: "scheduled",
          reviewedAt: "2026-09-16T12:00:00.000Z",
          id: "review-1",
        },
      }),
    ).rejects.toThrow(/cursor does not match/i);
  });
});
