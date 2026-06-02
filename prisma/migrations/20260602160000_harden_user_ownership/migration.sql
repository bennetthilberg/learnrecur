-- DropForeignKey
ALTER TABLE "exercise_attempts" DROP CONSTRAINT "exercise_attempts_exerciseId_fkey";

-- DropForeignKey
ALTER TABLE "exercise_attempts" DROP CONSTRAINT "exercise_attempts_skillId_fkey";

-- DropForeignKey
ALTER TABLE "exercise_flags" DROP CONSTRAINT "exercise_flags_exerciseId_fkey";

-- DropForeignKey
ALTER TABLE "exercises" DROP CONSTRAINT "exercises_skillId_fkey";

-- DropForeignKey
ALTER TABLE "review_logs" DROP CONSTRAINT "review_logs_exerciseAttemptId_fkey";

-- DropForeignKey
ALTER TABLE "review_logs" DROP CONSTRAINT "review_logs_skillId_fkey";

-- DropForeignKey
ALTER TABLE "skill_source_refs" DROP CONSTRAINT "skill_source_refs_skillId_fkey";

-- DropForeignKey
ALTER TABLE "skill_source_refs" DROP CONSTRAINT "skill_source_refs_sourceFileId_fkey";

-- DropForeignKey
ALTER TABLE "skills" DROP CONSTRAINT "skills_collectionId_fkey";

-- DropForeignKey
ALTER TABLE "source_files" DROP CONSTRAINT "source_files_collectionId_fkey";

-- AlterTable
ALTER TABLE "skill_source_refs" ADD COLUMN     "userId" TEXT;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "skill_source_refs"
        INNER JOIN "skills" ON "skill_source_refs"."skillId" = "skills"."id"
        INNER JOIN "source_files" ON "skill_source_refs"."sourceFileId" = "source_files"."id"
        WHERE "source_files"."userId" <> "skills"."userId"
    ) THEN
        RAISE EXCEPTION 'Cannot harden skill_source_refs ownership: at least one source ref links a skill and source file owned by different users.';
    END IF;
END $$;

UPDATE "skill_source_refs"
SET "userId" = "skills"."userId"
FROM "skills"
WHERE "skill_source_refs"."skillId" = "skills"."id";

ALTER TABLE "skill_source_refs" ALTER COLUMN "userId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "collections_id_userId_key" ON "collections"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "exercise_attempts_id_userId_key" ON "exercise_attempts"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "exercise_attempts_id_skillId_userId_key" ON "exercise_attempts"("id", "skillId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "exercises_id_userId_key" ON "exercises"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "exercises_id_skillId_userId_key" ON "exercises"("id", "skillId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "review_logs_exerciseAttemptId_skillId_userId_key" ON "review_logs"("exerciseAttemptId", "skillId", "userId");

-- CreateIndex
CREATE INDEX "skill_source_refs_userId_idx" ON "skill_source_refs"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "skills_id_userId_key" ON "skills"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "source_files_id_userId_key" ON "source_files"("id", "userId");

-- AddForeignKey
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_collectionId_userId_fkey" FOREIGN KEY ("collectionId", "userId") REFERENCES "collections"("id", "userId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_collectionId_userId_fkey" FOREIGN KEY ("collectionId", "userId") REFERENCES "collections"("id", "userId") ON DELETE NO ACTION ON UPDATE CASCADE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "skill_source_refs"
        INNER JOIN "skills" ON "skill_source_refs"."skillId" = "skills"."id"
        INNER JOIN "source_files" ON "skill_source_refs"."sourceFileId" = "source_files"."id"
        WHERE "skill_source_refs"."userId" <> "skills"."userId"
           OR "skill_source_refs"."userId" <> "source_files"."userId"
    ) THEN
        RAISE EXCEPTION 'Cannot add owner-aware skill_source_refs foreign keys: skill, source file, and source ref owners must match.';
    END IF;
END $$;

-- AddForeignKey
ALTER TABLE "skill_source_refs" ADD CONSTRAINT "skill_source_refs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_source_refs" ADD CONSTRAINT "skill_source_refs_skillId_userId_fkey" FOREIGN KEY ("skillId", "userId") REFERENCES "skills"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_source_refs" ADD CONSTRAINT "skill_source_refs_sourceFileId_userId_fkey" FOREIGN KEY ("sourceFileId", "userId") REFERENCES "source_files"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_skillId_userId_fkey" FOREIGN KEY ("skillId", "userId") REFERENCES "skills"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_attempts" ADD CONSTRAINT "exercise_attempts_skillId_userId_fkey" FOREIGN KEY ("skillId", "userId") REFERENCES "skills"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_attempts" ADD CONSTRAINT "exercise_attempts_exerciseId_skillId_userId_fkey" FOREIGN KEY ("exerciseId", "skillId", "userId") REFERENCES "exercises"("id", "skillId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_skillId_userId_fkey" FOREIGN KEY ("skillId", "userId") REFERENCES "skills"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_exerciseAttemptId_skillId_userId_fkey" FOREIGN KEY ("exerciseAttemptId", "skillId", "userId") REFERENCES "exercise_attempts"("id", "skillId", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_flags" ADD CONSTRAINT "exercise_flags_exerciseId_userId_fkey" FOREIGN KEY ("exerciseId", "userId") REFERENCES "exercises"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
