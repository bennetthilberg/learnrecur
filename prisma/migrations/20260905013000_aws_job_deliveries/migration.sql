CREATE TYPE "BackgroundJobDeliveryStatus" AS ENUM ('RUNNING', 'RETRYABLE', 'COMPLETED', 'DEAD_LETTER');

CREATE TABLE "background_job_deliveries" (
    "environment" TEXT NOT NULL,
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "status" "BackgroundJobDeliveryStatus" NOT NULL DEFAULT 'RUNNING',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "leaseToken" TEXT NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "errorCode" TEXT,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "background_job_deliveries_pkey" PRIMARY KEY ("environment", "id"),
    CONSTRAINT "background_job_deliveries_environment_check" CHECK ("environment" IN ('local', 'staging', 'production')),
    CONSTRAINT "background_job_deliveries_attempts_check" CHECK ("attempts" > 0)
);

CREATE INDEX "background_job_deliveries_expiresAt_idx" ON "background_job_deliveries"("expiresAt");
CREATE INDEX "background_job_deliveries_environment_status_updatedAt_idx" ON "background_job_deliveries"("environment", "status", "updatedAt");
