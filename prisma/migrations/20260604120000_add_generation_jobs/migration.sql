-- CreateEnum
CREATE TYPE "GenerationJobKind" AS ENUM ('CHOICE_EXERCISE_GENERATION');

-- CreateEnum
CREATE TYPE "GenerationJobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "generation_jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "kind" "GenerationJobKind" NOT NULL,
    "status" "GenerationJobStatus" NOT NULL DEFAULT 'PENDING',
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "requestedCount" INTEGER NOT NULL,
    "acceptedCount" INTEGER NOT NULL DEFAULT 0,
    "rejectedCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "generation_jobs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "generation_jobs_requestedCount_nonnegative_check" CHECK ("requestedCount" >= 0),
    CONSTRAINT "generation_jobs_acceptedCount_nonnegative_check" CHECK ("acceptedCount" >= 0),
    CONSTRAINT "generation_jobs_rejectedCount_nonnegative_check" CHECK ("rejectedCount" >= 0),
    CONSTRAINT "generation_jobs_counts_not_over_requested_check" CHECK (("acceptedCount" + "rejectedCount") <= "requestedCount")
);

-- CreateIndex
CREATE INDEX "generation_jobs_userId_createdAt_idx" ON "generation_jobs"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "generation_jobs_skillId_status_idx" ON "generation_jobs"("skillId", "status");

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "generation_jobs" ADD CONSTRAINT "generation_jobs_skillId_userId_fkey" FOREIGN KEY ("skillId", "userId") REFERENCES "skills"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
