import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/prisma";
import {
  getNextPracticeItem,
  commitPracticeReview,
  previewPracticeAnswer,
} from "@/lib/practice";
import {
  getUserPracticePreferences,
  saveUserPracticePreferences,
} from "@/lib/practice/preferences";
import { createSkillFixture, createChoiceExercise } from "./test-helpers";
import { getUserDataExport } from "@/lib/settings/data-export";
import { getDashboardHome } from "@/lib/dashboard";
import { getCollectionsHome } from "@/lib/collections";
import { getDuePracticeSkillCount } from "@/lib/reminders";
import { previewNextPracticeItemForUser } from "@/app/practice/queries";

const suite = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
suite("daily introductions through persisted practice", () => {
  const prisma = getPrisma();
  const users: string[] = [];
  const now = new Date("2026-09-07T23:00:00Z");
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await prisma.$disconnect();
  });
  async function fixture(limit: number | null = 1) {
    const userId = `daily_limit_${randomUUID()}`;
    users.push(userId);
    await prisma.user.create({ data: { id: userId } });
    await saveUserPracticePreferences(userId, {
      practicePreference: "BALANCED",
      mixedReview: false,
      dailyNewSkillLimit: limit,
      practiceTimezone: "America/Chicago",
    });
    const items = [];
    for (let i = 0; i < 3; i++) {
      const collection = await prisma.collection.create({
        data: { userId, name: `Subject ${i}` },
      });
      const skill = await createSkillFixture(prisma, {
        userId,
        title: `New skill ${i}`,
        collectionId: collection.id,
      });
      const exercise = await createChoiceExercise({
        prisma,
        userId,
        skillId: skill.id,
      });
      items.push({ skill, exercise, collectionId: collection.id });
    }
    return { userId, items };
  }
  it("counts presentation once across reloads, scopes and concurrent tabs without inventing reviews", async () => {
    const { userId, items } = await fixture();
    const results = await Promise.all(
      items.map(({ collectionId }) =>
        getNextPracticeItem({ userId, now, collectionId }),
      ),
    );
    expect(results.filter((r) => r.status === "ready")).toHaveLength(1);
    expect(
      results.filter((r) => r.status === "none-due" && r.dailyLimitReached),
    ).toHaveLength(2);
    const ready = results.find((r) => r.status === "ready")!;
    if (ready.status !== "ready") throw Error("missing presentation");
    const again = await getNextPracticeItem({ userId, now });
    expect(again).toMatchObject({
      status: "ready",
      skill: { id: ready.skill.id },
    });
    expect(
      await prisma.skill.findUniqueOrThrow({ where: { id: ready.skill.id } }),
    ).toMatchObject({
      firstIntroducedAt: now,
      repetitions: 0,
      lastReviewedAt: null,
    });
    expect(await prisma.reviewLog.count({ where: { userId } })).toBe(0);
    expect(
      await prisma.skill.count({
        where: { userId, firstIntroducedAt: { not: null } },
      }),
    ).toBe(1);
  });
  it("keeps scheduled reviews available at zero and blocks direct new submissions", async () => {
    const { userId, items } = await fixture(0);
    const [review, fresh] = items;
    await prisma.skill.update({
      where: { id: review.skill.id },
      data: {
        repetitions: 4,
        lastReviewedAt: new Date("2026-09-01T12:00:00Z"),
      },
    });
    await prisma.skill.update({
      where: { id: fresh.skill.id },
      data: { alreadyStudied: true },
    });
    expect(await getNextPracticeItem({ userId, now })).toMatchObject({
      status: "ready",
      skill: { id: review.skill.id },
    });
    expect(
      await previewPracticeAnswer({
        userId,
        now,
        exerciseId: fresh.exercise.id,
        submittedAnswer: "a",
      }),
    ).toMatchObject({ status: "not-found" });
    expect(
      await commitPracticeReview({
        userId,
        reviewedAt: now,
        exerciseId: fresh.exercise.id,
        submittedAnswer: "a",
        attemptId: randomUUID(),
      }),
    ).toMatchObject({ status: "not-found" });
    expect(await prisma.exerciseAttempt.count({ where: { userId } })).toBe(0);
  });
  it("resets at local midnight, preserves older presentations and supports unlimited", async () => {
    const { userId, items } = await fixture();
    expect(
      await getNextPracticeItem({
        userId,
        now,
        collectionId: items[0].collectionId,
      }),
    ).toMatchObject({ status: "ready" });
    expect(
      await getNextPracticeItem({
        userId,
        now: new Date("2026-09-08T04:59:59Z"),
        collectionId: items[1].collectionId,
      }),
    ).toMatchObject({ status: "none-due", dailyLimitReached: true });
    expect(
      await getNextPracticeItem({
        userId,
        now: new Date("2026-09-08T05:00:00Z"),
        collectionId: items[1].collectionId,
      }),
    ).toMatchObject({ status: "ready" });
    await saveUserPracticePreferences(userId, {
      practicePreference: "RECALL_FIRST",
      mixedReview: true,
    });
    expect(await getUserPracticePreferences(userId)).toMatchObject({
      dailyNewSkillLimit: 1,
      practiceTimezone: "America/Chicago",
    });
    await saveUserPracticePreferences(userId, {
      practicePreference: "BALANCED",
      mixedReview: false,
      dailyNewSkillLimit: null,
    });
    expect(
      await getNextPracticeItem({
        userId,
        now,
        collectionId: items[2].collectionId,
      }),
    ).toMatchObject({ status: "ready" });
  });
  it("does not charge unavailable exercises or another user's scope", async () => {
    const { userId, items } = await fixture();
    const other = await fixture();
    await prisma.exercise.update({
      where: { id: items[0].exercise.id },
      data: { retiredAt: now },
    });
    expect(
      await getNextPracticeItem({
        userId,
        now,
        collectionId: items[0].collectionId,
      }),
    ).toMatchObject({ status: "none-due", preparing: true });
    expect(
      await getNextPracticeItem({
        userId,
        now,
        collectionId: other.items[0].collectionId,
      }),
    ).toMatchObject({ status: "none-due" });
    expect(
      await prisma.skill.count({
        where: { userId, firstIntroducedAt: { not: null } },
      }),
    ).toBe(0);
    await prisma.user.update({ where: { id: userId }, data: { dailyNewSkillLimit: 0 } });
    const dashboard = await getDashboardHome({ userId, now });
    expect(dashboard.skills.find((skill) => skill.id === items[0].skill.id)?.dueLabel)
      .toBe("Not available in practice yet");
  });
  it("keeps dashboard previews read-only across collections", async () => {
    const { userId, items } = await fixture();
    for (const item of items) {
      expect(
        await previewNextPracticeItemForUser(userId, now, {
          collectionId: item.collectionId,
        }),
      ).toMatchObject({ status: "ready" });
    }
    expect(
      await prisma.skill.count({
        where: { userId, firstIntroducedAt: { not: null } },
      }),
    ).toBe(0);
    expect(
      await getNextPracticeItem({
        userId,
        now,
        collectionId: items[2].collectionId,
      }),
    ).toMatchObject({ status: "ready" });
    expect(
      await previewNextPracticeItemForUser(userId, now, {
        collectionId: items[0].collectionId,
      }),
    ).toMatchObject({ status: "none-due", dailyLimitReached: true });
  });
  it.each(
    [
      [],
      [{ id: "right", label: "Right" }, { id: "wrong" }],
      [
        { id: "right", label: "Right" },
        { id: "right", label: "Duplicate" },
      ],
      [{ id: "wrong", label: "Missing correct choice" }],
      [{ id: "right", label: " " }],
    ].map((choices) => ({ choices })),
  )(
    "skips unusable choice options without charging their skill: %j",
    async ({ choices }) => {
      const { userId, items } = await fixture();
      const broken = items[0];
      await prisma.exercise.update({
        where: { id: broken.exercise.id },
        data: { choices },
      });
      expect(
        await getNextPracticeItem({
          userId,
          now,
          collectionId: broken.collectionId,
        }),
      ).toMatchObject({ status: "none-due", preparing: true });
      expect(
        (
          await prisma.skill.findUniqueOrThrow({
            where: { id: broken.skill.id },
          })
        ).firstIntroducedAt,
      ).toBeNull();
      expect(
        await getNextPracticeItem({
          userId,
          now,
          collectionId: items[1].collectionId,
        }),
      ).toMatchObject({ status: "ready" });
    },
  );
  it("caps readiness counts and lets actual scheduled follow-ups continue after the allowance is spent", async () => {
    const { userId, items } = await fixture();
    expect((await getDashboardHome({ userId, now })).readyNowCount).toBe(1);
    expect(await getDuePracticeSkillCount({ userId, now })).toBe(1);
    expect(
      (await getCollectionsHome({ userId, now })).activeCollections.map(
        (c) => c.readyNowCount,
      ),
    ).toEqual([1, 1, 1]);
    const item = items[0];
    await getNextPracticeItem({ userId, now, collectionId: item.collectionId });
    const input = {
      userId,
      reviewedAt: now,
      exerciseId: item.exercise.id,
      submittedAnswer: "right",
      attemptId: randomUUID(),
    };
    const committed = await commitPracticeReview(input);
    expect(committed).toMatchObject({ status: "committed", idempotent: false });
    expect(await commitPracticeReview(input)).toMatchObject({
      status: "committed",
      idempotent: true,
    });
    const limitedDashboard = await getDashboardHome({ userId, now });
    expect(limitedDashboard.readyNowCount).toBe(0);
    expect(
      limitedDashboard.skills
        .filter((s) => s.id !== item.skill.id)
        .map((s) => s.dueLabel),
    ).toEqual(["Daily limit reached", "Daily limit reached"]);
    expect(await getDuePracticeSkillCount({ userId, now })).toBe(0);
    expect(
      (await getCollectionsHome({ userId, now })).activeCollections.map(
        (c) => c.readyNowCount,
      ),
    ).toEqual([0, 0, 0]);
    const skill = await prisma.skill.findUniqueOrThrow({
      where: { id: item.skill.id },
    });
    expect(skill.firstIntroducedAt).toEqual(now);
    expect(skill.repetitions).toBe(1);
    expect(
      await getNextPracticeItem({ userId, now: skill.dueAt! }),
    ).toMatchObject({ status: "ready", skill: { id: skill.id } });
    expect(await prisma.reviewLog.count({ where: { userId } })).toBe(1);
    const exported = await getUserDataExport({ userId, generatedAt: now });
    expect(exported).toMatchObject({
      status: "ready",
      export: {
        exportVersion: 5,
        user: { dailyNewSkillLimit: 1, practiceTimezone: "America/Chicago" },
      },
    });
    if (exported.status === "ready")
      expect(
        exported.export.skills.find((s) => s.id === skill.id)
          ?.firstIntroducedAt,
      ).toBe(now.toISOString());
  });
  it("does not block ordinary child-row ownership checks while reserving an introduction", async () => {
    const { userId } = await fixture();
    await prisma.$transaction(
      async (tx) => {
        // Inserting a flag/exercise takes this FK lock. Introduction accounting
        // must serialize competing introductions without waiting for that writer.
        await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${userId} FOR KEY SHARE`;
        expect(await getNextPracticeItem({ userId, now })).toMatchObject({
          status: "ready",
        });
      },
      { timeout: 5_000 },
    );
  });

  it("serializes direct first reviews and enforces database bounds", async () => {
    const { userId, items } = await fixture();
    const results = await Promise.all(
      items.map((item) =>
        commitPracticeReview({
          userId,
          reviewedAt: now,
          exerciseId: item.exercise.id,
          submittedAnswer: "right",
          attemptId: randomUUID(),
        }),
      ),
    );
    expect(
      results.filter((result) => result.status === "committed"),
    ).toHaveLength(1);
    expect(
      await prisma.skill.count({
        where: { userId, firstIntroducedAt: { not: null } },
      }),
    ).toBe(1);
    await expect(
      prisma.user.update({
        where: { id: userId },
        data: { dailyNewSkillLimit: -1 },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.user.update({
        where: { id: userId },
        data: { dailyNewSkillLimit: 1001 },
      }),
    ).rejects.toThrow();
  });
});
