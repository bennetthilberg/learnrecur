import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getPrisma } from "@/lib/prisma";
import { updateSkillMetadata } from "@/lib/skills";
import { createSkillFixture } from "./test-helpers";

const database = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
database("learner skill organization", () => {
  const prisma = getPrisma();
  const owner = `organization-${randomUUID()}`;
  const other = `organization-${randomUUID()}`;
  beforeAll(async () => { await prisma.user.createMany({ data: [owner, other].map((id) => ({ id, email: `${id}@example.com` })) }); });
  afterAll(async () => { await prisma.user.deleteMany({ where: { id: { in: [owner, other] } } }); });
  it("renames and moves without changing mastery or history", async () => {
    const skill = await createSkillFixture(prisma, { userId: owner, title: "Original", repetitions: 7 });
    const collection = await prisma.collection.create({ data: { userId: owner, name: "New collection" } });
    expect((await updateSkillMetadata({ userId: owner, skillId: skill.id, title: "Renamed" })).status).toBe("updated");
    expect((await updateSkillMetadata({ userId: owner, skillId: skill.id, collectionId: collection.id })).status).toBe("updated");
    expect(await prisma.skill.findUnique({ where: { id: skill.id } })).toMatchObject({ title: "Renamed", collectionId: collection.id, repetitions: 7, dueAt: skill.dueAt, stability: skill.stability, difficulty: skill.difficulty, fsrsState: skill.fsrsState });
    expect((await updateSkillMetadata({ userId: owner, skillId: skill.id, collectionId: null })).status).toBe("updated");
    expect(await prisma.skill.findUnique({ where: { id: skill.id } })).toMatchObject({ collectionId: null, title: "Renamed" });
  });
  it("rejects another user's skill and unavailable destinations without mutation", async () => {
    const skill = await createSkillFixture(prisma, { userId: owner, title: "Protected" });
    const foreign = await prisma.collection.create({ data: { userId: other, name: "Private" } });
    const archived = await prisma.collection.create({ data: { userId: owner, name: "Archived", status: "ARCHIVED" } });
    expect((await updateSkillMetadata({ userId: other, skillId: skill.id, title: "No" })).status).toBe("not-found");
    for (const collectionId of [foreign.id, archived.id, "missing"]) expect((await updateSkillMetadata({ userId: owner, skillId: skill.id, collectionId })).status).toBe("invalid");
    expect(await prisma.skill.findUnique({ where: { id: skill.id } })).toMatchObject({ title: "Protected", collectionId: null });
  });
});
