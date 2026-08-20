CREATE TABLE "agent_operation_actions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "toolName" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_operation_actions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "agent_operation_sources" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "sourceFileId" TEXT NOT NULL,
  "ordinal" INTEGER NOT NULL,
  CONSTRAINT "agent_operation_sources_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "agent_operation_actions_connectionId_toolName_idempotencyKey_key" ON "agent_operation_actions"("connectionId", "toolName", "idempotencyKey");
CREATE INDEX "agent_operation_actions_operationId_createdAt_idx" ON "agent_operation_actions"("operationId", "createdAt");
CREATE UNIQUE INDEX "agent_operation_sources_operationId_sourceFileId_key" ON "agent_operation_sources"("operationId", "sourceFileId");
CREATE UNIQUE INDEX "agent_operation_sources_operationId_ordinal_key" ON "agent_operation_sources"("operationId", "ordinal");
CREATE INDEX "agent_operation_sources_sourceFileId_idx" ON "agent_operation_sources"("sourceFileId");

ALTER TABLE "agent_operation_actions" ADD CONSTRAINT "agent_operation_actions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_operation_actions" ADD CONSTRAINT "agent_operation_actions_connectionId_userId_fkey" FOREIGN KEY ("connectionId", "userId") REFERENCES "agent_connections"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_operation_actions" ADD CONSTRAINT "agent_operation_actions_operationId_userId_fkey" FOREIGN KEY ("operationId", "userId") REFERENCES "agent_skill_operations"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_operation_sources" ADD CONSTRAINT "agent_operation_sources_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_operation_sources" ADD CONSTRAINT "agent_operation_sources_operationId_userId_fkey" FOREIGN KEY ("operationId", "userId") REFERENCES "agent_skill_operations"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "agent_operation_sources" ADD CONSTRAINT "agent_operation_sources_sourceFileId_userId_fkey" FOREIGN KEY ("sourceFileId", "userId") REFERENCES "source_files"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
