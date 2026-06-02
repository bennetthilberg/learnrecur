-- CreateEnum
CREATE TYPE "FsrsRating" AS ENUM ('AGAIN', 'HARD', 'GOOD', 'EASY');

-- CreateEnum
CREATE TYPE "ExerciseRetirementReason" AS ENUM ('FLAGGED_INCORRECT', 'FLAGGED_UNCLEAR', 'FLAGGED_UNFAIR', 'STALE', 'DUPLICATE', 'REPLACED', 'MANUAL', 'OTHER');

-- CreateEnum
CREATE TYPE "ExerciseFlagReason" AS ENUM ('INCORRECT_ANSWER', 'UNCLEAR_PROMPT', 'UNFAIR', 'STALE', 'NOT_USEFUL', 'OFF_TOPIC', 'OTHER');

-- CreateEnum
CREATE TYPE "ExerciseFlagStatus" AS ENUM ('OPEN', 'RESOLVED', 'DISMISSED');

-- AlterTable
ALTER TABLE "exercise_attempts" ADD COLUMN     "finalRating" "FsrsRating",
ADD COLUMN     "proposedRating" "FsrsRating";

-- AlterTable
ALTER TABLE "exercises" ADD COLUMN     "retiredAt" TIMESTAMP(3),
ADD COLUMN     "retirementReason" "ExerciseRetirementReason";

-- CreateTable
CREATE TABLE "review_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "exerciseAttemptId" TEXT NOT NULL,
    "finalRating" "FsrsRating" NOT NULL,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "previousDueAt" TIMESTAMP(3),
    "nextDueAt" TIMESTAMP(3),
    "previousStability" DOUBLE PRECISION,
    "nextStability" DOUBLE PRECISION,
    "previousDifficulty" DOUBLE PRECISION,
    "nextDifficulty" DOUBLE PRECISION,
    "previousElapsedDays" INTEGER,
    "nextElapsedDays" INTEGER,
    "previousScheduledDays" INTEGER,
    "nextScheduledDays" INTEGER,
    "previousLearningSteps" INTEGER,
    "nextLearningSteps" INTEGER,
    "previousRepetitions" INTEGER,
    "nextRepetitions" INTEGER,
    "previousLapses" INTEGER,
    "nextLapses" INTEGER,
    "previousState" "SkillFsrsState",
    "nextState" "SkillFsrsState",
    "schedulerName" TEXT NOT NULL,
    "schedulerVersion" TEXT NOT NULL,
    "desiredRetention" DOUBLE PRECISION NOT NULL,
    "schedulerParameters" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exercise_flags" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "reason" "ExerciseFlagReason" NOT NULL,
    "note" TEXT,
    "status" "ExerciseFlagStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "retiredExerciseAt" TIMESTAMP(3),
    "retirementReason" "ExerciseRetirementReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exercise_flags_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "review_logs_exerciseAttemptId_key" ON "review_logs"("exerciseAttemptId");

-- CreateIndex
CREATE INDEX "review_logs_userId_reviewedAt_idx" ON "review_logs"("userId", "reviewedAt");

-- CreateIndex
CREATE INDEX "review_logs_skillId_reviewedAt_idx" ON "review_logs"("skillId", "reviewedAt");

-- CreateIndex
CREATE INDEX "exercise_flags_userId_createdAt_idx" ON "exercise_flags"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "exercise_flags_exerciseId_status_idx" ON "exercise_flags"("exerciseId", "status");

-- CreateIndex
CREATE INDEX "exercises_skillId_verificationStatus_retiredAt_idx" ON "exercises"("skillId", "verificationStatus", "retiredAt");

-- AddForeignKey
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "review_logs" ADD CONSTRAINT "review_logs_exerciseAttemptId_fkey" FOREIGN KEY ("exerciseAttemptId") REFERENCES "exercise_attempts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_flags" ADD CONSTRAINT "exercise_flags_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_flags" ADD CONSTRAINT "exercise_flags_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "exercises"("id") ON DELETE CASCADE ON UPDATE CASCADE;
