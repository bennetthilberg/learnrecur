import type { Prisma } from "@/generated/prisma/client";

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
