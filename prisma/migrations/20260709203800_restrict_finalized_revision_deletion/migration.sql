BEGIN;

-- Account deletion may cascade directly to revision children while the owner
-- row is already gone. All other direct child writes remain protected unless
-- the revision has explicitly entered the deletion workflow.
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

  IF TG_OP = 'DELETE'
    AND old_user_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM "users" owner WHERE owner."id" = old_user_id
    )
  THEN
    RETURN OLD;
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

-- Guard the parent snapshot as well. Without this trigger a direct revision or
-- material delete can remove the parent first, making child triggers unable to
-- inspect the revision state during the FK cascade.
CREATE OR REPLACE FUNCTION prevent_unapproved_finalized_revision_delete()
RETURNS trigger AS $$
BEGIN
  IF OLD."finalizedAt" IS NULL OR OLD."status" = 'DELETING' THEN
    RETURN OLD;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "users" owner WHERE owner."id" = OLD."userId"
  ) THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Finalized material revisions must enter the deletion workflow before removal'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "material_revisions_prevent_unapproved_delete" ON "material_revisions";
CREATE TRIGGER "material_revisions_prevent_unapproved_delete"
BEFORE DELETE ON "material_revisions"
FOR EACH ROW
EXECUTE FUNCTION prevent_unapproved_finalized_revision_delete();

COMMIT;
