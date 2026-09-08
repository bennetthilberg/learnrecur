ALTER TABLE "users"
  ADD COLUMN "desiredRetention" DOUBLE PRECISION,
  ADD COLUMN "practiceDayStartMinutes" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "users"
  ADD CONSTRAINT "users_desired_retention_check"
    CHECK ("desiredRetention" IS NULL OR "desiredRetention" BETWEEN 0.70 AND 0.99),
  ADD CONSTRAINT "users_practice_day_start_minutes_check"
    CHECK ("practiceDayStartMinutes" BETWEEN 0 AND 1439);

CREATE TYPE "PracticeSessionMode" AS ENUM ('PRACTICE_ONLY', 'SCHEDULED');
CREATE TYPE "PracticeSessionStatus" AS ENUM ('ACTIVE', 'STOPPED', 'COMPLETED');
CREATE TYPE "AgentSetupPlanStatus" AS ENUM (
  'PREVIEWED',
  'APPLYING',
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'STALE',
  'CANCELED'
);

CREATE TABLE "practice_sessions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "mode" "PracticeSessionMode" NOT NULL,
  "status" "PracticeSessionStatus" NOT NULL DEFAULT 'ACTIVE',
  "targetCount" INTEGER NOT NULL,
  "completedCount" INTEGER NOT NULL DEFAULT 0,
  "nextIndex" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "scope" JSONB NOT NULL,
  "plan" JSONB NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "stoppedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "practice_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "practice_sessions_id_userId_key"
  ON "practice_sessions"("id", "userId");
CREATE INDEX "practice_sessions_userId_status_updatedAt_idx"
  ON "practice_sessions"("userId", "status", "updatedAt");

CREATE TABLE "agent_setup_plans" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "permissionVersion" INTEGER NOT NULL,
  "requestedSpec" JSONB NOT NULL,
  "snapshot" JSONB NOT NULL,
  "status" "AgentSetupPlanStatus" NOT NULL DEFAULT 'PREVIEWED',
  "result" JSONB,
  "errors" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_setup_plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_setup_plans_id_userId_key"
  ON "agent_setup_plans"("id", "userId");
CREATE UNIQUE INDEX "agent_setup_plans_connectionId_idempotencyKey_key"
  ON "agent_setup_plans"("connectionId", "idempotencyKey");
CREATE INDEX "agent_setup_plans_userId_status_updatedAt_idx"
  ON "agent_setup_plans"("userId", "status", "updatedAt");

ALTER TABLE "practice_sessions"
  ADD CONSTRAINT "practice_sessions_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "agent_setup_plans"
  ADD CONSTRAINT "agent_setup_plans_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "agent_setup_plans_connectionId_userId_fkey"
    FOREIGN KEY ("connectionId", "userId") REFERENCES "agent_connections"("id", "userId")
    ON DELETE CASCADE ON UPDATE CASCADE;
