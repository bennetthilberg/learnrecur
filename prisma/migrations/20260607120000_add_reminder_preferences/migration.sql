-- CreateEnum
CREATE TYPE "ReminderSendStatus" AS ENUM ('PENDING', 'SKIPPED', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "reminder_preferences" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "email" TEXT NOT NULL,
    "localHour" INTEGER NOT NULL DEFAULT 9,
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "minimumDueCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminder_preferences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reminder_preferences_localHour_range_check" CHECK ("localHour" >= 0 AND "localHour" <= 23),
    CONSTRAINT "reminder_preferences_minimumDueCount_positive_check" CHECK ("minimumDueCount" >= 1)
);

-- CreateTable
CREATE TABLE "reminder_send_logs" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "localDate" TEXT NOT NULL,
    "status" "ReminderSendStatus" NOT NULL,
    "dueCount" INTEGER NOT NULL,
    "email" TEXT,
    "provider" TEXT,
    "providerMessageId" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reminder_send_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "reminder_send_logs_dueCount_nonnegative_check" CHECK ("dueCount" >= 0)
);

-- CreateIndex
CREATE UNIQUE INDEX "reminder_preferences_userId_key" ON "reminder_preferences"("userId");

-- CreateIndex
CREATE INDEX "reminder_preferences_enabled_localHour_idx" ON "reminder_preferences"("enabled", "localHour");

-- CreateIndex
CREATE UNIQUE INDEX "reminder_send_logs_userId_localDate_key" ON "reminder_send_logs"("userId", "localDate");

-- CreateIndex
CREATE INDEX "reminder_send_logs_status_createdAt_idx" ON "reminder_send_logs"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "reminder_preferences" ADD CONSTRAINT "reminder_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_send_logs" ADD CONSTRAINT "reminder_send_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
