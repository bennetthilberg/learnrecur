import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/prisma";
import { getNextPracticeItem } from "@/lib/practice";
import { createSkillFixture } from "./test-helpers";
const database = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
database("practice completion next review", () => {
  const prisma = getPrisma();
  const userId = `completion-${randomUUID()}`;
  const now = new Date("2026-09-14T12:00:00Z");
  beforeAll(async () => { await prisma.user.create({ data: { id: userId, email: `${userId}@example.com` } }); });
  afterAll(async () => { await prisma.user.deleteMany({ where: { id: userId } }); });
  it("reports the earliest active future schedule in the selected collection", async () => {
    const collection = await prisma.collection.create({ data: { userId, name: "Spanish" } });
    await createSkillFixture(prisma, { userId, title: "Other collection", dueAt: new Date("2026-09-14T13:00:00Z") });
    await createSkillFixture(prisma, { userId, collectionId: collection.id, title: "Paused", status: "PAUSED", dueAt: new Date("2026-09-14T13:30:00Z") });
    await createSkillFixture(prisma, { userId, collectionId: collection.id, title: "Later", dueAt: new Date("2026-09-14T15:00:00Z") });
    await createSkillFixture(prisma, { userId, collectionId: collection.id, title: "Next", dueAt: new Date("2026-09-14T14:00:00Z") });
    expect(await getNextPracticeItem({ userId, collectionId: collection.id, now })).toMatchObject({ status: "none-due", nextReviewAt: new Date("2026-09-14T14:00:00Z") });
    expect(await getNextPracticeItem({ userId, now })).toMatchObject({ status: "none-due", nextReviewAt: new Date("2026-09-14T13:00:00Z") });
  });
});
