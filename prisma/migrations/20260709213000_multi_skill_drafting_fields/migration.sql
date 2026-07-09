ALTER TABLE "skill_draft_batches"
  ADD COLUMN "proposedPlan" JSONB,
  ADD COLUMN "planningMetadata" JSONB;

ALTER TABLE "skill_draft_batch_items"
  ADD COLUMN "generationMetadata" JSONB;

CREATE OR REPLACE FUNCTION enforce_owned_batch_item_skill()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."skillId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "skills"
    WHERE "id" = NEW."skillId" AND "userId" = NEW."userId"
  ) THEN
    RAISE EXCEPTION 'batch item skill must belong to the same user';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "skill_draft_batch_items_owned_skill_guard"
BEFORE INSERT OR UPDATE OF "skillId", "userId" ON "skill_draft_batch_items"
FOR EACH ROW EXECUTE FUNCTION enforce_owned_batch_item_skill();
