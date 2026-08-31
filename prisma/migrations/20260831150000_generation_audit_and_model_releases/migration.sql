-- Additive generation audit, incident-correction, and model-release state.
-- Existing generation jobs, exercises, and flags remain valid through nullable
-- metadata columns and queryable defaults.

BEGIN;

CREATE TYPE "SkillGenerationSpecStatus" AS ENUM ('DRAFT', 'READY', 'ACCEPTED', 'REJECTED', 'SUPERSEDED');
CREATE TYPE "GenerationJobStage" AS ENUM ('QUEUED', 'PLANNING', 'GENERATING', 'VALIDATING', 'VERIFYING', 'ADJUDICATING', 'PUBLISHING', 'COMPLETE', 'FAILED');
CREATE TYPE "GenerationFailureCategory" AS ENUM ('NONE', 'TRANSPORT', 'TIMEOUT', 'RATE_LIMIT', 'AUTHENTICATION', 'SCHEMA', 'DETERMINISTIC', 'SEMANTIC', 'SOURCE_EVIDENCE', 'DUPLICATE', 'DIVERSITY', 'COST_LIMIT', 'CANCELED', 'UNKNOWN');
CREATE TYPE "GenerationDegradedState" AS ENUM ('NONE', 'FALLBACK_ACTIVE', 'FALLBACK_USED', 'QUALITY_REPAIR', 'ADJUDICATION_REQUIRED');
CREATE TYPE "GenerationAuditDecision" AS ENUM ('IN_PROGRESS', 'RETRY', 'ACCEPTED', 'REJECTED', 'QUARANTINED', 'PUBLISHED', 'FAILED');
CREATE TYPE "ModelReleaseState" AS ENUM ('DRAFT', 'CANARY', 'APPROVED', 'PAUSED', 'ROLLED_BACK', 'REJECTED');
CREATE TYPE "ExerciseFlagAdjudicationStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED', 'INCONCLUSIVE');
CREATE TYPE "ExerciseEvidenceCorrectionAction" AS ENUM ('NONE', 'INVALIDATE', 'INVALIDATE_AND_REPLAY');
CREATE TYPE "ExerciseEvidenceCorrectionStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'IN_PROGRESS', 'COMPLETE', 'BLOCKED');

ALTER TABLE "skills"
  ADD COLUMN "generationSpec" JSONB,
  ADD COLUMN "generationSpecVersion" TEXT,
  ADD COLUMN "generationSpecFingerprint" TEXT,
  ADD COLUMN "generationSpecStatus" "SkillGenerationSpecStatus" NOT NULL DEFAULT 'DRAFT';

ALTER TABLE "generation_jobs"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "releaseTuple" JSONB,
  ADD COLUMN "generationReleaseId" TEXT,
  ADD COLUMN "verifierReleaseId" TEXT,
  ADD COLUMN "stage" "GenerationJobStage" NOT NULL DEFAULT 'QUEUED',
  ADD COLUMN "checkpoint" TEXT,
  ADD COLUMN "attemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "retryCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "contextManifest" JSONB,
  ADD COLUMN "contextManifestHash" TEXT,
  ADD COLUMN "stageMetrics" JSONB,
  ADD COLUMN "failureCategory" "GenerationFailureCategory" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "degradedState" "GenerationDegradedState" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "fallbackProvider" TEXT,
  ADD COLUMN "fallbackModel" TEXT,
  ADD COLUMN "fallbackReasonCode" TEXT;

-- Preserve a useful stage for historical rows without pretending that their
-- old records contain stage-level evidence.
UPDATE "generation_jobs"
SET "stage" = CASE "status"
  WHEN 'RUNNING' THEN 'GENERATING'::"GenerationJobStage"
  WHEN 'SUCCEEDED' THEN 'COMPLETE'::"GenerationJobStage"
  WHEN 'FAILED' THEN 'FAILED'::"GenerationJobStage"
  ELSE 'QUEUED'::"GenerationJobStage"
END;

ALTER TABLE "generation_jobs"
  ADD CONSTRAINT "generation_jobs_attemptCount_nonnegative_check" CHECK ("attemptCount" >= 0),
  ADD CONSTRAINT "generation_jobs_retryCount_nonnegative_check" CHECK ("retryCount" >= 0),
  ADD CONSTRAINT "generation_jobs_maxAttempts_positive_check" CHECK ("maxAttempts" > 0);

