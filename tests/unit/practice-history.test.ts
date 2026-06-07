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
});
