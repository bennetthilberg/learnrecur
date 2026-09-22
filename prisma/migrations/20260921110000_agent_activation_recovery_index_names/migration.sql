-- The preceding migration used a PostgreSQL identifier longer than 63 bytes.
-- Rename its truncated physical name when that migration has already run.
ALTER INDEX IF EXISTS "agent_skill_operation_items_status_workerClaimedAt_updatedAt_id"
  RENAME TO "agent_skill_items_status_claimed_updated_idx";
