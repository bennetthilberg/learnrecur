ALTER TABLE "source_files"
ADD COLUMN "presignedUploadExpiresAt" TIMESTAMP(3);

CREATE INDEX "source_files_userId_presignedUploadExpiresAt_idx"
ON "source_files"("userId", "presignedUploadExpiresAt");
