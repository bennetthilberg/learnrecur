-- Persistent material chunks use pgvector for exact cosine retrieval. Keep the
-- extension in the migration so new environments cannot drift from the schema.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "StudyMaterialKind" AS ENUM ('PDF', 'WEB');

-- CreateEnum
CREATE TYPE "StudyMaterialStatus" AS ENUM ('ACTIVE', 'ARCHIVED', 'DELETING');

-- CreateEnum
CREATE TYPE "MaterialRevisionStatus" AS ENUM ('PENDING_UPLOAD', 'QUEUED', 'PROCESSING', 'READY', 'FAILED', 'DELETING');

-- CreateEnum
CREATE TYPE "MaterialCleanupStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "SkillDraftBatchStatus" AS ENUM ('PLANNING', 'NEEDS_SCOPE', 'PLANNED', 'GENERATING', 'READY', 'PARTIAL', 'FAILED', 'ACTIVATING', 'COMPLETE');

-- CreateEnum
CREATE TYPE "SkillDraftBatchItemStatus" AS ENUM ('PLANNED', 'GENERATING', 'READY', 'FAILED', 'EXCLUDED', 'ACTIVATING', 'ACTIVE');

-- AlterTable
ALTER TABLE "source_files" ADD COLUMN     "materialRevisionId" TEXT;

-- CreateTable
CREATE TABLE "study_materials" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "collectionId" TEXT,
    "title" TEXT NOT NULL,
    "kind" "StudyMaterialKind" NOT NULL,
    "status" "StudyMaterialStatus" NOT NULL DEFAULT 'ACTIVE',
    "activeRevisionId" TEXT,
    "deletionRequestedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "study_materials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_revisions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "status" "MaterialRevisionStatus" NOT NULL DEFAULT 'PENDING_UPLOAD',
    "sourceUrl" TEXT,
    "contentHash" TEXT,
    "byteSize" INTEGER,
    "pageCount" INTEGER,
    "fetchedPageCount" INTEGER,
    "storageBucket" TEXT,
    "storageKey" TEXT,
    "processingMetadata" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "finalizedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_sections" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "materialRevisionId" TEXT NOT NULL,
    "parentId" TEXT,
    "ordinal" INTEGER NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "normalizedTitle" TEXT NOT NULL,
    "pageStart" INTEGER,
    "pageEnd" INTEGER,
    "url" TEXT,
    "anchor" TEXT,
    "headingPath" TEXT[],
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_sections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_chunks" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "materialRevisionId" TEXT NOT NULL,
    "materialSectionId" TEXT,
    "sourceFileId" TEXT,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "tokenEstimate" INTEGER NOT NULL,
    "contentHash" TEXT NOT NULL,
    "locator" JSONB NOT NULL,
    "headingText" TEXT,
    "searchText" tsvector GENERATED ALWAYS AS (
      to_tsvector('simple', coalesce("headingText", '') || ' ' || "text")
    ) STORED,
    "embedding" vector(768),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "material_chunks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "material_cleanup_jobs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "materialId" TEXT NOT NULL,
    "status" "MaterialCleanupStatus" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "material_cleanup_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_draft_batches" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "materialRevisionId" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "confirmedPlan" JSONB,
    "status" "SkillDraftBatchStatus" NOT NULL DEFAULT 'PLANNING',
    "idempotencyKey" TEXT NOT NULL,
    "requestedCount" INTEGER NOT NULL DEFAULT 0,
    "readyCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "excludedCount" INTEGER NOT NULL DEFAULT 0,
    "activatedCount" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "skill_draft_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "skill_draft_batch_items" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "skillId" TEXT,
    "ordinal" INTEGER NOT NULL,
    "targetKey" TEXT NOT NULL,
    "proposedTitle" TEXT NOT NULL,
    "proposedObjective" TEXT NOT NULL,
    "locator" JSONB NOT NULL,
    "status" "SkillDraftBatchItemStatus" NOT NULL DEFAULT 'PLANNED',
    "overlapSkillId" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "generationAttempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "skill_draft_batch_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "study_materials_activeRevisionId_key" ON "study_materials"("activeRevisionId");

