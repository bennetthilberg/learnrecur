import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { getPracticeLocalDate } from "./daily-limit-contracts";

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
    select: { dailyNewSkillLimit: true, practiceTimezone: true },
  });
  const { dailyNewSkillLimit: limit, practiceTimezone: timezone } = user;
  if (limit === null) return { limit, timezone, remaining: null };
  if (limit === 0) return { limit, timezone, remaining: 0 };
  const localDate = getPracticeLocalDate(now, timezone);
  // A local calendar day can be 23 or 25 hours. Narrow by the indexed timestamp
  // first, then compare local dates without assuming a fixed-length day.
  const windowMs = 36 * 60 * 60 * 1000;
  const introductions = await tx.skill.findMany({
    where: {
      userId,
      firstIntroducedAt: {
        gte: new Date(now.getTime() - windowMs),
        lte: new Date(now.getTime() + windowMs),
      },
    },
    select: { firstIntroducedAt: true },
  });
  const used = introductions.filter(
    (item) =>
      getPracticeLocalDate(item.firstIntroducedAt!, timezone) === localDate,
  ).length;
  return { limit, timezone, remaining: Math.max(0, limit - used) };
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
