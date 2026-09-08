ALTER TABLE "users" ADD COLUMN "dailyNewSkillLimit" INTEGER,
ADD COLUMN "practiceTimezone" TEXT NOT NULL DEFAULT 'UTC';
ALTER TABLE "users" ADD CONSTRAINT "users_daily_new_skill_limit_check"
CHECK ("dailyNewSkillLimit" IS NULL OR "dailyNewSkillLimit" BETWEEN 0 AND 1000);

ALTER TABLE "skills" ADD COLUMN "firstIntroducedAt" TIMESTAMP(3);
-- Existing review evidence proves prior introduction. Preserve the evidence and
-- schedule; only seed the new presentation marker from the earliest review.
UPDATE "skills" s SET "firstIntroducedAt" = r."firstReview"
FROM (SELECT "skillId", "userId", MIN("reviewedAt") AS "firstReview"
      FROM "review_logs" GROUP BY "skillId", "userId") r
WHERE s."id" = r."skillId" AND s."userId" = r."userId";
UPDATE "skills" SET "firstIntroducedAt" = "lastReviewedAt"
WHERE "firstIntroducedAt" IS NULL AND "lastReviewedAt" IS NOT NULL;
CREATE INDEX "skills_userId_firstIntroducedAt_idx" ON "skills"("userId", "firstIntroducedAt");
