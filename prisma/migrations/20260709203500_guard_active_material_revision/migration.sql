-- The Prisma relation guarantees that the revision exists. This trigger adds
-- the domain rule that an active revision must belong to the same logical
-- material and user; a revision from another material must never be selected.
CREATE OR REPLACE FUNCTION enforce_active_material_revision_ownership()
RETURNS trigger AS $$
BEGIN
  IF NEW."activeRevisionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM "material_revisions" revision
    WHERE revision."id" = NEW."activeRevisionId"
      AND revision."materialId" = NEW."id"
      AND revision."userId" = NEW."userId"
  ) THEN
    RAISE EXCEPTION 'Active material revision must belong to the same material and user'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "study_materials_enforce_active_revision_ownership"
BEFORE INSERT OR UPDATE OF "activeRevisionId", "userId" ON "study_materials"
FOR EACH ROW
EXECUTE FUNCTION enforce_active_material_revision_ownership();
