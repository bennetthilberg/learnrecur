ALTER TABLE "exercise_attempts"
  ADD COLUMN "evidenceCorrectionStatus" "ExerciseEvidenceCorrectionStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "evidenceCorrectionNote" TEXT,
  ADD COLUMN "evidenceCorrectionAt" TIMESTAMP(3),
  ADD COLUMN "evidenceCorrectionIncidentKey" TEXT;

ALTER TABLE "review_logs"
  ADD COLUMN "evidenceCorrectionStatus" "ExerciseEvidenceCorrectionStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "evidenceCorrectionNote" TEXT,
  ADD COLUMN "evidenceCorrectionAt" TIMESTAMP(3),
  ADD COLUMN "evidenceCorrectionIncidentKey" TEXT;

ALTER TABLE "exercise_flags"
  ADD COLUMN "replayedReviewCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "quarantinedExerciseCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "affectedAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "practiceOnlyAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "resolutionIdempotencyKey" TEXT,
  ADD COLUMN "resolutionPayloadHash" TEXT,
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE "exercise_flags"
  ALTER COLUMN "updatedAt" DROP DEFAULT;

CREATE INDEX "exercise_attempts_skillId_evidenceCorrectionStatus_createdAt_idx"
  ON "exercise_attempts"("skillId", "evidenceCorrectionStatus", "createdAt");

CREATE INDEX "review_logs_skillId_evidenceCorrectionStatus_reviewedAt_idx"
  ON "review_logs"("skillId", "evidenceCorrectionStatus", "reviewedAt");

CREATE INDEX "exercise_flags_userId_resolutionIdempotencyKey_idx"
  ON "exercise_flags"("userId", "resolutionIdempotencyKey");
