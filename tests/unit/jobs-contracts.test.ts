import { describe, expect, it } from "vitest";

import {
  JOB_DEFINITIONS,
  buildJobEnvelope,
  getJobMessageGroupId,
  parseJobEnvelope,
  retryDelaySeconds,
} from "@/lib/jobs/contracts";

const refill = {
  userId: "learner-a",
  skillId: "skill-a",
  generationJobId: "generation-a",
  targetReadyCount: 5,
  requestedAt: "2026-09-04T21:00:00.000Z",
};

describe("AWS background job contracts", () => {
  it("accounts for every existing job and preserves the three cron cadences", () => {
    expect(JOB_DEFINITIONS.map((job) => job.id)).toEqual([
      "choice-exercise-refill", "exact-input-exercise-refill", "math-exercise-refill",
      "source-upload-draft", "material-ingestion", "material-cleanup",
      "material-draft-item", "material-batch-activation", "agent-skill-operation",
      "agent-connection-revocation", "account-deletion", "account-deletion-recovery",
      "agent-access-maintenance", "due-practice-reminders",
    ]);
    expect(JOB_DEFINITIONS.filter((job) => job.schedule).map((job) => [job.id, job.schedule]))
      .toEqual([
        ["account-deletion-recovery", "rate(15 minutes)"],
        ["agent-access-maintenance", "rate(5 minutes)"],
        ["due-practice-reminders", "cron(0 * * * ? *)"],
      ]);
  });

  it("validates and round-trips an envelope without carrying study material", () => {
    const job = buildJobEnvelope("learnrecur/choice-refill.requested", refill, "staging");
    expect(parseJobEnvelope(JSON.stringify(job), "staging")).toEqual(job);
    expect(job).toMatchObject({ version: 1, environment: "staging", data: refill });
    expect(job.id).toMatch(/^[a-f0-9-]{36}$/);
  });

  it.each([
    ["different environment", (job: Record<string, unknown>) => ({ ...job, environment: "production" })],
    ["unsupported version", (job: Record<string, unknown>) => ({ ...job, version: 2 })],
    ["unknown event", (job: Record<string, unknown>) => ({ ...job, name: "learnrecur/unknown" })],
    ["unexpected source text", (job: Record<string, unknown>) => ({ ...job, data: { ...refill, sourceText: "private" } })],
    ["invalid count", (job: Record<string, unknown>) => ({ ...job, data: { ...refill, targetReadyCount: 51 } })],
    ["missing owner", (job: Record<string, unknown>) => ({ ...job, data: { ...refill, userId: "" } })],
    ["extra envelope field", (job: Record<string, unknown>) => ({ ...job, arbitrary: true })],
  ])("rejects %s", (_label, mutate) => {
    const job = buildJobEnvelope("learnrecur/choice-refill.requested", refill, "staging");
    expect(() => parseJobEnvelope(JSON.stringify(mutate(job)), "staging")).toThrow();
  });

  it.each(["not json", "null", "[]", " ".repeat(65_537)])("rejects malformed or oversized input", (body) => {
    expect(() => parseJobEnvelope(body, "staging")).toThrow();
  });

  it("serializes every refill type for the same skill across independent deliveries", () => {
    const groups = ["choice", "exact-input", "math"].map((kind) => getJobMessageGroupId(
      buildJobEnvelope(`learnrecur/${kind}-refill.requested`, refill, "staging"),
    ));
    expect(new Set(groups).size).toBe(1);
    const other = buildJobEnvelope("learnrecur/choice-refill.requested", { ...refill, skillId: "skill-b" }, "staging");
    expect(getJobMessageGroupId(other)).not.toBe(groups[0]);
    expect(groups[0]).not.toContain("skill-a");
  });

  it("preserves function-scoped user serialization without serializing unrelated users", () => {
    const make = (userId: string, name = "learnrecur/material-ingestion.requested") =>
      buildJobEnvelope(name, { userId, materialRevisionId: "revision-a", requestedAt: refill.requestedAt }, "staging");
    expect(getJobMessageGroupId(make("a"))).toBe(getJobMessageGroupId(make("a")));
    expect(getJobMessageGroupId(make("a"))).not.toBe(getJobMessageGroupId(make("b")));
  });

  it("assigns draft jobs to at most two stable FIFO lanes per user", () => {
    const groups = Array.from({ length: 100 }, (_, index) => getJobMessageGroupId(buildJobEnvelope(
      "learnrecur/material-draft-item.requested",
      { userId: "a", batchId: "batch-a", itemId: `item-${index}`, requestedAt: refill.requestedAt },
      "staging",
    )));
    expect(new Set(groups).size).toBe(2);
  });

  it("bounds automatic attempts and exponential retry delays", () => {
    expect(JOB_DEFINITIONS.filter((job) => job.id.endsWith("exercise-refill")).map((job) => job.maxAttempts))
      .toEqual([3, 3, 3]);
    expect([1, 2, 3, 20].map(retryDelaySeconds)).toEqual([30, 60, 120, 900]);
  });

  it("accepts stable Scheduler occurrence IDs so retries deduplicate after five minutes", () => {
    const envelope = {
      version: 1, environment: "staging", name: "learnrecur/agent-access.maintenance",
      id: "agent-access-maintenance-2026-09-05T02:00:00Z",
      data: { requestedAt: "2026-09-05T02:00:00Z" },
    };
    expect(parseJobEnvelope(JSON.stringify(envelope), "staging")).toEqual(envelope);
  });
});
