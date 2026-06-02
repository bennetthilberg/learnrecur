-- CreateEnum
CREATE TYPE "CollectionStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SourceFileKind" AS ENUM ('IMAGE', 'PDF', 'TEXT', 'URL', 'OTHER');

-- CreateEnum
CREATE TYPE "SourceFileStatus" AS ENUM ('DRAFT', 'UPLOADED', 'PROCESSING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "SkillStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "SkillFsrsState" AS ENUM ('NEW', 'LEARNING', 'REVIEW', 'RELEARNING');

-- CreateEnum
CREATE TYPE "ExerciseType" AS ENUM ('MULTIPLE_CHOICE', 'EXACT_INPUT');

-- CreateEnum
CREATE TYPE "AnswerKind" AS ENUM ('CHOICE', 'TEXT', 'NUMERIC', 'MATH');

-- CreateEnum
CREATE TYPE "ExerciseVerificationStatus" AS ENUM ('DRAFT', 'UNVERIFIED', 'VERIFIED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ExerciseAttemptResult" AS ENUM ('CORRECT', 'INCORRECT', 'SKIPPED');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "imageUrl" TEXT,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" "CollectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "source_files" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "collectionId" TEXT,
    "kind" "SourceFileKind" NOT NULL DEFAULT 'OTHER',
    "status" "SourceFileStatus" NOT NULL DEFAULT 'DRAFT',
    "originalName" TEXT NOT NULL,
    "mimeType" TEXT,
    "byteSize" INTEGER,
    "storageBucket" TEXT,
    "storageKey" TEXT,
    "publicUrl" TEXT,
    "extractedText" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "source_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skills" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "collectionId" TEXT,
    "title" TEXT NOT NULL,
    "objective" TEXT,
    "rules" JSONB,
    "examples" JSONB,
    "exerciseConstraints" JSONB,
    "tags" TEXT[],
    "status" "SkillStatus" NOT NULL DEFAULT 'DRAFT',
    "dueAt" TIMESTAMP(3),
    "stability" DOUBLE PRECISION,
    "difficulty" DOUBLE PRECISION,
    "elapsedDays" INTEGER NOT NULL DEFAULT 0,
    "scheduledDays" INTEGER NOT NULL DEFAULT 0,
    "learningSteps" INTEGER NOT NULL DEFAULT 0,
    "repetitions" INTEGER NOT NULL DEFAULT 0,
    "lapses" INTEGER NOT NULL DEFAULT 0,
    "fsrsState" "SkillFsrsState" NOT NULL DEFAULT 'NEW',
    "lastReviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_source_refs" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "sourceFileId" TEXT NOT NULL,
    "locator" JSONB,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "skill_source_refs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exercises" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "type" "ExerciseType" NOT NULL,
    "answerKind" "AnswerKind" NOT NULL,
    "prompt" TEXT NOT NULL,
    "choices" JSONB,
    "answerSpec" JSONB NOT NULL,
    "correctAnswerDisplay" TEXT NOT NULL,
    "explanation" TEXT,
    "difficulty" INTEGER,
    "expectedSeconds" INTEGER,
    "verificationStatus" "ExerciseVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "freshnessKey" TEXT,
    "sourceRefs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exercises_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exercise_attempts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "exerciseId" TEXT NOT NULL,
    "answer" JSONB NOT NULL,
    "normalizedAnswer" TEXT,
    "isCorrect" BOOLEAN NOT NULL,
    "result" "ExerciseAttemptResult" NOT NULL,
    "responseMs" INTEGER,
    "feedbackShownAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "exercise_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "collections_userId_status_idx" ON "collections"("userId", "status");

-- CreateIndex
CREATE INDEX "source_files_userId_status_idx" ON "source_files"("userId", "status");

-- CreateIndex
CREATE INDEX "source_files_collectionId_idx" ON "source_files"("collectionId");

-- CreateIndex
CREATE INDEX "skills_userId_status_dueAt_idx" ON "skills"("userId", "status", "dueAt");

-- CreateIndex
CREATE INDEX "skills_collectionId_idx" ON "skills"("collectionId");

-- CreateIndex
CREATE INDEX "skill_source_refs_sourceFileId_idx" ON "skill_source_refs"("sourceFileId");

-- CreateIndex
CREATE UNIQUE INDEX "skill_source_refs_skillId_sourceFileId_key" ON "skill_source_refs"("skillId", "sourceFileId");

-- CreateIndex
CREATE INDEX "exercises_userId_createdAt_idx" ON "exercises"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "exercises_skillId_verificationStatus_idx" ON "exercises"("skillId", "verificationStatus");

-- CreateIndex
CREATE INDEX "exercise_attempts_userId_createdAt_idx" ON "exercise_attempts"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "exercise_attempts_skillId_createdAt_idx" ON "exercise_attempts"("skillId", "createdAt");

-- CreateIndex
CREATE INDEX "exercise_attempts_exerciseId_idx" ON "exercise_attempts"("exerciseId");

-- AddForeignKey
ALTER TABLE "collections" ADD CONSTRAINT "collections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skills" ADD CONSTRAINT "skills_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "collections"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_source_refs" ADD CONSTRAINT "skill_source_refs_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_source_refs" ADD CONSTRAINT "skill_source_refs_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "source_files"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercises" ADD CONSTRAINT "exercises_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_attempts" ADD CONSTRAINT "exercise_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_attempts" ADD CONSTRAINT "exercise_attempts_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exercise_attempts" ADD CONSTRAINT "exercise_attempts_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "exercises"("id") ON DELETE CASCADE ON UPDATE CASCADE;
