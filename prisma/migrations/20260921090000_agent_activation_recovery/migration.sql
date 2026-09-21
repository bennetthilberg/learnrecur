ALTER TABLE "agent_skill_operation_items"
  ADD COLUMN "workerClaimToken" TEXT,
  ADD COLUMN "workerClaimedAt" TIMESTAMP(3);

-- Keep stale recovery from blocking item writes on the live operation table.
CREATE INDEX CONCURRENTLY "agent_skill_operation_items_userId_status_workerClaimedAt_idx"
  ON "agent_skill_operation_items"("userId", "status", "workerClaimedAt");

CREATE INDEX CONCURRENTLY "agent_skill_operation_items_status_workerClaimedAt_updatedAt_idx"
  ON "agent_skill_operation_items"("status", "workerClaimedAt", "updatedAt");
