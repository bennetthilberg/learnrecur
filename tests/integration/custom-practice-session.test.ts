import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { ExerciseAttemptResult } from "@/generated/prisma/client";
import {
  commitCustomPracticeAnswer,
  createCustomPracticeSession,
  getCustomPracticeSession,
  presentCustomPracticeSessionItem,
  previewCustomPracticeAnswer,
  resumeCustomPracticeSession,
  stopCustomPracticeSession,
} from "@/lib/practice/custom-session";
import { getPrisma } from "@/lib/prisma";

import { createChoiceExercise, createSkillFixture } from "./test-helpers";

const suite = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;
const now = new Date("2026-06-03T12:00:00.000Z");

suite("custom practice sessions", () => {
  const prisma = getPrisma();
  const userIds: string[] = [];

  async function createUser(data: { dailyNewSkillLimit?: number | null } = {}) {
    const userId = `custom_practice_${randomUUID()}`;
    userIds.push(userId);
    await prisma.user.create({ data: { id: userId, dailyNewSkillLimit: null, ...data } });
    return userId;
  }

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await prisma.$disconnect();
  });

  it("records practice-only exposure without review evidence or FSRS changes", async () => {
    const userId = await createUser();
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Practice-only skill",
      dueAt: new Date("2026-06-10T12:00:00.000Z"),
      repetitions: 0,
    });
    const exercise = await createChoiceExercise({ prisma, userId, skillId: skill.id });
    const before = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });

    const created = await createCustomPracticeSession({
      userId,
      mode: "PRACTICE_ONLY",
      targetCount: 1,
      scope: {
        collectionIds: [],
        tags: [],
        skillIds: [skill.id],
        recentlyMissed: false,
        mixedReview: false,
      },
      now,
    });
    expect(created.status).toBe("ready");
    if (created.status !== "ready") throw new Error("expected a ready session");

    const ready = await presentCustomPracticeSessionItem({
      userId,
      sessionId: created.session.id,
      now,
    });
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") throw new Error("expected a ready item");
    expect(ready.exercise.id).toBe(exercise.id);

    const committed = await commitCustomPracticeAnswer({
      userId,
      sessionId: created.session.id,
      itemKey: ready.sessionItem.itemKey,
      exerciseId: exercise.id,
      submittedAnswer: "right",
      responseMs: 900,
      now,
    });
    expect(committed.status).toBe("committed");
    if (committed.status !== "committed") throw new Error("expected committed practice-only attempt");
    expect(committed.idempotent).toBe(false);
    expect(committed.next.status).toBe("completed");

    const after = await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(after).toEqual(
      expect.objectContaining({
        dueAt: before.dueAt,
        stability: before.stability,
        difficulty: before.difficulty,
        repetitions: before.repetitions,
        lapses: before.lapses,
        fsrsState: before.fsrsState,
        lastReviewedAt: before.lastReviewedAt,
      }),
    );
    expect(await prisma.reviewLog.count({ where: { userId, skillId: skill.id } })).toBe(0);
    const attempt = await prisma.exerciseAttempt.findUniqueOrThrow({
      where: { id: ready.sessionItem.attemptId },
    });
    expect(attempt).toEqual(
      expect.objectContaining({
        result: ExerciseAttemptResult.CORRECT,
        proposedRating: null,
        finalRating: null,
        practiceContext: expect.objectContaining({
          sessionId: created.session.id,
          sessionMode: "PRACTICE_ONLY",
          exposure: "PRACTICE_ONLY",
          mixedReview: false,
          reducedRuleCues: false,
        }),
      }),
    );

    const retry = await commitCustomPracticeAnswer({
      userId,
      sessionId: created.session.id,
      itemKey: ready.sessionItem.itemKey,
      exerciseId: exercise.id,
      submittedAnswer: "right",
      now: new Date(now.getTime() + 60_000),
    });
    expect(retry).toEqual(
      expect.objectContaining({ status: "committed", idempotent: true }),
    );
    expect(await prisma.exerciseAttempt.count({ where: { id: ready.sessionItem.attemptId } })).toBe(1);
  });

  it("keeps scheduled sessions due-only and replays a non-last review after the card advances", async () => {
    const userId = await createUser();
    const firstSkill = await createSkillFixture(prisma, {
      userId,
      title: "Scheduled first",
      dueAt: new Date("2026-06-02T12:00:00.000Z"),
      repetitions: 2,
    });
    const secondSkill = await createSkillFixture(prisma, {
      userId,
      title: "Scheduled second",
      dueAt: new Date("2026-06-02T13:00:00.000Z"),
      repetitions: 2,
    });
    const firstExercise = await createChoiceExercise({ prisma, userId, skillId: firstSkill.id });
    const secondExercise = await createChoiceExercise({ prisma, userId, skillId: secondSkill.id });
    const created = await createCustomPracticeSession({
      userId,
      mode: "SCHEDULED",
      targetCount: 2,
      scope: {
        collectionIds: [],
        tags: [],
        skillIds: [firstSkill.id, secondSkill.id],
        recentlyMissed: false,
        mixedReview: false,
      },
      now,
    });
    expect(created.status).toBe("ready");
    if (created.status !== "ready") throw new Error("expected a ready scheduled session");

    const first = await presentCustomPracticeSessionItem({
      userId,
      sessionId: created.session.id,
      now,
    });
    expect(first.status).toBe("ready");
    if (first.status !== "ready") throw new Error("expected first scheduled item");
    const firstCommit = await commitCustomPracticeAnswer({
      userId,
      sessionId: created.session.id,
      itemKey: first.sessionItem.itemKey,
      exerciseId: firstExercise.id,
      submittedAnswer: "right",
      manualRating: "GOOD",
      now,
    });
    expect(firstCommit.status).toBe("committed");
    if (firstCommit.status !== "committed" || firstCommit.next.status !== "ready") {
      throw new Error("expected another scheduled item");
    }
    expect(firstCommit.next.exercise.id).toBe(secondExercise.id);
    expect(await prisma.reviewLog.count({ where: { userId } })).toBe(1);

    const firstRetry = await commitCustomPracticeAnswer({
      userId,
      sessionId: created.session.id,
      itemKey: first.sessionItem.itemKey,
      exerciseId: firstExercise.id,
      submittedAnswer: "right",
      manualRating: "GOOD",
      now: new Date(now.getTime() + 5 * 60_000),
    });
    expect(firstRetry).toEqual(
      expect.objectContaining({ status: "committed", idempotent: true }),
    );
    if (firstRetry.status !== "committed") throw new Error("expected idempotent first retry");
    expect(firstRetry.next.status).toBe("ready");
    expect(await prisma.reviewLog.count({ where: { userId } })).toBe(1);

    const second = firstCommit.next;
    if (second.status !== "ready") throw new Error("expected second item");
    const secondCommit = await commitCustomPracticeAnswer({
      userId,
      sessionId: created.session.id,
      itemKey: second.sessionItem.itemKey,
      exerciseId: secondExercise.id,
      submittedAnswer: "right",
      manualRating: "GOOD",
      now: new Date(now.getTime() + 6 * 60_000),
    });
    expect(secondCommit.status).toBe("committed");
    if (secondCommit.status !== "committed") throw new Error("expected final scheduled commit");
    expect(secondCommit.next.status).toBe("completed");
    expect(await prisma.reviewLog.count({ where: { userId } })).toBe(2);

    const finalRetry = await commitCustomPracticeAnswer({
      userId,
      sessionId: created.session.id,
      itemKey: second.sessionItem.itemKey,
      exerciseId: secondExercise.id,
      submittedAnswer: "right",
      manualRating: "GOOD",
      now: new Date(now.getTime() + 7 * 60_000),
    });
    expect(finalRetry).toEqual(
      expect.objectContaining({ status: "committed", idempotent: true }),
    );
    expect(await prisma.reviewLog.count({ where: { userId } })).toBe(2);
  });

  it("persists a late appended item across presentation and completes the target", async () => {
    const userId = await createUser();
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Late exercise skill",
      dueAt: now,
      repetitions: 1,
    });
    const firstExercise = await createChoiceExercise({ prisma, userId, skillId: skill.id });
    const created = await createCustomPracticeSession({
      userId,
      mode: "PRACTICE_ONLY",
      targetCount: 2,
      scope: {
        collectionIds: [],
        tags: [],
        skillIds: [skill.id],
        recentlyMissed: false,
        mixedReview: false,
      },
      now,
    });
    if (created.status !== "ready") throw new Error("expected the first exercise to be planned");
    expect(created.session.plan).toHaveLength(1);

    const firstReady = await presentCustomPracticeSessionItem({
      userId,
      sessionId: created.session.id,
      now,
    });
    if (firstReady.status !== "ready") throw new Error("expected the first item");
    const secondExercise = await createChoiceExercise({ prisma, userId, skillId: skill.id });
    const firstCommit = await commitCustomPracticeAnswer({
      userId,
      sessionId: created.session.id,
      itemKey: firstReady.sessionItem.itemKey,
      exerciseId: firstExercise.id,
      submittedAnswer: "right",
      now,
    });
    expect(firstCommit.status).toBe("committed");
    if (firstCommit.status !== "committed") throw new Error("expected the first commit");
    expect(firstCommit.next.status).toBe("ready");
    const secondReady = firstCommit.next;
    if (secondReady.status !== "ready") throw new Error("expected the appended second item");
    expect(secondReady.exercise.id).toBe(secondExercise.id);
    expect(secondReady.session.plan).toHaveLength(2);
    expect(secondReady.session.plan.map((item) => item.status)).toEqual(["COMPLETED", "PRESENTED"]);
    expect(secondReady.session.plan[0]?.attemptId).not.toBe(secondReady.session.plan[1]?.attemptId);

    const secondCommit = await commitCustomPracticeAnswer({
      userId,
      sessionId: created.session.id,
      itemKey: secondReady.sessionItem.itemKey,
      exerciseId: secondExercise.id,
      submittedAnswer: "right",
      now: new Date(now.getTime() + 60_000),
    });
    expect(secondCommit.status).toBe("committed");
    if (secondCommit.status !== "committed") throw new Error("expected the second commit");
    expect(secondCommit.completedCount).toBe(2);
    expect(secondCommit.next.status).toBe("completed");

    const attempts = await prisma.exerciseAttempt.findMany({
      where: { userId, skillId: skill.id },
      orderBy: { createdAt: "asc" },
      select: { exerciseId: true, id: true },
    });
    expect(attempts.map((attempt) => attempt.exerciseId)).toEqual(
      expect.arrayContaining([firstExercise.id, secondExercise.id]),
    );
    expect(new Set(attempts.map((attempt) => attempt.id)).size).toBe(2);
  });

  it("completes an exhausted undersized session with its no-inventory message", async () => {
    const userId = await createUser();
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Exhausted undersized skill",
      dueAt: now,
      repetitions: 1,
    });
    const exercise = await createChoiceExercise({ prisma, userId, skillId: skill.id });
    const created = await createCustomPracticeSession({
      userId,
      mode: "PRACTICE_ONLY",
      targetCount: 2,
      scope: {
        collectionIds: [],
        tags: [],
        skillIds: [skill.id],
        recentlyMissed: false,
        mixedReview: false,
      },
      now,
    });
    if (created.status !== "ready") throw new Error("expected the undersized plan");

    const ready = await presentCustomPracticeSessionItem({
      userId,
      sessionId: created.session.id,
      now,
    });
    if (ready.status !== "ready") throw new Error("expected the only item");
    const committed = await commitCustomPracticeAnswer({
      userId,
      sessionId: created.session.id,
      itemKey: ready.sessionItem.itemKey,
      exerciseId: exercise.id,
      submittedAnswer: "right",
      now,
    });
    expect(committed.status).toBe("committed");
    if (committed.status !== "committed") throw new Error("expected the exhausted commit");
    expect(committed.completedCount).toBe(1);
    expect(committed.next).toEqual(
      expect.objectContaining({
        status: "completed",
        message: "This session ended because no selected exercise remains available.",
      }),
    );
    if (committed.next.status !== "completed" || !committed.next.session) {
      throw new Error("expected exhausted completion");
    }
    expect(committed.next.session.plan).toHaveLength(1);
  });

  it("does not admit a not-yet-due exercise into scheduled mode", async () => {
    const userId = await createUser();
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Not due scheduled skill",
      dueAt: new Date("2026-06-12T12:00:00.000Z"),
      repetitions: 1,
    });
    await createChoiceExercise({ prisma, userId, skillId: skill.id });
    const created = await createCustomPracticeSession({
      userId,
      mode: "SCHEDULED",
      targetCount: 1,
      scope: {
        collectionIds: [],
        tags: [],
        skillIds: [skill.id],
        recentlyMissed: false,
        mixedReview: false,
      },
      now,
    });
    expect(created.status).toBe("preparing");
    if (created.status !== "preparing") throw new Error("expected no due scheduled inventory");
    expect(created.message).toMatch(/verified compatible exercises/i);
  });

  it("keeps setup and reads preview-like and does not introduce a new skill at limit zero", async () => {
    const userId = await createUser({ dailyNewSkillLimit: 0 });
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Blocked new skill",
      dueAt: new Date("2026-06-10T12:00:00.000Z"),
    });
    await createChoiceExercise({ prisma, userId, skillId: skill.id });

    const created = await createCustomPracticeSession({
      userId,
      mode: "PRACTICE_ONLY",
      targetCount: 1,
      scope: {
        collectionIds: [],
        tags: [],
        skillIds: [skill.id],
        recentlyMissed: false,
        mixedReview: false,
      },
      now,
    });
    expect(created.status).toBe("ready");
    if (created.status !== "ready") throw new Error("expected a planned session");
    expect((await getCustomPracticeSession(userId, created.session.id))?.plan).toHaveLength(1);
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).firstIntroducedAt).toBeNull();

    const blocked = await presentCustomPracticeSessionItem({
      userId,
      sessionId: created.session.id,
      now,
    });
    expect(blocked).toEqual(expect.objectContaining({ status: "daily-limit" }));
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: skill.id } })).firstIntroducedAt).toBeNull();
  });

  it("stores mixed-review cue reduction only when the title was withheld", async () => {
    const userId = await createUser();
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Mixed review cue skill",
      dueAt: new Date("2026-06-10T12:00:00.000Z"),
      repetitions: 1,
    });
    const exercise = await createChoiceExercise({ prisma, userId, skillId: skill.id });

    const created = await createCustomPracticeSession({
      userId,
      mode: "PRACTICE_ONLY",
      targetCount: 1,
      scope: {
        collectionIds: [],
        tags: [],
        skillIds: [skill.id],
        recentlyMissed: false,
        mixedReview: true,
      },
      now,
    });
    if (created.status !== "ready") throw new Error("expected mixed practice session");
    const ready = await presentCustomPracticeSessionItem({
      userId,
      sessionId: created.session.id,
      now,
    });
    if (ready.status !== "ready") throw new Error("expected mixed ready item");

    await commitCustomPracticeAnswer({
      userId,
      sessionId: created.session.id,
      itemKey: ready.sessionItem.itemKey,
      exerciseId: exercise.id,
      submittedAnswer: "right",
      reducedRuleCues: true,
      now,
    });

    const attempt = await prisma.exerciseAttempt.findUniqueOrThrow({
      where: { id: ready.sessionItem.attemptId },
    });
    expect(attempt.practiceContext).toEqual(
      expect.objectContaining({ mixedReview: true, reducedRuleCues: true }),
    );
  });

  it("skips a blocked new item while serving an introduced item in the same session", async () => {
    const userId = await createUser({ dailyNewSkillLimit: 0 });
    const newSkill = await createSkillFixture(prisma, {
      userId,
      title: "Earlier blocked skill",
      dueAt: new Date("2026-06-02T10:00:00.000Z"),
    });
    const introducedSkill = await createSkillFixture(prisma, {
      userId,
      title: "Allowed introduced skill",
      dueAt: new Date("2026-06-02T11:00:00.000Z"),
      repetitions: 1,
    });
    await prisma.skill.update({
      where: { id: introducedSkill.id },
      data: { firstIntroducedAt: new Date("2026-06-01T12:00:00.000Z") },
    });
    const newExercise = await createChoiceExercise({ prisma, userId, skillId: newSkill.id });
    const introducedExercise = await createChoiceExercise({ prisma, userId, skillId: introducedSkill.id });

    const created = await createCustomPracticeSession({
      userId,
      mode: "PRACTICE_ONLY",
      targetCount: 2,
      scope: {
        collectionIds: [],
        tags: [],
        skillIds: [newSkill.id, introducedSkill.id],
        recentlyMissed: false,
        mixedReview: false,
      },
      now,
    });
    expect(created.status).toBe("ready");
    if (created.status !== "ready") throw new Error("expected mixed session plan");
    expect(created.session.plan.map((item) => item.exerciseId)).toEqual(
      expect.arrayContaining([newExercise.id, introducedExercise.id]),
    );

    const ready = await presentCustomPracticeSessionItem({
      userId,
      sessionId: created.session.id,
      now,
    });
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") throw new Error("expected introduced item to remain available");
    expect(ready.skill.id).toBe(introducedSkill.id);
    expect((await prisma.skill.findUniqueOrThrow({ where: { id: newSkill.id } })).firstIntroducedAt).toBeNull();
  });

  it("refills a planned item that becomes ineligible before completing the session", async () => {
    const userId = await createUser();
    const collection = await prisma.collection.create({ data: { userId, name: "Refill scope" } });
    const retiredSkill = await createSkillFixture(prisma, {
      userId,
      title: "Retired planned skill",
      collectionId: collection.id,
      dueAt: new Date("2026-06-01T10:00:00.000Z"),
      repetitions: 1,
    });
    const retiredExercise = await createChoiceExercise({ prisma, userId, skillId: retiredSkill.id });
    const retiredReplacementSkill = await createSkillFixture(prisma, {
      userId,
      title: "Retired replacement skill",
      collectionId: collection.id,
      dueAt: new Date("2026-06-02T10:00:00.000Z"),
      repetitions: 1,
    });
    const retiredReplacementExercise = await createChoiceExercise({
      prisma,
      userId,
      skillId: retiredReplacementSkill.id,
    });

    const retiredSession = await createCustomPracticeSession({
      userId,
      targetCount: 1,
      scope: {
        collectionIds: [collection.id],
        tags: [],
        skillIds: [retiredSkill.id, retiredReplacementSkill.id],
        recentlyMissed: false,
        mixedReview: false,
      },
      now,
    });
    if (retiredSession.status !== "ready") throw new Error("expected retired replacement plan");
    expect(retiredSession.session.plan[0]?.exerciseId).toBe(retiredExercise.id);
    await prisma.exercise.update({
      where: { id: retiredExercise.id },
      data: { retiredAt: now, retirementReason: "MANUAL" },
    });

    const retiredReady = await presentCustomPracticeSessionItem({
      userId,
      sessionId: retiredSession.session.id,
      now,
    });
    expect(retiredReady.status).toBe("ready");
    if (retiredReady.status !== "ready") throw new Error("expected retired replacement item");
    expect(retiredReady.exercise.id).toBe(retiredReplacementExercise.id);
    expect(retiredReady.sessionItem.status).toBe("PRESENTED");
    expect(retiredReady.session.plan.some((item) => item.status === "SKIPPED")).toBe(false);

    const movedSkill = await createSkillFixture(prisma, {
      userId,
      title: "Moved planned skill",
      collectionId: collection.id,
      dueAt: new Date("2026-06-01T11:00:00.000Z"),
      repetitions: 1,
    });
    const movedExercise = await createChoiceExercise({ prisma, userId, skillId: movedSkill.id });
    const movedReplacementSkill = await createSkillFixture(prisma, {
      userId,
      title: "Moved replacement skill",
      collectionId: collection.id,
      dueAt: new Date("2026-06-02T11:00:00.000Z"),
      repetitions: 1,
    });
    const movedReplacementExercise = await createChoiceExercise({
      prisma,
      userId,
      skillId: movedReplacementSkill.id,
    });
    const otherCollection = await prisma.collection.create({
      data: { userId, name: "Moved destination" },
    });
    const movedSession = await createCustomPracticeSession({
      userId,
      targetCount: 1,
      scope: {
        collectionIds: [collection.id],
        tags: [],
        skillIds: [movedSkill.id, movedReplacementSkill.id],
        recentlyMissed: false,
        mixedReview: false,
      },
      now,
    });
    if (movedSession.status !== "ready") throw new Error("expected moved replacement plan");
    expect(movedSession.session.plan[0]?.exerciseId).toBe(movedExercise.id);
    await prisma.skill.update({
      where: { id: movedSkill.id },
      data: { collectionId: otherCollection.id },
    });

    const movedReady = await presentCustomPracticeSessionItem({
      userId,
      sessionId: movedSession.session.id,
      now,
    });
    expect(movedReady.status).toBe("ready");
    if (movedReady.status !== "ready") throw new Error("expected moved replacement item");
    expect(movedReady.exercise.id).toBe(movedReplacementExercise.id);
    expect(movedReady.sessionItem.status).toBe("PRESENTED");
    expect(movedReady.session.plan.some((item) => item.status === "SKIPPED")).toBe(false);
  });

  it("serves an introduced replacement before daily limit when another item is blocked", async () => {
    const userId = await createUser({ dailyNewSkillLimit: 0 });
    const skippedSkill = await createSkillFixture(prisma, {
      userId,
      title: "Skipped before limit",
      dueAt: new Date("2026-06-01T10:00:00.000Z"),
      repetitions: 1,
    });
    const blockedSkill = await createSkillFixture(prisma, {
      userId,
      title: "Blocked new skill",
      dueAt: new Date("2026-06-02T10:00:00.000Z"),
    });
    const replacementSkill = await createSkillFixture(prisma, {
      userId,
      title: "Introduced replacement",
      dueAt: new Date("2026-06-03T10:00:00.000Z"),
      repetitions: 1,
    });
    await prisma.skill.update({
      where: { id: replacementSkill.id },
      data: { firstIntroducedAt: new Date("2026-06-01T12:00:00.000Z") },
    });
    const skippedExercise = await createChoiceExercise({ prisma, userId, skillId: skippedSkill.id });
    const blockedExercise = await createChoiceExercise({ prisma, userId, skillId: blockedSkill.id });
    const replacementExercise = await createChoiceExercise({ prisma, userId, skillId: replacementSkill.id });

    const created = await createCustomPracticeSession({
      userId,
      mode: "PRACTICE_ONLY",
      targetCount: 2,
      scope: {
        collectionIds: [],
        tags: [],
        skillIds: [skippedSkill.id, blockedSkill.id, replacementSkill.id],
        recentlyMissed: false,
        mixedReview: false,
      },
      now,
    });
    if (created.status !== "ready") throw new Error("expected daily-limit replacement plan");
    expect(created.session.plan.map((item) => item.exerciseId)).toEqual(
      expect.arrayContaining([skippedExercise.id, blockedExercise.id]),
    );
    await prisma.exercise.update({
      where: { id: skippedExercise.id },
      data: { retiredAt: now, retirementReason: "MANUAL" },
    });

    const ready = await presentCustomPracticeSessionItem({
      userId,
      sessionId: created.session.id,
      now,
    });
    expect(ready.status).toBe("ready");
    if (ready.status !== "ready") throw new Error("expected introduced replacement before limit");
    expect(ready.exercise.id).toBe(replacementExercise.id);
    expect(ready.session.plan.some((item) => item.status === "SKIPPED")).toBe(false);

    const committed = await commitCustomPracticeAnswer({
      userId,
      sessionId: created.session.id,
      itemKey: ready.sessionItem.itemKey,
      exerciseId: replacementExercise.id,
      submittedAnswer: "right",
      now,
    });
    expect(committed.status).toBe("committed");
    if (committed.status !== "committed") throw new Error("expected replacement commit");
    expect(committed.next.status).toBe("daily-limit");
  });

  it("rejects a second-tab preview while stopped and allows it after resume", async () => {
    const userId = await createUser();
    const skill = await createSkillFixture(prisma, {
      userId,
      title: "Stopped preview skill",
      dueAt: now,
      repetitions: 1,
    });
    const exercise = await createChoiceExercise({ prisma, userId, skillId: skill.id });
    const created = await createCustomPracticeSession({
      userId,
      targetCount: 1,
      scope: {
        collectionIds: [],
        tags: [],
        skillIds: [skill.id],
        recentlyMissed: false,
        mixedReview: false,
      },
      now,
    });
    if (created.status !== "ready") throw new Error("expected stopped-preview session");
    const ready = await presentCustomPracticeSessionItem({
      userId,
      sessionId: created.session.id,
      now,
    });
    if (ready.status !== "ready") throw new Error("expected stopped-preview item");

    const stopped = await stopCustomPracticeSession({
      userId,
      sessionId: created.session.id,
      now,
    });
    expect(stopped.status).toBe("updated");
    const denied = await previewCustomPracticeAnswer({
      userId,
      sessionId: created.session.id,
      itemKey: ready.sessionItem.itemKey,
      exerciseId: exercise.id,
      submittedAnswer: "right",
      now,
    });
    expect(denied).toEqual({
      status: "unavailable",
      message: "This practice session is stopped. Resume it to continue.",
    });

    const resumed = await resumeCustomPracticeSession({
      userId,
      sessionId: created.session.id,
      now: new Date(now.getTime() + 1_000),
    });
    expect(resumed.status).toBe("updated");
    const preview = await previewCustomPracticeAnswer({
      userId,
      sessionId: created.session.id,
      itemKey: ready.sessionItem.itemKey,
      exerciseId: exercise.id,
      submittedAnswer: "right",
      now: new Date(now.getTime() + 1_000),
    });
    expect(preview.status).toBe("checked");
  });

  it("rechecks selected filters and inventory when a queued item changes", async () => {
    const userId = await createUser();
    const firstCollection = await prisma.collection.create({ data: { userId, name: "First scope" } });
    const secondCollection = await prisma.collection.create({ data: { userId, name: "Second scope" } });

    const missedSkill = await createSkillFixture(prisma, {
      userId,
      title: "Recently missed tagged skill",
      collectionId: firstCollection.id,
      tags: ["focus", "algebra"],
      dueAt: new Date("2026-06-02T10:00:00.000Z"),
      repetitions: 1,
    });
    const excludedSkill = await createSkillFixture(prisma, {
      userId,
      title: "Tagged but not missed",
      collectionId: firstCollection.id,
      tags: ["focus"],
      dueAt: new Date("2026-06-02T11:00:00.000Z"),
      repetitions: 1,
    });
    const missedExercise = await createChoiceExercise({ prisma, userId, skillId: missedSkill.id });
    const excludedExercise = await createChoiceExercise({ prisma, userId, skillId: excludedSkill.id });
    await prisma.exerciseAttempt.create({
      data: {
        id: `missed_${randomUUID()}`,
        userId,
        skillId: missedSkill.id,
        exerciseId: missedExercise.id,
        answer: { raw: "wrong" },
        normalizedAnswer: "wrong",
        isCorrect: false,
        result: ExerciseAttemptResult.INCORRECT,
        proposedRating: null,
        finalRating: null,
        ratingPolicyVersion: "practice-only-test",
        createdAt: now,
      },
    });

    const scoped = await createCustomPracticeSession({
      userId,
      mode: "PRACTICE_ONLY",
      targetCount: 4,
      scope: {
        collectionIds: [firstCollection.id],
        tags: ["focus"],
        skillIds: [missedSkill.id, excludedSkill.id],
        recentlyMissed: true,
        mixedReview: false,
      },
      now,
    });
    expect(scoped.status).toBe("ready");
    if (scoped.status !== "ready") throw new Error("expected filtered scope to find one item");
    expect(scoped.session.plan[0]?.exerciseId).toBe(missedExercise.id);
    expect(scoped.session.plan.some((item) => item.exerciseId === excludedExercise.id)).toBe(false);

    const archived = await createSkillFixture(prisma, {
      userId,
      title: "Archived after planning",
      collectionId: firstCollection.id,
      dueAt: now,
    });
    await createChoiceExercise({ prisma, userId, skillId: archived.id });
    const archivedSession = await createCustomPracticeSession({
      userId,
      targetCount: 1,
      scope: {
        collectionIds: [firstCollection.id],
        tags: [],
        skillIds: [archived.id],
        recentlyMissed: false,
        mixedReview: false,
      },
      now,
    });
    if (archivedSession.status !== "ready") throw new Error("expected archived fixture plan");
    await prisma.skill.update({ where: { id: archived.id }, data: { status: "ARCHIVED" } });
    const archivedResult = await presentCustomPracticeSessionItem({ userId, sessionId: archivedSession.session.id, now });
    expect(archivedResult.status).toBe("completed");
    if (archivedResult.status === "completed") {
      expect(archivedResult.session?.plan[0]?.status).toBe("SKIPPED");
    }

    const moved = await createSkillFixture(prisma, {
      userId,
      title: "Moved after planning",
      collectionId: firstCollection.id,
      dueAt: now,
    });
    const movedExercise = await createChoiceExercise({ prisma, userId, skillId: moved.id });
    const movedSession = await createCustomPracticeSession({
      userId,
      targetCount: 1,
      scope: {
        collectionIds: [firstCollection.id],
        tags: [],
        skillIds: [moved.id],
        recentlyMissed: false,
        mixedReview: false,
      },
      now,
    });
    if (movedSession.status !== "ready") throw new Error("expected moved fixture plan");
    await prisma.skill.update({ where: { id: moved.id }, data: { collectionId: secondCollection.id } });
    const movedResult = await presentCustomPracticeSessionItem({ userId, sessionId: movedSession.session.id, now });
    expect(movedResult.status).toBe("completed");
    expect(await prisma.exerciseAttempt.count({ where: { userId, exerciseId: movedExercise.id } })).toBe(0);

    const retired = await createSkillFixture(prisma, { userId, title: "Retired after presentation", dueAt: now });
    const retiredExercise = await createChoiceExercise({ prisma, userId, skillId: retired.id });
    const retiredSession = await createCustomPracticeSession({
      userId,
      targetCount: 1,
      scope: {
        collectionIds: [],
        tags: [],
        skillIds: [retired.id],
        recentlyMissed: false,
        mixedReview: false,
      },
      now,
    });
    if (retiredSession.status !== "ready") throw new Error("expected retired fixture plan");
    const retiredReady = await presentCustomPracticeSessionItem({ userId, sessionId: retiredSession.session.id, now });
    if (retiredReady.status !== "ready") throw new Error("expected retired item before mutation");
    await prisma.exercise.update({ where: { id: retiredExercise.id }, data: { retiredAt: now, retirementReason: "MANUAL" } });
    const retiredCommit = await commitCustomPracticeAnswer({
      userId,
      sessionId: retiredSession.session.id,
      itemKey: retiredReady.sessionItem.itemKey,
      exerciseId: retiredExercise.id,
      submittedAnswer: "right",
      now,
    });
    expect(retiredCommit.status).toBe("unavailable");
    expect(await prisma.exerciseAttempt.count({ where: { userId, exerciseId: retiredExercise.id } })).toBe(0);
  });
});
