ALTER TABLE "agent_skill_operation_items"
  ADD COLUMN "workerClaimToken" TEXT,
  ADD COLUMN "workerClaimedAt" TIMESTAMP(3);

CREATE INDEX "agent_skill_operation_items_userId_status_workerClaimedAt_idx"
  ON "agent_skill_operation_items"("userId", "status", "workerClaimedAt");
