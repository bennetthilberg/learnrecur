-- Cache one versioned semantic-similarity embedding per skill. The vector
-- extension is already required by persistent material chunks.
ALTER TABLE "skills"
ADD COLUMN "similarityEmbedding" vector(768),
ADD COLUMN "similarityEmbeddingModel" TEXT,
ADD COLUMN "similarityEmbeddingFingerprint" TEXT;
