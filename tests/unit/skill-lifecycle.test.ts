import { describe, expect, it, vi } from "vitest";

import { SkillStatus } from "@/generated/prisma/client";

const { getSkillActivationUsage } = vi.hoisted(() => ({
  getSkillActivationUsage: vi.fn(),
}));

vi.mock("@/lib/practice/read-model-eligibility", () => ({
  isPracticeReadModelExerciseReady: vi.fn(() => true),
}));
vi.mock("@/lib/usage-limits", () => ({ getSkillActivationUsage }));

import { restoreArchivedSkill } from "@/lib/skills/lifecycle";

describe("skill lifecycle capacity", () => {
  it("does not restore a practice-ready archived skill beyond the shared cap", async () => {
    const updateMany = vi.fn();
    const transaction = {
      $queryRaw: vi.fn(),
      skill: {
        findFirst: vi.fn(async () => ({
          id: "archived-skill",
          status: SkillStatus.ARCHIVED,
          dueAt: new Date("2026-06-04T09:00:00.000Z"),
          stability: 4,
          difficulty: 5,
          repetitions: 2,
          alreadyStudied: true,
          exercises: [
            {
              answerKind: "CHOICE",
              verificationStatus: "VERIFIED",
              retiredAt: null,
              choices: null,
              answerSpec: { kind: "choice", correctChoiceId: "right" },
            },
          ],
        })),
        updateMany,
      },
    };
    getSkillActivationUsage.mockResolvedValue({
      countedSkillCount: 250,
      activeSkillLimit: 250,
    });

    await expect(
      restoreArchivedSkill({
        userId: "user-1",
        skillId: "archived-skill",
        now: new Date("2026-06-05T12:00:00.000Z"),
        transaction: transaction as never,
      }),
    ).resolves.toEqual({
      status: "limited",
      reason: "active-skill-limit",
      message:
        "The library limit is 250 active or paused skills, including imports already reserved. Archive a skill before restoring another.",
      limit: 250,
      remaining: 0,
    });
    expect(getSkillActivationUsage).toHaveBeenCalledWith({
      userId: "user-1",
      now: new Date("2026-06-05T12:00:00.000Z"),
      prisma: transaction,
    });
    expect(updateMany).not.toHaveBeenCalled();
    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
  });
});
