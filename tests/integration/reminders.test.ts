import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ReminderSendStatus,
  SkillStatus,
} from "@/generated/prisma/client";
import {
  getDuePracticeSkillCount,
  getReminderSettings,
  processDueReminderBatch,
  saveReminderPreference,
  type ReminderEmailPayload,
  type ReminderEmailSender,
} from "@/lib/reminders";
import { getPrisma } from "@/lib/prisma";

import { createChoiceExercise, createSkillFixture } from "./test-helpers";

const runDatabaseTests = process.env.RUN_DATABASE_TESTS === "1";
const describeDatabase = runDatabaseTests ? describe : describe.skip;
const runId = `reminders_${randomUUID()}`;
const now = new Date("2026-06-04T13:00:00.000Z");
const localDate = "2026-06-04";

describeDatabase("due email reminders", () => {
  const prisma = getPrisma();
  const ownedUserIds: string[] = [];

  function makeUserId(label: string) {
    const userId = `${runId}_${label}`;
    ownedUserIds.push(userId);
    return userId;
  }

  async function cleanupUser(userId: string) {
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  async function createUser(label: string, email = `${label}-${runId}@example.com`) {
    const userId = makeUserId(label);
    await cleanupUser(userId);
    await prisma.user.create({
      data: {
        id: userId,
        email,
      },
    });
    return userId;
  }

  async function createDueChoiceSkill(userId: string, label: string) {
    const skill = await createSkillFixture(prisma, {
      userId,
      title: `Due reminder skill ${label}`,
      dueAt: new Date("2026-06-04T09:00:00.000Z"),
    });
    await createChoiceExercise({ prisma, userId, skillId: skill.id });
    return skill;
  }

  beforeAll(async () => {
    await prisma.$queryRaw`SELECT 1`;
  });

  afterAll(async () => {
    for (const userId of ownedUserIds.reverse()) {
      await cleanupUser(userId);
    }

    await prisma.$disconnect();
  });

  it("creates and updates reminder preferences for the signed-in user", async () => {
    const userId = await createUser("settings", "settings@example.com");

    const initialSettings = await getReminderSettings({ userId });
    expect(initialSettings).toMatchObject({
      status: "ready",
      persisted: false,
      preference: {
        enabled: false,
        email: "settings@example.com",
        localHour: 9,
        timezone: "America/New_York",
        minimumDueCount: 1,
      },
    });

    const saved = await saveReminderPreference({
      userId,
      input: {
        enabled: true,
        email: " reminders@example.com ",
        localHour: "8",
        timezone: "America/Chicago",
        minimumDueCount: "3",
      },
    });

    expect(saved).toMatchObject({
      status: "saved",
      preference: {
        enabled: true,
        email: "reminders@example.com",
        localHour: 8,
        timezone: "America/Chicago",
        minimumDueCount: 3,
      },
    });

    const updated = await saveReminderPreference({
      userId,
      input: {
        enabled: false,
        email: "later@example.com",
        localHour: 10,
        timezone: "America/New_York",
        minimumDueCount: 1,
      },
    });

    expect(updated).toMatchObject({
      status: "saved",
      preference: {
        enabled: false,
        email: "later@example.com",
        localHour: 10,
      },
    });
    expect(await prisma.reminderPreference.count({ where: { userId } })).toBe(1);
  });

  it("returns not-found when saving settings for a missing user", async () => {
    const result = await saveReminderPreference({
      userId: `${runId}_missing`,
      input: {
        enabled: true,
        email: "missing@example.com",
        localHour: 9,
        timezone: "America/New_York",
        minimumDueCount: 1,
      },
    });

    expect(result).toEqual({
      status: "not-found",
      message: "Sign in again before changing reminders.",
    });
  });

  it("does not send or log for disabled preferences", async () => {
    const userId = await createUser("disabled");
    await createDueChoiceSkill(userId, "disabled");
    await prisma.reminderPreference.create({
      data: {
        userId,
        enabled: false,
        email: "disabled@example.com",
        localHour: 9,
        timezone: "America/New_York",
        minimumDueCount: 1,
      },
    });
    const sender = createRecordingSender();

    const result = await processDueReminderBatch({
      userIds: [userId],
      now,
      appUrl: "https://learnrecur.example",
      sender,
    });

    expect(result).toEqual({
      checkedCount: 0,
      processedCount: 0,
      results: [],
    });
    expect(sender.payloads).toHaveLength(0);
    expect(await prisma.reminderSendLog.count({ where: { userId } })).toBe(0);
  });

  it("logs a skip when due count is below the preference threshold", async () => {
    const userId = await createUser("below_threshold");
    await createDueChoiceSkill(userId, "below threshold");
    await prisma.reminderPreference.create({
      data: {
        userId,
        enabled: true,
        email: "below@example.com",
        localHour: 9,
        timezone: "America/New_York",
        minimumDueCount: 2,
      },
    });
    const sender = createRecordingSender();

    const result = await processDueReminderBatch({
      userIds: [userId],
      now,
      appUrl: "https://learnrecur.example",
      sender,
    });

    expect(result.results).toEqual([
      {
        status: "skipped",
        userId,
        localDate,
        dueCount: 1,
      },
    ]);
    expect(sender.payloads).toHaveLength(0);
    await expectReminderLog(userId, {
      status: ReminderSendStatus.SKIPPED,
      dueCount: 1,
      providerMessageId: null,
    });
  });

  it("sends once per local date when due count meets the threshold", async () => {
    const userId = await createUser("send_once");
    await createDueChoiceSkill(userId, "send once");
    await prisma.reminderPreference.create({
      data: {
        userId,
        enabled: true,
        email: "send@example.com",
        localHour: 9,
        timezone: "America/New_York",
        minimumDueCount: 1,
      },
    });
    const sender = createRecordingSender("email_123");

    const first = await processDueReminderBatch({
      userIds: [userId],
      now,
      appUrl: "https://learnrecur.example",
      sender,
    });
    const second = await processDueReminderBatch({
      userIds: [userId],
      now,
      appUrl: "https://learnrecur.example",
      sender,
    });

    expect(first.results).toEqual([
      {
        status: "sent",
        userId,
        localDate,
        dueCount: 1,
        providerMessageId: "email_123",
      },
    ]);
    expect(second.results).toEqual([
      {
        status: "already-processed",
        userId,
        localDate,
        logStatus: ReminderSendStatus.SENT,
      },
    ]);
    expect(sender.payloads).toHaveLength(1);
    expect(sender.payloads[0]).toMatchObject({
      email: "send@example.com",
      dueCount: 1,
      idempotencyKey: `learnrecur:due-reminder:${userId}:${localDate}`,
      practiceUrl: "https://learnrecur.example/practice",
    });
    await expectReminderLog(userId, {
      status: ReminderSendStatus.SENT,
      dueCount: 1,
      providerMessageId: "email_123",
    });
  });

  it("retries stale pending reminder logs", async () => {
    const userId = await createUser("stale_pending");
    await createDueChoiceSkill(userId, "stale pending");
    await prisma.reminderPreference.create({
      data: {
        userId,
        enabled: true,
        email: "pending@example.com",
        localHour: 9,
        timezone: "America/New_York",
        minimumDueCount: 1,
      },
    });
    await prisma.reminderSendLog.create({
      data: {
        userId,
        localDate,
        status: ReminderSendStatus.PENDING,
        dueCount: 1,
        email: "pending@example.com",
        provider: "resend",
        createdAt: new Date(now.getTime() - 10 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 10 * 60 * 1000),
      },
    });
    const sender = createRecordingSender("email_retry");

    const result = await processDueReminderBatch({
      userIds: [userId],
      now,
      appUrl: "https://learnrecur.example",
      sender,
    });

    expect(result.results).toEqual([
      {
        status: "sent",
        userId,
        localDate,
        dueCount: 1,
        providerMessageId: "email_retry",
      },
    ]);
    expect(sender.payloads).toHaveLength(1);
    expect(await prisma.reminderSendLog.count({ where: { userId } })).toBe(1);
    await expectReminderLog(userId, {
      status: ReminderSendStatus.SENT,
      dueCount: 1,
      providerMessageId: "email_retry",
    });
  });

  it("does not retry fresh pending reminder logs", async () => {
    const userId = await createUser("fresh_pending");
    await createDueChoiceSkill(userId, "fresh pending");
    await prisma.reminderPreference.create({
      data: {
        userId,
        enabled: true,
        email: "fresh-pending@example.com",
        localHour: 9,
        timezone: "America/New_York",
        minimumDueCount: 1,
      },
    });
    await prisma.reminderSendLog.create({
      data: {
        userId,
        localDate,
        status: ReminderSendStatus.PENDING,
        dueCount: 1,
        email: "fresh-pending@example.com",
        provider: "resend",
        createdAt: new Date(now.getTime() - 10 * 60 * 1000),
        updatedAt: new Date(now.getTime() - 60 * 1000),
      },
    });
    const sender = createRecordingSender("email_should_not_send");

    const result = await processDueReminderBatch({
      userIds: [userId],
      now,
      appUrl: "https://learnrecur.example",
      sender,
    });

    expect(result.results).toEqual([
      {
        status: "already-processed",
        userId,
        localDate,
        logStatus: ReminderSendStatus.PENDING,
      },
    ]);
    expect(sender.payloads).toHaveLength(0);
    await expectReminderLog(userId, {
      status: ReminderSendStatus.PENDING,
      dueCount: 1,
      providerMessageId: null,
    });
  });

  it("records provider failures without losing the audit log", async () => {
    const userId = await createUser("send_failure");
    await createDueChoiceSkill(userId, "failure");
    await prisma.reminderPreference.create({
      data: {
        userId,
        enabled: true,
        email: "failure@example.com",
        localHour: 9,
        timezone: "America/New_York",
        minimumDueCount: 1,
      },
    });
    const sender = createRecordingSender(null, new Error("resend bounced"));

    const result = await processDueReminderBatch({
      userIds: [userId],
      now,
      appUrl: "https://learnrecur.example",
      sender,
    });

    expect(result.results).toEqual([
      {
        status: "failed",
        userId,
        localDate,
        dueCount: 1,
        message: "resend bounced",
      },
    ]);
    expect(sender.payloads).toHaveLength(1);
    const log = await prisma.reminderSendLog.findUniqueOrThrow({
      where: {
        userId_localDate: {
          userId,
          localDate,
        },
      },
    });
    expect(log.status).toBe(ReminderSendStatus.FAILED);
    expect(log.errorMessage).toBe("resend bounced");
    expect(log.dueCount).toBe(1);
  });

  it("computes due count with the current practice eligibility policy", async () => {
    const userId = await createUser("due_count");
    const readySkill = await createDueChoiceSkill(userId, "ready");
    const draftSkill = await createSkillFixture(prisma, {
      userId,
      title: "Draft reminder skill",
      status: SkillStatus.DRAFT,
    });
    await createChoiceExercise({ prisma, userId, skillId: draftSkill.id });
    const futureSkill = await createSkillFixture(prisma, {
      userId,
      title: "Future reminder skill",
      dueAt: new Date("2026-06-05T09:00:00.000Z"),
    });
    await createChoiceExercise({ prisma, userId, skillId: futureSkill.id });

    expect(readySkill.status).toBe(SkillStatus.ACTIVE);
    expect(draftSkill.status).toBe(SkillStatus.DRAFT);
    expect(futureSkill.status).toBe(SkillStatus.ACTIVE);
    expect(await getDuePracticeSkillCount({ userId, now })).toBe(1);
  });

  async function expectReminderLog(
    userId: string,
    expected: {
      status: ReminderSendStatus;
      dueCount: number;
      providerMessageId: string | null;
    },
  ) {
    const log = await prisma.reminderSendLog.findUniqueOrThrow({
      where: {
        userId_localDate: {
          userId,
          localDate,
        },
      },
    });
    expect(log.status).toBe(expected.status);
    expect(log.dueCount).toBe(expected.dueCount);
    expect(log.providerMessageId).toBe(expected.providerMessageId);
  }
});

function createRecordingSender(
  providerMessageId: string | null = "email_test",
  failure?: Error,
): ReminderEmailSender & { payloads: ReminderEmailPayload[] } {
  const payloads: ReminderEmailPayload[] = [];

  return {
    payloads,
    async sendDueReminder(payload) {
      payloads.push(payload);

      if (failure) {
        throw failure;
      }

      return {
        providerMessageId,
      };
    },
  };
}
