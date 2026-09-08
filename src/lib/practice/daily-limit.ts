import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { getPracticeDayBounds } from "./daily-limit-contracts";

export const previouslyIntroducedSkillWhere: Prisma.SkillWhereInput = {
  OR: [
    { firstIntroducedAt: { not: null } },
    { lastReviewedAt: { not: null } },
    { repetitions: { gt: 0 } },
  ],
};
export const unintroducedSkillWhere: Prisma.SkillWhereInput = {
  firstIntroducedAt: null,
  lastReviewedAt: null,
  repetitions: 0,
};

// Call under the user row lock whenever the result authorizes an introduction.
export async function getDailyNewSkillAllowance(
  tx: Pick<Prisma.TransactionClient, "user" | "skill">,
  userId: string,
  now: Date,
) {
  const user = await tx.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      dailyNewSkillLimit: true,
      practiceTimezone: true,
      practiceDayStartMinutes: true,
    },
  });
  const {
    dailyNewSkillLimit: limit,
    practiceTimezone: timezone,
    practiceDayStartMinutes: dayStartMinutes,
  } = user;
  if (limit === null) {
    return {
      limit,
      timezone,
      dayStartMinutes,
      remaining: null,
    };
  }
  if (limit === 0) {
    return {
      limit,
      timezone,
      dayStartMinutes,
      remaining: 0,
    };
  }
  const bounds = getPracticeDayBounds(now, timezone, dayStartMinutes);
  // Query consecutive local-calendar boundaries. DST can make this interval 23
  // or 25 hours, so a fixed-width subtraction would miscount introductions.
  const introductions = await tx.skill.findMany({
    where: {
      userId,
      firstIntroducedAt: {
        gte: bounds.start,
        lt: bounds.end,
      },
    },
    select: { firstIntroducedAt: true },
  });
  return {
    limit,
    timezone,
    dayStartMinutes,
    remaining: Math.max(0, limit - introductions.length),
  };
}

export async function recordSkillIntroduction(
  tx: Pick<Prisma.TransactionClient, "skill">,
  userId: string,
  skillId: string,
  now: Date,
) {
  await tx.skill.updateMany({
    where: { id: skillId, userId, ...unintroducedSkillWhere },
    data: { firstIntroducedAt: now },
  });
}
