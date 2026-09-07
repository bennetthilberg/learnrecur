CREATE TYPE "PracticePreference" AS ENUM ('BALANCED', 'RECALL_FIRST');
ALTER TABLE "users" ADD COLUMN "practicePreference" "PracticePreference" NOT NULL DEFAULT 'BALANCED', ADD COLUMN "mixedReview" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "collections" ADD COLUMN "practicePreference" "PracticePreference", ADD COLUMN "textPolicy" JSONB;
ALTER TABLE "skills" ADD COLUMN "practicePreference" "PracticePreference", ADD COLUMN "alreadyStudied" BOOLEAN NOT NULL DEFAULT false, ADD COLUMN "textPolicy" JSONB, ADD COLUMN "textPolicyRevision" INTEGER NOT NULL DEFAULT 0;
-- Existing ratings are recorded outcomes. The legacy label does not recalculate them.
ALTER TABLE "exercise_attempts" ADD COLUMN "ratingPolicyVersion" TEXT NOT NULL DEFAULT 'speed-v1', ADD COLUMN "practiceContext" JSONB, ADD COLUMN "answerPolicySnapshot" JSONB;