-- CreateIndex
CREATE INDEX "study_materials_userId_status_updatedAt_idx" ON "study_materials"("userId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "study_materials_collectionId_idx" ON "study_materials"("collectionId");

-- CreateIndex
CREATE UNIQUE INDEX "study_materials_id_userId_key" ON "study_materials"("id", "userId");

-- CreateIndex
CREATE INDEX "material_revisions_userId_status_idx" ON "material_revisions"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "material_revisions_id_userId_key" ON "material_revisions"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "material_revisions_materialId_revisionNumber_key" ON "material_revisions"("materialId", "revisionNumber");

-- CreateIndex
CREATE INDEX "material_sections_materialRevisionId_parentId_ordinal_idx" ON "material_sections"("materialRevisionId", "parentId", "ordinal");

-- CreateIndex
CREATE INDEX "material_sections_userId_idx" ON "material_sections"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "material_sections_id_userId_key" ON "material_sections"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "material_sections_materialRevisionId_ordinal_key" ON "material_sections"("materialRevisionId", "ordinal");

-- CreateIndex
CREATE INDEX "material_chunks_materialRevisionId_materialSectionId_ordina_idx" ON "material_chunks"("materialRevisionId", "materialSectionId", "ordinal");

-- CreateIndex
CREATE INDEX "material_chunks_userId_idx" ON "material_chunks"("userId");

-- Language-neutral lexical retrieval complements vector similarity. Vector
-- search remains exact and revision-filtered until measured scale justifies an
-- approximate index.
CREATE INDEX "material_chunks_searchText_idx" ON "material_chunks" USING GIN ("searchText");

-- CreateIndex
CREATE UNIQUE INDEX "material_chunks_id_userId_key" ON "material_chunks"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "material_chunks_materialRevisionId_ordinal_key" ON "material_chunks"("materialRevisionId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "material_cleanup_jobs_materialId_key" ON "material_cleanup_jobs"("materialId");

-- CreateIndex
CREATE INDEX "material_cleanup_jobs_userId_status_idx" ON "material_cleanup_jobs"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "material_cleanup_jobs_materialId_userId_key" ON "material_cleanup_jobs"("materialId", "userId");

-- CreateIndex
CREATE INDEX "skill_draft_batches_userId_status_createdAt_idx" ON "skill_draft_batches"("userId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "skill_draft_batches_materialRevisionId_idx" ON "skill_draft_batches"("materialRevisionId");

-- CreateIndex
CREATE UNIQUE INDEX "skill_draft_batches_id_userId_key" ON "skill_draft_batches"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "skill_draft_batches_userId_idempotencyKey_key" ON "skill_draft_batches"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "skill_draft_batch_items_userId_status_idx" ON "skill_draft_batch_items"("userId", "status");

-- CreateIndex
CREATE INDEX "skill_draft_batch_items_skillId_idx" ON "skill_draft_batch_items"("skillId");

-- CreateIndex
CREATE UNIQUE INDEX "skill_draft_batch_items_id_userId_key" ON "skill_draft_batch_items"("id", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "skill_draft_batch_items_batchId_ordinal_key" ON "skill_draft_batch_items"("batchId", "ordinal");

-- CreateIndex
CREATE UNIQUE INDEX "skill_draft_batch_items_batchId_targetKey_key" ON "skill_draft_batch_items"("batchId", "targetKey");

-- CreateIndex
CREATE INDEX "source_files_materialRevisionId_idx" ON "source_files"("materialRevisionId");

-- AddForeignKey
ALTER TABLE "source_files" ADD CONSTRAINT "source_files_materialRevisionId_userId_fkey" FOREIGN KEY ("materialRevisionId", "userId") REFERENCES "material_revisions"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_materials" ADD CONSTRAINT "study_materials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_materials" ADD CONSTRAINT "study_materials_collectionId_userId_fkey" FOREIGN KEY ("collectionId", "userId") REFERENCES "collections"("id", "userId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "study_materials" ADD CONSTRAINT "study_materials_activeRevisionId_fkey" FOREIGN KEY ("activeRevisionId") REFERENCES "material_revisions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_revisions" ADD CONSTRAINT "material_revisions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_revisions" ADD CONSTRAINT "material_revisions_materialId_userId_fkey" FOREIGN KEY ("materialId", "userId") REFERENCES "study_materials"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_sections" ADD CONSTRAINT "material_sections_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_sections" ADD CONSTRAINT "material_sections_materialRevisionId_userId_fkey" FOREIGN KEY ("materialRevisionId", "userId") REFERENCES "material_revisions"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_chunks" ADD CONSTRAINT "material_chunks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_chunks" ADD CONSTRAINT "material_chunks_materialRevisionId_userId_fkey" FOREIGN KEY ("materialRevisionId", "userId") REFERENCES "material_revisions"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_chunks" ADD CONSTRAINT "material_chunks_materialSectionId_userId_fkey" FOREIGN KEY ("materialSectionId", "userId") REFERENCES "material_sections"("id", "userId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_chunks" ADD CONSTRAINT "material_chunks_sourceFileId_userId_fkey" FOREIGN KEY ("sourceFileId", "userId") REFERENCES "source_files"("id", "userId") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_cleanup_jobs" ADD CONSTRAINT "material_cleanup_jobs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "material_cleanup_jobs" ADD CONSTRAINT "material_cleanup_jobs_materialId_userId_fkey" FOREIGN KEY ("materialId", "userId") REFERENCES "study_materials"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_draft_batches" ADD CONSTRAINT "skill_draft_batches_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_draft_batches" ADD CONSTRAINT "skill_draft_batches_materialRevisionId_userId_fkey" FOREIGN KEY ("materialRevisionId", "userId") REFERENCES "material_revisions"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_draft_batch_items" ADD CONSTRAINT "skill_draft_batch_items_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_draft_batch_items" ADD CONSTRAINT "skill_draft_batch_items_batchId_userId_fkey" FOREIGN KEY ("batchId", "userId") REFERENCES "skill_draft_batches"("id", "userId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "skill_draft_batch_items" ADD CONSTRAINT "skill_draft_batch_items_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "skills"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Domain invariants that should hold even when a job is retried or two workers
-- race. Prisma and Zod mirror these checks for earlier feedback.
ALTER TABLE "material_revisions"
  ADD CONSTRAINT "material_revisions_revisionNumber_check" CHECK ("revisionNumber" > 0),
  ADD CONSTRAINT "material_revisions_byteSize_check" CHECK ("byteSize" IS NULL OR "byteSize" >= 0),
  ADD CONSTRAINT "material_revisions_pageCount_check" CHECK ("pageCount" IS NULL OR "pageCount" > 0),
  ADD CONSTRAINT "material_revisions_fetchedPageCount_check" CHECK ("fetchedPageCount" IS NULL OR "fetchedPageCount" > 0);

ALTER TABLE "material_sections"
  ADD CONSTRAINT "material_sections_ordinal_check" CHECK ("ordinal" >= 0),
  ADD CONSTRAINT "material_sections_level_check" CHECK ("level" > 0),
  ADD CONSTRAINT "material_sections_page_range_check" CHECK (
    ("pageStart" IS NULL AND "pageEnd" IS NULL)
    OR ("pageStart" > 0 AND "pageEnd" >= "pageStart")
  );

ALTER TABLE "material_chunks"
  ADD CONSTRAINT "material_chunks_ordinal_check" CHECK ("ordinal" >= 0),
  ADD CONSTRAINT "material_chunks_tokenEstimate_check" CHECK ("tokenEstimate" > 0);

ALTER TABLE "skill_draft_batches"
  ADD CONSTRAINT "skill_draft_batches_requestedCount_check" CHECK ("requestedCount" BETWEEN 0 AND 10),
  ADD CONSTRAINT "skill_draft_batches_counts_check" CHECK (
    "readyCount" >= 0 AND "failedCount" >= 0 AND "excludedCount" >= 0 AND "activatedCount" >= 0
  );

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

CREATE TRIGGER "material_revisions_prevent_finalized_identity_update"
BEFORE UPDATE ON "material_revisions"
FOR EACH ROW
EXECUTE FUNCTION prevent_finalized_material_revision_identity_update();
