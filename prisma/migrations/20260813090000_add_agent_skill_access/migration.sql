CREATE TYPE "AgentConnectionStatus" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "AgentRemoteRevocationStatus" AS ENUM ('NOT_REQUESTED', 'PENDING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "AgentOperationKind" AS ENUM ('SPEC_BATCH', 'TEXT_SOURCE', 'MATERIAL_BATCH', 'QUICK_FILES');
CREATE TYPE "AgentOperationStatus" AS ENUM ('AWAITING_UPLOAD', 'QUEUED', 'PLANNING', 'NEEDS_INPUT', 'NEEDS_REVIEW', 'GENERATING', 'VERIFYING', 'ACTIVATING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELED');
CREATE TYPE "AgentOperationItemStatus" AS ENUM ('QUEUED', 'PLANNING', 'NEEDS_INPUT', 'NEEDS_REVIEW', 'GENERATING', 'VERIFYING', 'ACTIVATING', 'ACTIVE', 'REUSED', 'FAILED', 'CANCELED');
CREATE TYPE "AgentCandidateStatus" AS ENUM ('PENDING', 'VALIDATED', 'VERIFIED', 'REJECTED', 'NOT_PROCESSED');
CREATE TYPE "AgentRevocationOutboxStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

ALTER TABLE "users" ADD COLUMN "agentAccessDisabledAt" TIMESTAMP(3);

CREATE TABLE "workos_identities" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "workosUserId" TEXT NOT NULL,
  "externalId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "workos_identities_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_connections" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "workosIdentityId" TEXT NOT NULL,
  "workosSubject" TEXT NOT NULL,
  "workosSessionId" TEXT NOT NULL,
  "workosApplicationId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "clientName" TEXT NOT NULL,
  "clientDomain" TEXT NOT NULL,
  "resourceUrl" TEXT NOT NULL,
  "scopes" TEXT[],
  "permissionVersion" INTEGER NOT NULL DEFAULT 1,
  "status" "AgentConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
  "remoteRevocationStatus" "AgentRemoteRevocationStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
  "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastUsedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_connections_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_skill_operations" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "kind" "AgentOperationKind" NOT NULL,
  "toolName" TEXT NOT NULL,
  "status" "AgentOperationStatus" NOT NULL DEFAULT 'QUEUED',
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "requestPayload" JSONB,
  "payloadExpiresAt" TIMESTAMP(3),
  "sourceFileId" TEXT,
  "materialRevisionId" TEXT,
  "requestedCount" INTEGER NOT NULL DEFAULT 0,
  "activeCount" INTEGER NOT NULL DEFAULT 0,
  "reusedCount" INTEGER NOT NULL DEFAULT 0,
  "failedCount" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_skill_operations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_skill_operation_items" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "clientReference" TEXT NOT NULL,
  "status" "AgentOperationItemStatus" NOT NULL DEFAULT 'QUEUED',
  "proposedTitle" TEXT,
  "proposedObjective" TEXT,
  "skillSnapshot" JSONB,
  "candidateFingerprint" TEXT,
  "duplicateLibraryFingerprint" TEXT,
  "duplicateConfidence" TEXT,
  "createdSkillId" TEXT,
  "resultSkillId" TEXT,
  "errorCode" TEXT,
  "errorMessage" TEXT,
  "retryCount" INTEGER NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_skill_operation_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_exercise_candidates" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "operationItemId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "clientReference" TEXT,
  "kind" "AnswerKind" NOT NULL,
  "normalizedPayload" JSONB NOT NULL,
  "status" "AgentCandidateStatus" NOT NULL DEFAULT 'PENDING',
  "verifierReason" TEXT,
  "verifierNote" TEXT,
  "exerciseId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_exercise_candidates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_revocation_outbox" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "status" "AgentRevocationOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "errorCode" TEXT,
  "nextAttemptAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_revocation_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workos_identities_userId_key" ON "workos_identities"("userId");
CREATE UNIQUE INDEX "workos_identities_workosUserId_key" ON "workos_identities"("workosUserId");
CREATE UNIQUE INDEX "workos_identities_externalId_key" ON "workos_identities"("externalId");
CREATE UNIQUE INDEX "workos_identities_id_userId_key" ON "workos_identities"("id", "userId");
CREATE UNIQUE INDEX "agent_connections_workosSessionId_key" ON "agent_connections"("workosSessionId");
CREATE UNIQUE INDEX "agent_connections_id_userId_key" ON "agent_connections"("id", "userId");
CREATE INDEX "agent_connections_userId_status_connectedAt_idx" ON "agent_connections"("userId", "status", "connectedAt");
CREATE INDEX "agent_connections_workosSubject_clientId_resourceUrl_idx" ON "agent_connections"("workosSubject", "clientId", "resourceUrl");
CREATE UNIQUE INDEX "agent_skill_operations_id_userId_key" ON "agent_skill_operations"("id", "userId");
CREATE UNIQUE INDEX "agent_skill_operations_connectionId_toolName_idempotencyKey_key" ON "agent_skill_operations"("connectionId", "toolName", "idempotencyKey");
CREATE INDEX "agent_skill_operations_userId_status_createdAt_idx" ON "agent_skill_operations"("userId", "status", "createdAt");
CREATE INDEX "agent_skill_operations_connectionId_createdAt_idx" ON "agent_skill_operations"("connectionId", "createdAt");
CREATE UNIQUE INDEX "agent_skill_operation_items_createdSkillId_key" ON "agent_skill_operation_items"("createdSkillId");
CREATE UNIQUE INDEX "agent_skill_operation_items_id_userId_key" ON "agent_skill_operation_items"("id", "userId");
CREATE UNIQUE INDEX "agent_skill_operation_items_operationId_ordinal_key" ON "agent_skill_operation_items"("operationId", "ordinal");
CREATE UNIQUE INDEX "agent_skill_operation_items_operationId_clientReference_key" ON "agent_skill_operation_items"("operationId", "clientReference");
CREATE INDEX "agent_skill_operation_items_userId_status_createdAt_idx" ON "agent_skill_operation_items"("userId", "status", "createdAt");
CREATE INDEX "agent_skill_operation_items_resultSkillId_idx" ON "agent_skill_operation_items"("resultSkillId");
CREATE UNIQUE INDEX "agent_exercise_candidates_exerciseId_key" ON "agent_exercise_candidates"("exerciseId");
CREATE UNIQUE INDEX "agent_exercise_candidates_id_userId_key" ON "agent_exercise_candidates"("id", "userId");
CREATE UNIQUE INDEX "agent_exercise_candidates_operationItemId_ordinal_key" ON "agent_exercise_candidates"("operationItemId", "ordinal");
CREATE INDEX "agent_exercise_candidates_userId_status_createdAt_idx" ON "agent_exercise_candidates"("userId", "status", "createdAt");
CREATE UNIQUE INDEX "agent_revocation_outbox_id_userId_key" ON "agent_revocation_outbox"("id", "userId");
CREATE UNIQUE INDEX "agent_revocation_outbox_connectionId_userId_key" ON "agent_revocation_outbox"("connectionId", "userId");
CREATE INDEX "agent_revocation_outbox_status_nextAttemptAt_idx" ON "agent_revocation_outbox"("status", "nextAttemptAt");

ALTER TABLE "workos_identities" ADD CONSTRAINT "workos_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_connections" ADD CONSTRAINT "agent_connections_workosIdentityId_userId_fkey" FOREIGN KEY ("workosIdentityId", "userId") REFERENCES "workos_identities"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_skill_operations" ADD CONSTRAINT "agent_skill_operations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_skill_operations" ADD CONSTRAINT "agent_skill_operations_connectionId_userId_fkey" FOREIGN KEY ("connectionId", "userId") REFERENCES "agent_connections"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_skill_operations" ADD CONSTRAINT "agent_skill_operations_sourceFileId_fkey" FOREIGN KEY ("sourceFileId") REFERENCES "source_files"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_skill_operations" ADD CONSTRAINT "agent_skill_operations_materialRevisionId_fkey" FOREIGN KEY ("materialRevisionId") REFERENCES "material_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_skill_operation_items" ADD CONSTRAINT "agent_skill_operation_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_skill_operation_items" ADD CONSTRAINT "agent_skill_operation_items_operationId_userId_fkey" FOREIGN KEY ("operationId", "userId") REFERENCES "agent_skill_operations"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_skill_operation_items" ADD CONSTRAINT "agent_skill_operation_items_createdSkillId_fkey" FOREIGN KEY ("createdSkillId") REFERENCES "skills"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_skill_operation_items" ADD CONSTRAINT "agent_skill_operation_items_resultSkillId_fkey" FOREIGN KEY ("resultSkillId") REFERENCES "skills"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_exercise_candidates" ADD CONSTRAINT "agent_exercise_candidates_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_exercise_candidates" ADD CONSTRAINT "agent_exercise_candidates_operationItemId_userId_fkey" FOREIGN KEY ("operationItemId", "userId") REFERENCES "agent_skill_operation_items"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_exercise_candidates" ADD CONSTRAINT "agent_exercise_candidates_exerciseId_fkey" FOREIGN KEY ("exerciseId") REFERENCES "exercises"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "agent_revocation_outbox" ADD CONSTRAINT "agent_revocation_outbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_revocation_outbox" ADD CONSTRAINT "agent_revocation_outbox_connectionId_userId_fkey" FOREIGN KEY ("connectionId", "userId") REFERENCES "agent_connections"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
