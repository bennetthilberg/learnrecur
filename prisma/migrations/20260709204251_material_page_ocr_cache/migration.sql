-- CreateEnum
CREATE TYPE "MaterialPageTextStatus" AS ENUM ('NEEDS_OCR', 'OCR_PROCESSING', 'OCR_READY', 'OCR_FAILED');

-- CreateTable
CREATE TABLE "material_pages" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "materialRevisionId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "embeddedText" TEXT,
    "ocrText" TEXT,
    "textStatus" "MaterialPageTextStatus" NOT NULL DEFAULT 'NEEDS_OCR',
    "contentHash" TEXT NOT NULL,
    "tokenEstimate" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_pages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "material_pages_userId_textStatus_idx" ON "material_pages"("userId", "textStatus");

-- CreateIndex
CREATE UNIQUE INDEX "material_pages_id_userId_key" ON "material_pages"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "material_pages_materialRevisionId_pageNumber_key" ON "material_pages"("materialRevisionId", "pageNumber");

-- AddForeignKey
ALTER TABLE "material_pages" ADD CONSTRAINT "material_pages_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_pages" ADD CONSTRAINT "material_pages_materialRevisionId_userId_fkey" FOREIGN KEY ("materialRevisionId", "userId") REFERENCES "material_revisions"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;
