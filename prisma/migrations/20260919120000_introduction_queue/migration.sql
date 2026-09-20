CREATE TABLE "introduction_queues" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "collectionId" TEXT,
  "scopeKey" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "introduction_queues_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "introduction_queues_id_userId_key"
  ON "introduction_queues"("id", "userId");
CREATE UNIQUE INDEX "introduction_queues_userId_scopeKey_key"
  ON "introduction_queues"("userId", "scopeKey");
CREATE INDEX "introduction_queues_userId_updatedAt_idx"
  ON "introduction_queues"("userId", "updatedAt");

CREATE TABLE "introduction_queue_entries" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "queueId" TEXT NOT NULL,
  "skillId" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "introduction_queue_entries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "introduction_queue_entries_id_userId_key"
  ON "introduction_queue_entries"("id", "userId");
CREATE UNIQUE INDEX "introduction_queue_entries_queueId_skillId_key"
  ON "introduction_queue_entries"("queueId", "skillId");
CREATE UNIQUE INDEX "introduction_queue_entries_queueId_position_key"
  ON "introduction_queue_entries"("queueId", "position");
CREATE INDEX "introduction_queue_entries_userId_skillId_idx"
  ON "introduction_queue_entries"("userId", "skillId");

CREATE TABLE "introduction_queue_updates" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "queueId" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "payloadHash" TEXT NOT NULL,
  "result" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "introduction_queue_updates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "introduction_queue_updates_id_userId_key"
  ON "introduction_queue_updates"("id", "userId");
CREATE UNIQUE INDEX "introduction_queue_updates_connectionId_idempotencyKey_key"
  ON "introduction_queue_updates"("connectionId", "idempotencyKey");
CREATE INDEX "introduction_queue_updates_queueId_createdAt_idx"
  ON "introduction_queue_updates"("queueId", "createdAt");

ALTER TABLE "introduction_queues"
  ADD CONSTRAINT "introduction_queues_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "introduction_queues_collectionId_userId_fkey"
    FOREIGN KEY ("collectionId", "userId") REFERENCES "collections"("id", "userId")
    ON DELETE NO ACTION ON UPDATE CASCADE;

ALTER TABLE "introduction_queue_entries"
  ADD CONSTRAINT "introduction_queue_entries_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "introduction_queue_entries_queueId_userId_fkey"
    FOREIGN KEY ("queueId", "userId") REFERENCES "introduction_queues"("id", "userId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "introduction_queue_entries_skillId_userId_fkey"
    FOREIGN KEY ("skillId", "userId") REFERENCES "skills"("id", "userId")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "introduction_queue_updates"
  ADD CONSTRAINT "introduction_queue_updates_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "introduction_queue_updates_connectionId_userId_fkey"
    FOREIGN KEY ("connectionId", "userId") REFERENCES "agent_connections"("id", "userId")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "introduction_queue_updates_queueId_userId_fkey"
    FOREIGN KEY ("queueId", "userId") REFERENCES "introduction_queues"("id", "userId")
    ON DELETE CASCADE ON UPDATE CASCADE;
