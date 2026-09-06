import "server-only";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { getPrisma } from "@/lib/prisma";
import {
  parseTextPolicyOverride,
  practicePreferenceOverrideSchema,
  practicePreferenceSchema,
  resolveTextPolicy,
  textPolicySchema,
} from "./policies";

export const userPracticePreferencesSchema = z.strictObject({
  practicePreference: practicePreferenceSchema,
  mixedReview: z.boolean(),
});
export const collectionPracticePreferencesSchema = z.strictObject({
  practicePreference: practicePreferenceOverrideSchema,
  textPolicy: textPolicySchema.nullable(),
});
export const skillPracticePreferencesSchema =
  collectionPracticePreferencesSchema.extend({
    alreadyStudied: z.boolean(),
  });

export async function getUserPracticePreferences(userId: string) {
  const user = await getPrisma().user.findUniqueOrThrow({
    where: { id: userId },
    select: { practicePreference: true, mixedReview: true },
  });
  return userPracticePreferencesSchema.parse(user);
}

export async function saveUserPracticePreferences(
  userId: string,
  input: unknown,
) {
  const data = userPracticePreferencesSchema.parse(input);
  await getPrisma().user.update({ where: { id: userId }, data });
  return data;
}

// A comparison change retires future text inventory only. Neither historical
// contracts/attempts nor the skill's FSRS card is edited. The row lock also fences
// in-flight exact-input publication. Maintenance can retry preparation after a
// failed delivery using the ordinary bounded refill jobs.
export async function invalidateTextInventory(
  tx: Prisma.TransactionClient,
  userId: string,
  skillIds: string[],
  now: Date,
) {
  if (!skillIds.length) return;
  await tx.skill.updateMany({
    where: { userId, id: { in: skillIds } },
    data: {
      textPolicyRevision: { increment: 1 },
      generationSpec: Prisma.DbNull,
      generationSpecStatus: "SUPERSEDED",
      generationSpecFingerprint: null,
    },
  });
  await tx.exercise.updateMany({
    where: {
      userId,
      skillId: { in: skillIds },
      answerKind: "TEXT",
      retiredAt: null,
    },
    data: { retiredAt: now, retirementReason: "REPLACED" },
  });
  await tx.generationJob.updateMany({
    where: {
      userId,
      skillId: { in: skillIds },
      kind: { in: ["EXACT_INPUT_EXERCISE_GENERATION", "SKILL_ACTIVATION"] },
      status: { in: ["PENDING", "RUNNING"] },
    },
    data: {
      status: "FAILED",
      stage: "FAILED",
      failureCategory: "CANCELED",
      completedAt: now,
      errorMessage:
        "Text policy changed. Prepare using the current comparison policy.",
    },
  });
}

export async function saveSkillPracticePreferences(input: {
  userId: string;
  skillId: string;
  input: unknown;
  now: Date;
}) {
  const data = skillPracticePreferencesSchema.parse(input.input);
  return getPrisma().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${input.userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "skills" WHERE "id" = ${input.skillId} AND "userId" = ${input.userId} FOR UPDATE`;
    const skill = await tx.skill.findFirst({
      where: { id: input.skillId, userId: input.userId },
      include: { collection: true },
    });
    if (!skill) return { status: "not-found" as const };
    const storedSkillPolicy = parseTextPolicyOverride(skill.textPolicy);
    const storedCollectionPolicy = parseTextPolicyOverride(
      skill.collection?.textPolicy,
    );
    const invalidInheritedPolicy =
      skill.collection?.textPolicy != null && storedCollectionPolicy === null;
    const invalidPreviousPolicy =
      skill.textPolicy !== null
        ? storedSkillPolicy === null
        : invalidInheritedPolicy;
    const previous = resolveTextPolicy({
      skill: storedSkillPolicy,
      collection: storedCollectionPolicy,
    });
    const next = resolveTextPolicy({
      skill: data.textPolicy,
      collection: storedCollectionPolicy,
    });
    const policyChanged =
      invalidPreviousPolicy ||
      (data.textPolicy === null && invalidInheritedPolicy) ||
      previous.normalizeCase !== next.normalizeCase ||
      previous.normalizeWhitespace !== next.normalizeWhitespace ||
      // Explicitly adopting v2 for the first time also renews legacy inventory.
      (skill.textPolicy === null && data.textPolicy !== null);
    await tx.skill.update({
      where: { id: skill.id },
      data: { ...data, textPolicy: data.textPolicy ?? Prisma.DbNull },
    });
    if (policyChanged)
      await invalidateTextInventory(tx, input.userId, [skill.id], input.now);
    return { status: "saved" as const, skillIds: [skill.id], policyChanged };
  });
}

// Collections are a compact override, not a global language setting. Bound the
// edit to 500 inheriting skills; explicit skill overrides remain independent.
export async function saveCollectionPracticePreferences(input: {
  userId: string;
  collectionId: string;
  input: unknown;
  now: Date;
}) {
  const data = collectionPracticePreferencesSchema.parse(input.input);
  return getPrisma().$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${input.userId} FOR UPDATE`;
    await tx.$queryRaw`SELECT "id" FROM "collections" WHERE "id" = ${input.collectionId} AND "userId" = ${input.userId} FOR UPDATE`;
    const collection = await tx.collection.findFirst({
      where: { id: input.collectionId, userId: input.userId },
    });
    if (!collection) return { status: "not-found" as const };
    const storedPolicy = parseTextPolicyOverride(collection.textPolicy);
    const invalidPreviousPolicy =
      collection.textPolicy !== null && storedPolicy === null;
    const previous = resolveTextPolicy({ collection: storedPolicy });
    const next = resolveTextPolicy({ collection: data.textPolicy });
    const policyChanged =
      invalidPreviousPolicy ||
      previous.normalizeCase !== next.normalizeCase ||
      previous.normalizeWhitespace !== next.normalizeWhitespace ||
      (collection.textPolicy === null && data.textPolicy !== null);
    const inheriting = policyChanged
      ? await tx.skill.findMany({
          where: {
            userId: input.userId,
            collectionId: collection.id,
            textPolicy: { equals: Prisma.AnyNull },
          },
          orderBy: { id: "asc" },
          take: 501,
          select: { id: true },
        })
      : [];
    if (inheriting.length > 500) return { status: "too-large" as const };
    const inheritingIds = inheriting.map((skill) => skill.id);
    if (inheritingIds.length)
      await tx.$queryRaw`SELECT "id" FROM "skills" WHERE "userId" = ${input.userId} AND "id" IN (${Prisma.join(inheritingIds)}) ORDER BY "id" FOR UPDATE`;
    await tx.collection.update({
      where: { id: collection.id },
      data: { ...data, textPolicy: data.textPolicy ?? Prisma.DbNull },
    });
    if (policyChanged)
      await invalidateTextInventory(tx, input.userId, inheritingIds, input.now);
    return {
      status: "saved" as const,
      // Immediate preparation is bounded; remaining due skills are picked up
      // when practice opens or the learner uses existing preparation controls.
      skillIds: (
        await tx.skill.findMany({
          where: {
            userId: input.userId,
            collectionId: collection.id,
            status: "ACTIVE",
          },
          orderBy: [{ dueAt: "asc" }, { id: "asc" }],
          take: 10,
          select: { id: true },
        })
      ).map((skill) => skill.id),
      policyChanged,
    };
  });
}