ALTER TABLE "exercises"
  ADD COLUMN "skillSpecVersion" TEXT,
  ADD COLUMN "skillSpecFingerprint" TEXT,
  ADD COLUMN "exerciseSpecVersion" TEXT,
  ADD COLUMN "blueprintVersion" TEXT,
  ADD COLUMN "blueprintSlot" TEXT,
  ADD COLUMN "exerciseFamily" TEXT,
  ADD COLUMN "qualityVersion" TEXT,
  ADD COLUMN "provenance" JSONB,
  ADD COLUMN "acceptanceDecision" "GenerationAuditDecision",
  ADD COLUMN "acceptanceMetadata" JSONB,
  ADD COLUMN "generationMetadata" JSONB,
  ADD COLUMN "generatorReleaseId" TEXT,
  ADD COLUMN "verifierReleaseId" TEXT;

ALTER TABLE "exercise_flags"
  ADD COLUMN "adjudicationStatus" "ExerciseFlagAdjudicationStatus" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "adjudicatedAt" TIMESTAMP(3),
  ADD COLUMN "adjudicationCode" TEXT,
  ADD COLUMN "evidenceCorrectionAction" "ExerciseEvidenceCorrectionAction" NOT NULL DEFAULT 'NONE',
  ADD COLUMN "evidenceCorrectionStatus" "ExerciseEvidenceCorrectionStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "practiceEvidenceNeedsCorrection" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "affectedReviewCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "correctionStartedAt" TIMESTAMP(3),
  ADD COLUMN "correctionCompletedAt" TIMESTAMP(3),
  ADD COLUMN "incidentKey" TEXT;

ALTER TABLE "exercise_flags"
  ADD CONSTRAINT "exercise_flags_affectedReviewCount_nonnegative_check" CHECK ("affectedReviewCount" >= 0);

CREATE TABLE "model_releases" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "releaseFingerprint" TEXT NOT NULL,
    "state" "ModelReleaseState" NOT NULL DEFAULT 'DRAFT',
    "releaseTuple" JSONB NOT NULL,
    "canaryPercent" INTEGER NOT NULL DEFAULT 0,
    "canarySampleCount" INTEGER NOT NULL DEFAULT 0,
    "canaryAcceptedCount" INTEGER NOT NULL DEFAULT 0,
    "canaryRejectedCount" INTEGER NOT NULL DEFAULT 0,
    "canaryStopReason" TEXT,
    "canaryMetrics" JSONB,
    "rollbackToId" TEXT,
    "approvedAt" TIMESTAMP(3),
    "canaryStartedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "model_releases_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "model_releases_canaryPercent_check" CHECK ("canaryPercent" BETWEEN 0 AND 100),
    CONSTRAINT "model_releases_canarySampleCount_nonnegative_check" CHECK ("canarySampleCount" >= 0),
    CONSTRAINT "model_releases_canaryAcceptedCount_nonnegative_check" CHECK ("canaryAcceptedCount" >= 0),
    CONSTRAINT "model_releases_canaryRejectedCount_nonnegative_check" CHECK ("canaryRejectedCount" >= 0),
    CONSTRAINT "model_releases_canaryCounts_not_over_sample_check" CHECK (("canaryAcceptedCount" + "canaryRejectedCount") <= "canarySampleCount")
);

CREATE TABLE "generation_audit_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "skillId" TEXT,
    "candidateId" TEXT,
    "exerciseId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "stage" "GenerationJobStage" NOT NULL,
    "checkpoint" TEXT,
    "attempt" INTEGER NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "releaseTuple" JSONB NOT NULL,
    "contextManifest" JSONB,
    "contextManifestHash" TEXT,
    "stageMetrics" JSONB,
    "candidateMetadata" JSONB,
    "failureCategory" "GenerationFailureCategory" NOT NULL DEFAULT 'NONE',
    "degradedState" "GenerationDegradedState" NOT NULL DEFAULT 'NONE',
    "decision" "GenerationAuditDecision" NOT NULL DEFAULT 'IN_PROGRESS',
    "generationReleaseId" TEXT,
    "verifierReleaseId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "generation_audit_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "generation_audit_records_attempt_nonnegative_check" CHECK ("attempt" >= 0),
    CONSTRAINT "generation_audit_records_retryCount_nonnegative_check" CHECK ("retryCount" >= 0)
);

