DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "generation_jobs"
    WHERE "status" IN ('PENDING', 'RUNNING')
    GROUP BY "userId", "skillId", "kind"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot add active generation job uniqueness: duplicate pending/running generation jobs exist for the same user, skill, and kind.';
  END IF;
END $$;

CREATE UNIQUE INDEX "generation_jobs_active_refill_unique"
ON "generation_jobs" ("userId", "skillId", "kind")
WHERE "status" IN ('PENDING', 'RUNNING');
