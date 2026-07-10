import { describe, expect, it, vi } from "vitest";

import {
  GenerationJobKind,
  SkillStatus,
  SourceFileKind,
} from "@/generated/prisma/client";
import {
  ALPHA_ACTIVE_SKILLS,
  ALPHA_EXERCISE_REFILL_JOBS_PER_DAY,
  ALPHA_SKILL_ACTIVATIONS_PER_DAY,
  ALPHA_SOURCE_DRAFT_GENERATIONS_PER_DAY,
  ALPHA_SOURCE_UPLOADS_PER_DAY,
  ALPHA_STORED_SOURCE_BYTES,
  checkExerciseRefillUsageLimit,
  checkPastedSourceDraftUsageLimit,
  checkSkillActivationUsageLimit,
  checkSourceUploadUsageLimit,
  startOfUtcDay,
} from "@/lib/usage-limits";

describe("usage limits", () => {
  const now = new Date("2026-06-23T17:45:30.000Z");

  it("uses UTC day boundaries for daily limits", () => {
    expect(startOfUtcDay(now)).toEqual(new Date("2026-06-23T00:00:00.000Z"));
  });

  it("blocks source uploads after daily or storage limits", async () => {
    const dailyLimitPrisma = {
      sourceFile: {
        count: vi.fn(async () => ALPHA_SOURCE_UPLOADS_PER_DAY),
        aggregate: vi.fn(async () => ({ _sum: { byteSize: 0 } })),
      },
      generationJob: {},
      skill: {},
    };

    await expect(
      checkSourceUploadUsageLimit({
        userId: "user_1",
        byteSize: 1024,
        now,
        prisma: dailyLimitPrisma as never,
      }),
    ).resolves.toMatchObject({
      status: "limited",
      code: "daily-source-upload-limit",
    });
    expect(dailyLimitPrisma.sourceFile.count).toHaveBeenCalledWith({
      where: {
        userId: "user_1",
        materialRevisionId: null,
        createdAt: {
          gte: startOfUtcDay(now),
        },
        kind: {
          in: [SourceFileKind.IMAGE, SourceFileKind.PDF],
        },
      },
    });

    const storageLimitPrisma = {
      sourceFile: {
        count: vi.fn(async () => 0),
        aggregate: vi.fn(async () => ({ _sum: { byteSize: ALPHA_STORED_SOURCE_BYTES } })),
      },
      generationJob: {},
      skill: {},
    };

    await expect(
      checkSourceUploadUsageLimit({
        userId: "user_1",
        byteSize: 1,
        now,
        prisma: storageLimitPrisma as never,
      }),
    ).resolves.toMatchObject({
      status: "limited",
      code: "source-storage-limit",
    });

    expect(storageLimitPrisma.sourceFile.count).toHaveBeenCalledWith({
      where: {
        userId: "user_1",
        materialRevisionId: null,
        createdAt: {
          gte: startOfUtcDay(now),
        },
        kind: {
          in: [SourceFileKind.IMAGE, SourceFileKind.PDF],
        },
      },
    });
    expect(storageLimitPrisma.sourceFile.aggregate).toHaveBeenCalledWith({
      where: {
        userId: "user_1",
        materialRevisionId: null,
        storageKey: {
          not: null,
        },
      },
      _sum: {
        byteSize: true,
      },
    });
  });

  it("blocks pasted-source draft generation after the daily limit", async () => {
    await expect(
      checkPastedSourceDraftUsageLimit({
        userId: "user_1",
        now,
        prisma: {
          sourceFile: {
            count: vi.fn(async () => ALPHA_SOURCE_DRAFT_GENERATIONS_PER_DAY),
          },
          generationJob: {},
          skill: {},
        } as never,
      }),
    ).resolves.toMatchObject({
      status: "limited",
      code: "daily-source-draft-limit",
    });
  });

  it("blocks activation after active-skill or daily activation limits", async () => {
    await expect(
      checkSkillActivationUsageLimit({
        userId: "user_1",
        now,
        prisma: {
          skill: {
            count: vi.fn(async () => ALPHA_ACTIVE_SKILLS),
          },
          generationJob: {
            count: vi.fn(async () => 0),
          },
          sourceFile: {},
        } as never,
      }),
    ).resolves.toMatchObject({
      status: "limited",
      code: "active-skill-limit",
    });

    await expect(
      checkSkillActivationUsageLimit({
        userId: "user_1",
        now,
        prisma: {
          skill: {
            count: vi.fn(async () => 0),
          },
          generationJob: {
            count: vi.fn(async () => ALPHA_SKILL_ACTIVATIONS_PER_DAY),
          },
          sourceFile: {},
        } as never,
      }),
    ).resolves.toMatchObject({
      status: "limited",
      code: "daily-activation-limit",
    });

    await expect(
      checkSkillActivationUsageLimit({
        userId: "user_1",
        now,
        prisma: {
          skill: {
            count: vi.fn(async (args) => {
              expect(args.where).toMatchObject({
                status: {
                  in: [SkillStatus.ACTIVE, SkillStatus.PAUSED],
                },
              });

              return ALPHA_ACTIVE_SKILLS - 1;
            }),
          },
          generationJob: {
            count: vi.fn(async (args) => {
              return args.where.kind === GenerationJobKind.SKILL_ACTIVATION
                ? 0
                : ALPHA_SKILL_ACTIVATIONS_PER_DAY;
            }),
          },
          sourceFile: {},
        } as never,
      }),
    ).resolves.toEqual({
      status: "ok",
    });
  });

  it("blocks exercise refill after the daily refill limit", async () => {
    await expect(
      checkExerciseRefillUsageLimit({
        userId: "user_1",
        now,
        prisma: {
          generationJob: {
            count: vi.fn(async () => ALPHA_EXERCISE_REFILL_JOBS_PER_DAY),
          },
          skill: {},
          sourceFile: {},
        } as never,
      }),
    ).resolves.toMatchObject({
      status: "limited",
      code: "daily-exercise-refill-limit",
    });
  });
});