CREATE UNIQUE INDEX "generation_jobs_id_userId_key"
  ON "generation_jobs"("id", "userId");
CREATE UNIQUE INDEX "generation_jobs_userId_idempotencyKey_key"
  ON "generation_jobs"("userId", "idempotencyKey");
CREATE INDEX "generation_jobs_userId_stage_status_idx"
  ON "generation_jobs"("userId", "stage", "status");
CREATE INDEX "generation_jobs_failureCategory_createdAt_idx"
  ON "generation_jobs"("failureCategory", "createdAt");
CREATE INDEX "generation_jobs_degradedState_createdAt_idx"
  ON "generation_jobs"("degradedState", "createdAt");

CREATE INDEX "skills_generation_spec_lookup_idx"
  ON "skills"("userId", "generationSpecStatus", "generationSpecFingerprint");
CREATE INDEX "exercises_skillId_skillSpecFingerprint_idx"
  ON "exercises"("skillId", "skillSpecFingerprint");
CREATE INDEX "exercises_exerciseFamily_qualityVersion_idx"
  ON "exercises"("exerciseFamily", "qualityVersion");
CREATE INDEX "exercise_flags_adjudicationStatus_evidenceCorrectionStatus_idx"
  ON "exercise_flags"("adjudicationStatus", "evidenceCorrectionStatus");
CREATE INDEX "exercise_flags_incidentKey_idx"
  ON "exercise_flags"("incidentKey");

CREATE UNIQUE INDEX "model_releases_provider_model_releaseFingerprint_key"
  ON "model_releases"("provider", "model", "releaseFingerprint");
CREATE INDEX "model_releases_provider_model_state_idx"
  ON "model_releases"("provider", "model", "state");
CREATE INDEX "model_releases_state_updatedAt_idx"
  ON "model_releases"("state", "updatedAt");

CREATE UNIQUE INDEX "generation_audit_records_jobId_eventKey_key"
  ON "generation_audit_records"("jobId", "eventKey");
CREATE INDEX "generation_audit_records_userId_createdAt_idx"
  ON "generation_audit_records"("userId", "createdAt");
CREATE INDEX "generation_audit_records_jobId_stage_createdAt_idx"
  ON "generation_audit_records"("jobId", "stage", "createdAt");
CREATE INDEX "generation_audit_records_idempotencyKey_idx"
  ON "generation_audit_records"("idempotencyKey");
CREATE INDEX "generation_audit_records_decision_createdAt_idx"
  ON "generation_audit_records"("decision", "createdAt");

ALTER TABLE "model_releases"
  ADD CONSTRAINT "model_releases_rollbackToId_fkey"
  FOREIGN KEY ("rollbackToId") REFERENCES "model_releases"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "generation_jobs"
  ADD CONSTRAINT "generation_jobs_generationReleaseId_fkey"
  FOREIGN KEY ("generationReleaseId") REFERENCES "model_releases"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "generation_jobs_verifierReleaseId_fkey"
  FOREIGN KEY ("verifierReleaseId") REFERENCES "model_releases"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "exercises"
  ADD CONSTRAINT "exercises_generatorReleaseId_fkey"
  FOREIGN KEY ("generatorReleaseId") REFERENCES "model_releases"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "exercises_verifierReleaseId_fkey"
  FOREIGN KEY ("verifierReleaseId") REFERENCES "model_releases"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "generation_audit_records"
  ADD CONSTRAINT "generation_audit_records_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "generation_audit_records_jobId_userId_fkey"
  FOREIGN KEY ("jobId", "userId") REFERENCES "generation_jobs"("id", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "generation_audit_records_skillId_userId_fkey"
  FOREIGN KEY ("skillId", "userId") REFERENCES "skills"("id", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "generation_audit_records_exerciseId_userId_fkey"
  FOREIGN KEY ("exerciseId", "userId") REFERENCES "exercises"("id", "userId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "generation_audit_records_generationReleaseId_fkey"
  FOREIGN KEY ("generationReleaseId") REFERENCES "model_releases"("id")
  ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "generation_audit_records_verifierReleaseId_fkey"
  FOREIGN KEY ("verifierReleaseId") REFERENCES "model_releases"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
