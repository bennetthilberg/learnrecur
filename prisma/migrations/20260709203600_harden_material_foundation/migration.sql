BEGIN;

-- A failed development deployment may have reached one of these DDL statements
-- before PostgreSQL rejected a later statement. Remove only this migration's
-- objects so retrying the migration is deterministic.
DROP TRIGGER IF EXISTS "source_files_prevent_finalized_material_mutation" ON "source_files";
DROP TRIGGER IF EXISTS "material_chunks_prevent_finalized_mutation" ON "material_chunks";
DROP TRIGGER IF EXISTS "material_sections_prevent_finalized_mutation" ON "material_sections";
DROP TRIGGER IF EXISTS "skill_draft_batch_items_enforce_skill_ownership" ON "skill_draft_batch_items";
DROP FUNCTION IF EXISTS prevent_finalized_material_child_mutation();
DROP FUNCTION IF EXISTS enforce_skill_draft_item_skill_ownership();
ALTER TABLE "material_chunks"
  DROP CONSTRAINT IF EXISTS "material_chunks_materialSectionId_materialRevisionId_userId_fkey",
  DROP CONSTRAINT IF EXISTS "material_chunks_sourceFileId_materialRevisionId_userId_fkey";
ALTER TABLE "material_sections"
  DROP CONSTRAINT IF EXISTS "material_sections_parentId_materialRevisionId_userId_fkey";
ALTER TABLE "skill_draft_batch_items"
  DROP CONSTRAINT IF EXISTS "skill_draft_batch_items_ordinal_check";
DROP INDEX IF EXISTS "source_files_id_materialRevisionId_userId_key";
DROP INDEX IF EXISTS "material_sections_id_materialRevisionId_userId_key";

-- Make page bounds all-or-nothing. SQL CHECK constraints accept UNKNOWN, so
-- each bounded branch must explicitly require both values.
ALTER TABLE "material_sections"
  DROP CONSTRAINT "material_sections_page_range_check",
  ADD CONSTRAINT "material_sections_page_range_check" CHECK (
    ("pageStart" IS NULL AND "pageEnd" IS NULL)
    OR (
      "pageStart" IS NOT NULL
      AND "pageEnd" IS NOT NULL
      AND "pageStart" > 0
      AND "pageEnd" >= "pageStart"
    )
  );

-- A batch can contain at most ten zero-based items even if a buggy writer
-- supplies a valid requestedCount.
ALTER TABLE "skill_draft_batch_items"
  ADD CONSTRAINT "skill_draft_batch_items_ordinal_check" CHECK ("ordinal" BETWEEN 0 AND 9);

-- Structural and evidence references must stay inside one immutable revision.
CREATE UNIQUE INDEX "source_files_id_materialRevisionId_userId_key"
  ON "source_files"("id", "materialRevisionId", "userId");
CREATE UNIQUE INDEX "material_sections_id_materialRevisionId_userId_key"
  ON "material_sections"("id", "materialRevisionId", "userId");

ALTER TABLE "material_sections"
  ADD CONSTRAINT "material_sections_parentId_materialRevisionId_userId_fkey"
  FOREIGN KEY ("parentId", "materialRevisionId", "userId")
  REFERENCES "material_sections"("id", "materialRevisionId", "userId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "material_chunks"
  DROP CONSTRAINT IF EXISTS "material_chunks_materialSectionId_userId_fkey",
  DROP CONSTRAINT IF EXISTS "material_chunks_sourceFileId_userId_fkey",
  ADD CONSTRAINT "material_chunks_materialSectionId_materialRevisionId_userId_fkey"
  FOREIGN KEY ("materialSectionId", "materialRevisionId", "userId")
  REFERENCES "material_sections"("id", "materialRevisionId", "userId")
  ON DELETE NO ACTION ON UPDATE CASCADE,
  ADD CONSTRAINT "material_chunks_sourceFileId_materialRevisionId_userId_fkey"
  FOREIGN KEY ("sourceFileId", "materialRevisionId", "userId")
  REFERENCES "source_files"("id", "materialRevisionId", "userId")
  ON DELETE NO ACTION ON UPDATE CASCADE;

-- Preserve the existing ON DELETE SET NULL behavior while rejecting a skill
-- owned by another user at the database boundary.
CREATE OR REPLACE FUNCTION enforce_skill_draft_item_skill_ownership()
RETURNS trigger AS $$
BEGIN
  IF NEW."skillId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "skills" skill
    WHERE skill."id" = NEW."skillId"
      AND skill."userId" = NEW."userId"
  ) THEN
    RAISE EXCEPTION 'Draft batch item skill must belong to the same user'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "skill_draft_batch_items_enforce_skill_ownership"
BEFORE INSERT OR UPDATE OF "skillId", "userId" ON "skill_draft_batch_items"
FOR EACH ROW
EXECUTE FUNCTION enforce_skill_draft_item_skill_ownership();

-- Revisions are snapshots. Once finalized, their sections, chunks, and owned
-- source records cannot be inserted, changed, detached, or deleted. Deletion
-- cleanup is allowed after the revision has entered DELETING.
CREATE OR REPLACE FUNCTION prevent_finalized_material_child_mutation()
RETURNS trigger AS $$
DECLARE
  old_revision_id TEXT;
  old_user_id TEXT;
  new_revision_id TEXT;
  new_user_id TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    old_revision_id := OLD."materialRevisionId";
    old_user_id := OLD."userId";
  END IF;

  IF TG_OP <> 'DELETE' THEN
    new_revision_id := NEW."materialRevisionId";
    new_user_id := NEW."userId";
  END IF;

  IF old_revision_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM "material_revisions" revision
    WHERE revision."id" = old_revision_id
      AND revision."userId" = old_user_id
      AND revision."finalizedAt" IS NOT NULL
      AND revision."status" <> 'DELETING'
  ) THEN
    RAISE EXCEPTION 'Finalized material revision children are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF new_revision_id IS NOT NULL
    AND (new_revision_id, new_user_id) IS DISTINCT FROM (old_revision_id, old_user_id)
    AND EXISTS (
      SELECT 1
      FROM "material_revisions" revision
      WHERE revision."id" = new_revision_id
        AND revision."userId" = new_user_id
        AND revision."finalizedAt" IS NOT NULL
        AND revision."status" <> 'DELETING'
    )
  THEN
    RAISE EXCEPTION 'Finalized material revision children are immutable'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "material_sections_prevent_finalized_mutation"
BEFORE INSERT OR UPDATE OR DELETE ON "material_sections"
FOR EACH ROW
EXECUTE FUNCTION prevent_finalized_material_child_mutation();

CREATE TRIGGER "material_chunks_prevent_finalized_mutation"
BEFORE INSERT OR UPDATE OR DELETE ON "material_chunks"
FOR EACH ROW
EXECUTE FUNCTION prevent_finalized_material_child_mutation();

CREATE TRIGGER "source_files_prevent_finalized_material_mutation"
BEFORE INSERT OR UPDATE OR DELETE ON "source_files"
FOR EACH ROW
EXECUTE FUNCTION prevent_finalized_material_child_mutation();

COMMIT;
