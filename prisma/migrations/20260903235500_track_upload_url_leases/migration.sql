ALTER TABLE "source_files"
ADD COLUMN "presignedUploadExpiresAt" TIMESTAMP(3);

-- Prisma does not wrap PostgreSQL migrations in a transaction. Keep this
-- concurrent index outside an explicit BEGIN block so existing uploads remain writable.
CREATE INDEX CONCURRENTLY "source_files_userId_presignedUploadExpiresAt_idx"
ON "source_files"("userId", "presignedUploadExpiresAt");
