ALTER TABLE "agent_revocation_outbox" DROP CONSTRAINT "agent_revocation_outbox_connectionId_userId_fkey";
ALTER TABLE "agent_revocation_outbox" DROP CONSTRAINT "agent_revocation_outbox_userId_fkey";

ALTER TABLE "agent_revocation_outbox" ADD COLUMN "workosUserId" TEXT;
ALTER TABLE "agent_revocation_outbox" ADD COLUMN "applicationId" TEXT;

UPDATE "agent_revocation_outbox" AS outbox
SET
  "workosUserId" = identity."workosUserId",
  "applicationId" = connection."workosApplicationId"
FROM "agent_connections" AS connection
JOIN "workos_identities" AS identity ON identity."id" = connection."workosIdentityId"
WHERE outbox."connectionId" = connection."id" AND outbox."userId" = connection."userId";

ALTER TABLE "agent_revocation_outbox" ALTER COLUMN "workosUserId" SET NOT NULL;
ALTER TABLE "agent_revocation_outbox" ALTER COLUMN "applicationId" SET NOT NULL;

DROP INDEX "agent_revocation_outbox_connectionId_userId_key";
CREATE UNIQUE INDEX "agent_revocation_outbox_connectionId_key" ON "agent_revocation_outbox"("connectionId");
