CREATE TYPE "AccountDeletionJobStatus" AS ENUM ('PENDING', 'RUNNING', 'FAILED', 'COMPLETE');
CREATE TYPE "AccountDeletionPhase" AS ENUM ('DISABLE_ACCESS', 'DELETE_OBJECTS', 'DELETE_RELATIONAL_DATA', 'DELETE_CLERK_IDENTITY', 'COMPLETE');

CREATE TABLE "account_deletion_jobs" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "AccountDeletionJobStatus" NOT NULL DEFAULT 'PENDING',
  "phase" "AccountDeletionPhase" NOT NULL DEFAULT 'DISABLE_ACCESS',
  "manifestVersion" INTEGER NOT NULL DEFAULT 1,
  "manifest" JSONB NOT NULL,
  "objectCount" INTEGER NOT NULL DEFAULT 0,
  "deletedObjectCount" INTEGER NOT NULL DEFAULT 0,
  "agentConnectionCount" INTEGER NOT NULL DEFAULT 0,
  "revokedAgentConnectionCount" INTEGER NOT NULL DEFAULT 0,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "clerkAttemptCount" INTEGER NOT NULL DEFAULT 0,
  "accessDisabledAt" TIMESTAMP(3),
  "objectsDeletedAt" TIMESTAMP(3),
  "relationalDataDeletedAt" TIMESTAMP(3),
  "clerkDeletedAt" TIMESTAMP(3),
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "nextAttemptAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "account_deletion_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "account_deletion_jobs_manifest_version_check" CHECK ("manifestVersion" = 1),
  CONSTRAINT "account_deletion_jobs_object_counts_check" CHECK (
    "objectCount" >= 0 AND "deletedObjectCount" >= 0 AND "deletedObjectCount" <= "objectCount"
  ),
  CONSTRAINT "account_deletion_jobs_agent_counts_check" CHECK (
    "agentConnectionCount" >= 0
    AND "revokedAgentConnectionCount" >= 0
    AND "revokedAgentConnectionCount" <= "agentConnectionCount"
  ),
  CONSTRAINT "account_deletion_jobs_attempt_counts_check" CHECK (
    "attemptCount" >= 0 AND "clerkAttemptCount" >= 0
  )
);

CREATE UNIQUE INDEX "account_deletion_jobs_userId_key" ON "account_deletion_jobs"("userId");
CREATE INDEX "account_deletion_jobs_status_nextAttemptAt_idx"
  ON "account_deletion_jobs"("status", "nextAttemptAt");
CREATE INDEX "account_deletion_jobs_phase_status_idx"
  ON "account_deletion_jobs"("phase", "status");
