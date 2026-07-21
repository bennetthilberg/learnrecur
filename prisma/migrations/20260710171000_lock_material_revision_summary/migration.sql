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
    OR (OLD."summary" IS NOT NULL AND NEW."summary" IS DISTINCT FROM OLD."summary")
    OR NEW."storageBucket" IS DISTINCT FROM OLD."storageBucket"
    OR NEW."storageKey" IS DISTINCT FROM OLD."storageKey"
  ) THEN
    RAISE EXCEPTION 'Finalized material revision identity is immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
