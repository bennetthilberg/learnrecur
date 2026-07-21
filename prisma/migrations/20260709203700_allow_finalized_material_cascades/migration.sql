BEGIN;

-- Direct child writes remain forbidden after finalization, but parent/user
-- deletion invokes these row triggers from a referential-action trigger. Let
-- those cascades remove the immutable snapshot as a unit.
CREATE OR REPLACE FUNCTION prevent_finalized_material_child_mutation()
RETURNS trigger AS $$
DECLARE
  old_revision_id TEXT;
  old_user_id TEXT;
  new_revision_id TEXT;
  new_user_id TEXT;
BEGIN
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;

    RETURN NEW;
  END IF;

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

COMMIT;
