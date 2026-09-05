import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";

import { buildJobEnvelope } from "@/lib/jobs/contracts";
import { createJobDeliveryStore } from "@/lib/jobs/delivery-store";
import { getPrisma } from "@/lib/prisma";

const describeDatabase = process.env.RUN_DATABASE_TESTS === "1" ? describe : describe.skip;

describeDatabase("durable AWS job delivery claims", () => {
  const prisma = getPrisma();
  const ids: string[] = [];
  let now = new Date("2026-09-04T21:00:00.000Z");
  const store = createJobDeliveryStore({ prisma, now: () => now, leaseSeconds: 660 });
  const where = (id: string) => ({ environment_id: { environment: "staging", id } });
  const job = () => {
    const envelope = buildJobEnvelope("learnrecur/choice-refill.requested", {
      userId: `delivery-test-${randomUUID()}`, skillId: "skill-a", generationJobId: "generation-a",
      targetReadyCount: 5, requestedAt: now.toISOString(),
    }, "staging");
    ids.push(envelope.id);
    return envelope;
  };

  afterAll(async () => {
    await prisma.backgroundJobDelivery.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it("allows exactly one concurrent claim and stores no private payload", async () => {
    const envelope = job();
    const claims = await Promise.all(Array.from({ length: 8 }, () => store.claim(envelope)));
    expect(claims.filter((claim) => claim.status === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "busy")).toHaveLength(7);
    const row = await prisma.backgroundJobDelivery.findUniqueOrThrow({ where: where(envelope.id) });
    expect(row).toMatchObject({ status: "RUNNING", attempts: 1, name: envelope.name });
    expect(JSON.stringify(row)).not.toContain("delivery-test-");
    expect(row.expiresAt.getTime()).toBeGreaterThan(now.getTime() + 14 * 86400_000);
  });

  it("deduplicates completed delivery and rejects reuse with a different payload", async () => {
    const envelope = job();
    const claim = await store.claim(envelope);
    if (claim.status !== "claimed") throw new Error("expected claim");
    await store.complete(envelope, claim.token);
    expect(await store.claim(envelope)).toEqual({ status: "complete" });
    expect(await store.claim({ ...envelope, data: { ...envelope.data, requestedAt: "2026-09-05T21:00:00.000Z" } }))
      .toEqual({ status: "dead-letter", reason: "JOB_ID_CONFLICT" });
  });

  it("reclaims expired leases with a new token and fences late writes", async () => {
    const envelope = job();
    const first = await store.claim(envelope);
    if (first.status !== "claimed") throw new Error("expected claim");
    now = new Date(now.getTime() + 661_000);
    const second = await store.claim(envelope);
    expect(second).toMatchObject({ status: "claimed", attempt: 2 });
    if (second.status !== "claimed") throw new Error("expected claim");
    expect(second.token).not.toBe(first.token);
    await expect(store.complete(envelope, first.token)).rejects.toThrow("JOB_LEASE_LOST");
    await expect(store.fail(envelope, first.token, "JOB_EXECUTION_FAILED", false)).rejects.toThrow("JOB_LEASE_LOST");
    await store.complete(envelope, second.token);
  });

  it("counts retries durably and stops after the job-specific execution limit", async () => {
    const envelope = job();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const claim = await store.claim(envelope);
      expect(claim).toMatchObject({ status: "claimed", attempt });
      if (claim.status !== "claimed") throw new Error("expected claim");
      await store.fail(envelope, claim.token, "JOB_EXECUTION_FAILED", false);
    }
    expect(await store.claim(envelope)).toEqual({ status: "dead-letter", reason: "JOB_RETRIES_EXHAUSTED" });
  });

  it("retains a permanent disposition when dead-letter publication must be retried", async () => {
    const envelope = job();
    const claim = await store.claim(envelope);
    if (claim.status !== "claimed") throw new Error("expected claim");
    await store.fail(envelope, claim.token, "JOB_NON_RETRYABLE", true);
    expect(await store.claim(envelope)).toEqual({ status: "dead-letter", reason: "JOB_NON_RETRYABLE" });
  });

  it("isolates matching delivery IDs between environments", async () => {
    const envelope = job();
    expect(await store.claim(envelope)).toMatchObject({ status: "claimed", attempt: 1 });
    expect(await store.claim({ ...envelope, environment: "local" })).toMatchObject({ status: "claimed", attempt: 1 });
  });

  it("expires old terminal metadata while retaining active deliveries", async () => {
    const completed = job();
    const active = job();
    const claim = await store.claim(completed);
    if (claim.status !== "claimed") throw new Error("expected claim");
    await store.complete(completed, claim.token);
    await store.claim(active);
    await prisma.backgroundJobDelivery.updateMany({ where: { id: { in: [completed.id, active.id] } }, data: { expiresAt: new Date(0) } });
    await store.purgeExpired();
    expect(await prisma.backgroundJobDelivery.findUnique({ where: where(completed.id) })).toBeNull();
    expect(await prisma.backgroundJobDelivery.findUnique({ where: where(active.id) })).not.toBeNull();
  });
});
