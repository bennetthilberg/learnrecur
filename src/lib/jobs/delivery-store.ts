import "server-only";
import { randomUUID } from "node:crypto";

import type { PrismaClient } from "@/generated/prisma/client";
import { getJobDefinition, getJobPayloadHash, type JobEnvelope } from "./contracts";
import type { JobClaim, JobFailureCode } from "./worker";

const RETENTION_MS = 30 * 86400_000;

export function createJobDeliveryStore(input: { prisma: PrismaClient; now: () => Date; leaseSeconds: number }) {
  const { prisma } = input;

  function ownedLease(job: JobEnvelope, token: string) {
    return { environment: job.environment, id: job.id, payloadHash: getJobPayloadHash(job), leaseToken: token, status: "RUNNING" as const };
  }

  return {
    async claim(job: JobEnvelope): Promise<JobClaim> {
      const now = input.now();
      const token = randomUUID();
      const payloadHash = getJobPayloadHash(job);
      const maxAttempts = getJobDefinition(job.name).maxAttempts;
      const leaseUntil = new Date(now.getTime() + input.leaseSeconds * 1000);
      const expiresAt = new Date(now.getTime() + RETENTION_MS);
      // A conditional upsert locks only this delivery. Concurrent first deliveries
      // and retries cannot both claim; no read-then-write race or process lock.
      const claimed = await prisma.$queryRaw<{ attempts: number }[]>`
        INSERT INTO background_job_deliveries
          (environment, id, name, "payloadHash", status, attempts, "leaseToken", "leaseUntil", "expiresAt", "createdAt", "updatedAt")
        VALUES (${job.environment}, ${job.id}, ${job.name}, ${payloadHash}, 'RUNNING', 1, ${token}, ${leaseUntil}, ${expiresAt}, ${now}, ${now})
        ON CONFLICT (environment, id) DO UPDATE SET
          status = 'RUNNING', attempts = background_job_deliveries.attempts + 1,
          "leaseToken" = EXCLUDED."leaseToken", "leaseUntil" = EXCLUDED."leaseUntil",
          "expiresAt" = EXCLUDED."expiresAt", "updatedAt" = EXCLUDED."updatedAt", "errorCode" = NULL
        WHERE background_job_deliveries."payloadHash" = ${payloadHash}
          AND background_job_deliveries.status IN ('RUNNING', 'RETRYABLE')
          AND background_job_deliveries."leaseUntil" <= ${now}
          AND background_job_deliveries.attempts < ${maxAttempts}
        RETURNING attempts
      `;
      if (claimed.length) return { status: "claimed", attempt: claimed[0].attempts, token };

      const existing = await prisma.backgroundJobDelivery.findUniqueOrThrow({
        where: { environment_id: { environment: job.environment, id: job.id } },
      });
      if (existing.payloadHash !== payloadHash) return { status: "dead-letter", reason: "JOB_ID_CONFLICT" };
      if (existing.status === "COMPLETED") return { status: "complete" };
      if (existing.status === "DEAD_LETTER") {
        return { status: "dead-letter", reason: existing.errorCode === "JOB_NON_RETRYABLE" ? "JOB_NON_RETRYABLE" : "JOB_RETRIES_EXHAUSTED" };
      }
      const busy = (leaseUntil: Date): JobClaim => ({
        status: "busy", retryAfterSeconds: Math.min(900, Math.max(1, Math.ceil((leaseUntil.getTime() - now.getTime()) / 1000) + 1)),
      });
      if (existing.leaseUntil > now) return busy(existing.leaseUntil);
      if (existing.attempts >= maxAttempts) {
        const result = await prisma.backgroundJobDelivery.updateMany({
          where: { ...ownedLease(job, existing.leaseToken), status: { in: ["RUNNING", "RETRYABLE"] }, leaseUntil: { lte: now } },
          data: { status: "DEAD_LETTER", errorCode: "JOB_RETRIES_EXHAUSTED", updatedAt: now },
        });
        return result.count ? { status: "dead-letter", reason: "JOB_RETRIES_EXHAUSTED" } : busy(leaseUntil);
      }
      return busy(leaseUntil);
    },

    async complete(job: JobEnvelope, token: string) {
      const now = input.now();
      const result = await prisma.backgroundJobDelivery.updateMany({
        where: ownedLease(job, token),
        data: { status: "COMPLETED", completedAt: now, leaseUntil: new Date(0), updatedAt: now },
      });
      if (result.count !== 1) throw new Error("JOB_LEASE_LOST");
    },

    async fail(job: JobEnvelope, token: string, reason: JobFailureCode, terminal: boolean) {
      const result = await prisma.backgroundJobDelivery.updateMany({
        where: ownedLease(job, token),
        data: { status: terminal ? "DEAD_LETTER" : "RETRYABLE", errorCode: reason, leaseUntil: new Date(0), updatedAt: input.now() },
      });
      if (result.count !== 1) throw new Error("JOB_LEASE_LOST");
    },

    async purgeExpired() {
      const now = input.now();
      return prisma.backgroundJobDelivery.deleteMany({ where: { expiresAt: { lt: now }, leaseUntil: { lte: now } } });
    },
  };
}
