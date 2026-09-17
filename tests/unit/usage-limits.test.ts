import { afterEach, describe, expect, it, vi } from "vitest";

import { SkillStatus, SourceFileKind } from "@/generated/prisma/client";
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
  checkSourceStorageUsageLimit,
  checkSourceUploadUsageLimit,
  getExerciseRefillUsage,
  getPendingImportUsage,
  getSkillActivationUsage,
  resolveUsageLimitConfig,
  startOfUtcDay,
} from "@/lib/usage-limits";
import {
  DEFAULT_ACTIVE_SKILL_LIMIT,
  DEFAULT_SKILL_ACTIVATIONS_PER_UTC_DAY,
  MAX_PENDING_IMPORT_ITEMS,
} from "@/lib/import-limits";

describe("usage limits", () => {
  const now = new Date("2026-06-23T17:45:30.000Z");

  afterEach(() => vi.unstubAllEnvs());

  it("uses UTC day boundaries for daily limits", () => {
    expect(startOfUtcDay(now)).toEqual(new Date("2026-06-23T00:00:00.000Z"));
  });

  it("uses adopted defaults and accepts positive safe-integer overrides", () => {
    expect(resolveUsageLimitConfig({})).toEqual({
      activeSkillLimit: DEFAULT_ACTIVE_SKILL_LIMIT,
      skillActivationsPerUtcDay: DEFAULT_SKILL_ACTIVATIONS_PER_UTC_DAY,
    });
    expect(
      resolveUsageLimitConfig({
        LEARNRECUR_ACTIVE_SKILL_LIMIT: " 017 ",
        LEARNRECUR_SKILL_ACTIVATIONS_PER_UTC_DAY: "23",
      }),
    ).toEqual({
      activeSkillLimit: 17,
      skillActivationsPerUtcDay: 23,
    });
  });

  it.each([
    ["", "LEARNRECUR_ACTIVE_SKILL_LIMIT"],
    ["0", "LEARNRECUR_ACTIVE_SKILL_LIMIT"],
    ["-1", "LEARNRECUR_ACTIVE_SKILL_LIMIT"],
    ["1.5", "LEARNRECUR_ACTIVE_SKILL_LIMIT"],
    ["9007199254740992", "LEARNRECUR_SKILL_ACTIVATIONS_PER_UTC_DAY"],
  ])("rejects invalid import limit %s", (value, variableName) => {
    expect(() =>
      resolveUsageLimitConfig({ [variableName]: value }),
    ).toThrow(variableName);
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

  it("excludes a replaced source object from the storage total", async () => {
    const prisma = {
      sourceFile: {
        aggregate: vi.fn(async () => ({ _sum: { byteSize: ALPHA_STORED_SOURCE_BYTES - 2 } })),
      },
      generationJob: {},
      skill: {},
    };

    await expect(
      checkSourceStorageUsageLimit({
        userId: "user_1",
        byteSize: 2,
        replaceSourceFileId: "source_1",
        prisma: prisma as never,
      }),
    ).resolves.toEqual({ status: "ok" });

    expect(prisma.sourceFile.aggregate).toHaveBeenCalledWith({
      where: {
        userId: "user_1",
        storageKey: { not: null },
        id: { not: "source_1" },
      },
      _sum: { byteSize: true },
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
            count: vi.fn(async (args) =>
              args.where.status ? 0 : ALPHA_SKILL_ACTIVATIONS_PER_DAY,
            ),
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
            count: vi.fn(async () => 0),
          },
          sourceFile: {},
        } as never,
      }),
    ).resolves.toEqual({
      status: "ok",
    });
  });

  it("applies runtime capacity settings to activation checks", async () => {
    vi.stubEnv("LEARNRECUR_ACTIVE_SKILL_LIMIT", "3");
    vi.stubEnv("LEARNRECUR_SKILL_ACTIVATIONS_PER_UTC_DAY", "4");

    await expect(
      checkSkillActivationUsageLimit({
        userId: "user_1",
        now,
        prisma: {
          skill: { count: vi.fn(async () => 2) },
          generationJob: { count: vi.fn(async () => 0) },
          sourceFile: {},
        } as never,
      }),
    ).resolves.toEqual({ status: "ok" });

    await expect(
      checkSkillActivationUsageLimit({
        userId: "user_1",
        now,
        prisma: {
          skill: { count: vi.fn(async () => 3) },
          generationJob: { count: vi.fn(async () => 0) },
          sourceFile: {},
        } as never,
      }),
    ).resolves.toMatchObject({
      status: "limited",
      code: "active-skill-limit",
      limit: 3,
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
  it("counts active, paused, native, MCP, and standalone reservations once", async () => {
    const skillCount = vi.fn(async () => 7);
    const generationJobCount = vi.fn(async (args) =>
      args.where.status ? 2 : 3,
    );
    const agentItemCount = vi.fn(async (args) =>
      args.where.activationReservedAt?.not === null ? 4 : 1,
    );
    const nativeItemCount = vi.fn(async () => 2);

    await expect(
      getSkillActivationUsage({
        userId: "user_1",
        now,
        prisma: {
          skill: { count: skillCount },
          generationJob: { count: generationJobCount },
          agentSkillOperationItem: { count: agentItemCount },
          skillDraftBatchItem: { count: nativeItemCount },
          sourceFile: {},
        } as never,
      }),
    ).resolves.toMatchObject({
      activeSkillCount: 7,
      reservedSkillCount: 8,
      countedSkillCount: 15,
      activationJobsToday: 3,
      unclaimedReservationsToday: 1,
      activationsUsedToday: 4,
    });
    expect(agentItemCount).toHaveBeenCalledTimes(2);
  });

  it("includes unmaterialized MCP reservations in the shared pending-item budget", async () => {
    await expect(
      getPendingImportUsage({
        userId: "user_1",
        prisma: {
          agentSkillOperationItem: {
            count: vi.fn(async () => 7),
          },
          agentSkillOperation: {
            findMany: vi.fn(async () => [
              { requestedCount: 12 },
              { requestedCount: 4 },
            ]),
          },
          skill: {},
          generationJob: {},
          sourceFile: {},
        } as never,
      }),
    ).resolves.toEqual({
      pendingItemCount: 23,
      pendingItemLimit: MAX_PENDING_IMPORT_ITEMS,
      remaining: MAX_PENDING_IMPORT_ITEMS - 23,
    });
  });

  it("does not spend refill allowance on deferred markers", async () => {
    const count = vi.fn(async () => 49);
    await expect(
      getExerciseRefillUsage({
        userId: "user_1",
        now,
        prisma: {
          generationJob: { count },
          skill: {},
          sourceFile: {},
        } as never,
      }),
    ).resolves.toMatchObject({ jobsToday: 49, remaining: 1 });
    expect(count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { checkpoint: { not: "deferred-quota" } },
            { checkpoint: null },
          ]),
        }),
      }),
    );
  });
});
