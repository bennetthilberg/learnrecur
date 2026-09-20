ALTER TABLE "introduction_queues"
  DROP CONSTRAINT "introduction_queues_collectionId_userId_fkey";

ALTER TABLE "introduction_queues"
  ADD CONSTRAINT "introduction_queues_collectionId_userId_fkey"
    FOREIGN KEY ("collectionId", "userId") REFERENCES "collections"("id", "userId")
    ON DELETE CASCADE ON UPDATE CASCADE;
