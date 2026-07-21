BEGIN;

-- A finalized snapshot cannot be made mutable again by clearing finalizedAt.
CREATE OR REPLACE FUNCTION prevent_finalized_material_revision_identity_update()
RETURNS trigger AS $$
BEGIN
  IF OLD."finalizedAt" IS NOT NULL AND (
    NEW."finalizedAt" IS DISTINCT FROM OLD."finalizedAt"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."materialId" IS DISTINCT FROM OLD."materialId"
    OR NEW."revisionNumber" IS DISTINCT FROM OLD."revisionNumber"
    OR NEW."sourceUrl" IS DISTINCT FROM OLD."sourceUrl"
    OR NEW."contentHash" IS DISTINCT FROM OLD."contentHash"
    OR NEW."byteSize" IS DISTINCT FROM OLD."byteSize"
    OR NEW."pageCount" IS DISTINCT FROM OLD."pageCount"
    OR NEW."fetchedPageCount" IS DISTINCT FROM OLD."fetchedPageCount"
    OR NEW."storageBucket" IS DISTINCT FROM OLD."storageBucket"
    OR NEW."storageKey" IS DISTINCT FROM OLD."storageKey"
  ) THEN
    RAISE EXCEPTION 'Finalized material revision identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Lock the selected revision while validating an active-revision assignment.
-- This serializes the check with reverse ownership changes on the revision.
CREATE OR REPLACE FUNCTION enforce_active_material_revision_ownership()
RETURNS trigger AS $$
BEGIN
  IF NEW."activeRevisionId" IS NOT NULL THEN
    PERFORM 1
    FROM "material_revisions" revision
    WHERE revision."id" = NEW."activeRevisionId"
    FOR UPDATE;

    IF NOT EXISTS (
      SELECT 1
      FROM "material_revisions" revision
      WHERE revision."id" = NEW."activeRevisionId"
        AND revision."materialId" = NEW."id"
        AND revision."userId" = NEW."userId"
    ) THEN
      RAISE EXCEPTION 'Active material revision must belong to the same material and user'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_active_material_revision_ownership_change()
RETURNS trigger AS $$
DECLARE
  active_material RECORD;
BEGIN
  IF (NEW."materialId", NEW."userId") IS DISTINCT FROM (OLD."materialId", OLD."userId") THEN
    SELECT material."id", material."userId"
    INTO active_material
    FROM "study_materials" material
    WHERE material."activeRevisionId" = OLD."id"
    FOR UPDATE;

    IF FOUND AND (
      NEW."materialId" IS DISTINCT FROM active_material."id"
      OR NEW."userId" IS DISTINCT FROM active_material."userId"
    ) THEN
      RAISE EXCEPTION 'Active material revision ownership cannot change'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "material_revisions_prevent_active_ownership_change" ON "material_revisions";
CREATE TRIGGER "material_revisions_prevent_active_ownership_change"
BEFORE UPDATE OF "materialId", "userId" ON "material_revisions"
FOR EACH ROW
EXECUTE FUNCTION prevent_active_material_revision_ownership_change();

-- Draft-item writes lock their selected skill, so a concurrent owner change
-- cannot pass between the ownership check and the insert/update.
CREATE OR REPLACE FUNCTION enforce_skill_draft_item_skill_ownership()
RETURNS trigger AS $$
BEGIN
  IF NEW."skillId" IS NOT NULL THEN
    PERFORM 1
    FROM "skills" skill
    WHERE skill."id" = NEW."skillId"
    FOR NO KEY UPDATE;

    IF NOT EXISTS (
      SELECT 1
      FROM "skills" skill
      WHERE skill."id" = NEW."skillId"
        AND skill."userId" = NEW."userId"
    ) THEN
      RAISE EXCEPTION 'Draft batch item skill must belong to the same user'
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_referenced_skill_ownership_change()
RETURNS trigger AS $$
BEGIN
  IF NEW."userId" IS DISTINCT FROM OLD."userId" AND EXISTS (
    SELECT 1
    FROM "skill_draft_batch_items" item
    WHERE item."skillId" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'Referenced skill ownership cannot change'
      USING ERRCODE = '23503';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "skills_prevent_referenced_ownership_change" ON "skills";
CREATE TRIGGER "skills_prevent_referenced_ownership_change"
BEFORE UPDATE OF "userId" ON "skills"
FOR EACH ROW
EXECUTE FUNCTION prevent_referenced_skill_ownership_change();

COMMIT;
