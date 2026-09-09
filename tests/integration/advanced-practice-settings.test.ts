import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getPrisma } from "@/lib/prisma";
import {
  getUserPracticePreferences,
  saveUserPracticePreferences,
} from "@/lib/practice/preferences";
import { getUserDataExport } from "@/lib/settings/data-export";

import { createChoiceExercise, createSkillFixture } from "./test-helpers";

const suite = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;

suite("advanced practice settings persistence", () => {
  const prisma = getPrisma();
  const userId = `advanced_preferences_${randomUUID()}`;

  beforeAll(async () => {
    await prisma.user.create({ data: { id: userId } });
  });

  afterAll(async () => {
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  it("saves retention and local day start without rewriting schedule history", async () => {
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Retention persistence",
      dueAt: new Date("2026-06-01T12:00:00.000Z"),
      repetitions: 4,
    });
    const exercise = await createChoiceExercise({
      prisma,
      userId,
      skillId: skill.id,
    });
    const identity = await prisma.workosIdentity.create({
      data: {
        userId,
        workosUserId: `workos_${userId}`,
        externalId: userId,
      },
    });
    const connection = await prisma.agentConnection.create({
      data: {
        userId,
        workosIdentityId: identity.id,
        workosSubject: userId,
        workosSessionId: `session_${userId}`,
        workosApplicationId: `application_${userId}`,
        clientId: `https://agent-${userId}.example/client.json`,
        clientName: "Advanced settings test agent",
        clientDomain: "agent.example",
        resourceUrl: "https://learnrecur.com/mcp",
        scopes: ["practice:read"],
      },
    });
    const setupPlan = await prisma.agentSetupPlan.create({
      data: {
        userId,
        connectionId: connection.id,
        idempotencyKey: "advanced-settings-plan",
        payloadHash: "hash",
        permissionVersion: 1,
        requestedSpec: { collections: [], skills: [] },
        snapshot: { permission_version: 1 },
        status: "SUCCEEDED",
        result: { created: 0 },
      },
    });
    const beforeSkill = await prisma.skill.findUniqueOrThrow({
      where: { id: skill.id },
    });
    const session = await prisma.practiceSession.create({
      data: {
        userId,
        mode: "SCHEDULED",
        targetCount: 1,
        scope: { skillIds: [skill.id] },
        plan: [{ exerciseId: exercise.id }],
      },
    });

    await saveUserPracticePreferences(userId, {
      practicePreference: "BALANCED",
      mixedReview: false,
      dailyNewSkillLimit: null,
      practiceTimezone: "America/Chicago",
      desiredRetention: 0.97,
      practiceDayStartMinutes: 135,
    });

    expect(await getUserPracticePreferences(userId)).toMatchObject({
      desiredRetention: 0.97,
      practiceDayStartMinutes: 135,
      practiceTimezone: "America/Chicago",
    });
    expect(await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).toEqual(
      expect.objectContaining({
        dueAt: beforeSkill.dueAt,
        stability: beforeSkill.stability,
        difficulty: beforeSkill.difficulty,
        repetitions: beforeSkill.repetitions,
        lastReviewedAt: beforeSkill.lastReviewedAt,
      }),
    );
    expect(await prisma.reviewLog.count({ where: { skillId: skill.id } })).toBe(0);

    const exportResult = await getUserDataExport({
      userId,
      generatedAt: new Date("2026-06-02T00:00:00.000Z"),
    });
    expect(exportResult.status).toBe("ready");
    if (exportResult.status !== "ready") throw new Error("expected ready export");
    expect(exportResult.export.user).toMatchObject({
      desiredRetention: 0.97,
      practiceDayStartMinutes: 135,
      practiceTimezone: "America/Chicago",
    });
    expect(exportResult.export.practiceSessions).toEqual([
      expect.objectContaining({
        id: session.id,
        mode: "SCHEDULED",
        scope: { skillIds: [skill.id] },
        plan: [{ exerciseId: exercise.id }],
      }),
    ]);
    expect(exportResult.export.agentSetupPlans).toEqual([
      expect.objectContaining({
        id: setupPlan.id,
        connectionId: connection.id,
        requestedSpec: { collections: [], skills: [] },
        snapshot: { permission_version: 1 },
        status: "SUCCEEDED",
        result: { created: 0 },
      }),
    ]);
  });

  it("restores the default retention without touching the day start", async () => {
    await saveUserPracticePreferences(userId, {
      practicePreference: "BALANCED",
      mixedReview: false,
      dailyNewSkillLimit: null,
      practiceTimezone: "America/Chicago",
      desiredRetention: null,
      practiceDayStartMinutes: 1439,
    });
    expect(await getUserPracticePreferences(userId)).toMatchObject({
      desiredRetention: null,
      practiceDayStartMinutes: 1439,
    });
  });
});
