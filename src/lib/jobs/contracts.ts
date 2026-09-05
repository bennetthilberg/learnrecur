import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

export const JOB_BODY_LIMIT_BYTES = 65_536;
export const JOB_ENVIRONMENTS = ["local", "staging", "production"] as const;
export type JobEnvironment = typeof JOB_ENVIRONMENTS[number];

const id = z.string().trim().min(1).max(200);
const requestedAt = z.string().datetime({ offset: true });
const refill = z.strictObject({
  userId: id, skillId: id, generationJobId: id,
  targetReadyCount: z.number().int().positive().max(50), requestedAt,
});
const scheduled = z.strictObject({ requestedAt });

export const JOB_PAYLOAD_SCHEMAS = {
  "learnrecur/choice-refill.requested": refill,
  "learnrecur/exact-input-refill.requested": refill,
  "learnrecur/math-refill.requested": refill,
  "learnrecur/source-upload-draft.requested": z.strictObject({ userId: id, sourceFileId: id, requestedAt }),
  "learnrecur/material-ingestion.requested": z.strictObject({ userId: id, materialRevisionId: id, requestedAt }),
  "learnrecur/material-cleanup.requested": z.strictObject({ userId: id, materialId: id, cleanupJobId: id, requestedAt }),
  "learnrecur/material-draft-item.requested": z.strictObject({ userId: id, batchId: id, itemId: id, requestedAt }),
  "learnrecur/material-batch-activation.requested": z.strictObject({ userId: id, batchId: id, itemId: id, generationJobId: id, requestedAt }),
  "learnrecur/agent-skill-operation.requested": z.strictObject({ userId: id, operationId: id, requestedAt }),
  "learnrecur/agent-connection-revocation.requested": z.strictObject({ userId: id, connectionId: id, requestedAt }),
  "learnrecur/account-deletion.requested": z.strictObject({ userId: id, deletionJobId: id, requestedAt }),
  "learnrecur/account-deletion.recovery": scheduled,
  "learnrecur/agent-access.maintenance": scheduled,
  "learnrecur/practice-reminders.due": scheduled,
} as const;

export type JobName = keyof typeof JOB_PAYLOAD_SCHEMAS;
export type JobData<N extends JobName> = z.infer<typeof JOB_PAYLOAD_SCHEMAS[N]>;
export type JobEnvelope = {
  [N in JobName]: {
    version: 1;
    id: string;
    environment: JobEnvironment;
    name: N;
    data: JobData<N>;
  }
}[JobName];

export type JobDefinition = {
  id: string;
  name: JobName;
  maxAttempts: number;
  concurrency: { scope: string; key: string; limit: 1 | 2 };
  schedule?: string;
};

export const JOB_DEFINITIONS: readonly JobDefinition[] = [
  { id: "choice-exercise-refill", name: "learnrecur/choice-refill.requested", maxAttempts: 3, concurrency: { scope: "refill", key: "skillId", limit: 1 } },
  { id: "exact-input-exercise-refill", name: "learnrecur/exact-input-refill.requested", maxAttempts: 3, concurrency: { scope: "refill", key: "skillId", limit: 1 } },
  { id: "math-exercise-refill", name: "learnrecur/math-refill.requested", maxAttempts: 3, concurrency: { scope: "refill", key: "skillId", limit: 1 } },
  { id: "source-upload-draft", name: "learnrecur/source-upload-draft.requested", maxAttempts: 5, concurrency: { scope: "source", key: "sourceFileId", limit: 1 } },
  { id: "material-ingestion", name: "learnrecur/material-ingestion.requested", maxAttempts: 4, concurrency: { scope: "material-ingestion", key: "userId", limit: 1 } },
  { id: "material-cleanup", name: "learnrecur/material-cleanup.requested", maxAttempts: 4, concurrency: { scope: "material-cleanup", key: "userId", limit: 1 } },
  { id: "material-draft-item", name: "learnrecur/material-draft-item.requested", maxAttempts: 4, concurrency: { scope: "material-draft-item", key: "userId", limit: 2 } },
  { id: "material-batch-activation", name: "learnrecur/material-batch-activation.requested", maxAttempts: 4, concurrency: { scope: "material-batch-activation", key: "userId", limit: 2 } },
  { id: "agent-skill-operation", name: "learnrecur/agent-skill-operation.requested", maxAttempts: 4, concurrency: { scope: "agent-skill-operation", key: "userId", limit: 1 } },
  { id: "agent-connection-revocation", name: "learnrecur/agent-connection-revocation.requested", maxAttempts: 4, concurrency: { scope: "agent-connection-revocation", key: "userId", limit: 1 } },
  { id: "account-deletion", name: "learnrecur/account-deletion.requested", maxAttempts: 4, concurrency: { scope: "account-deletion", key: "userId", limit: 1 } },
  { id: "account-deletion-recovery", name: "learnrecur/account-deletion.recovery", maxAttempts: 3, concurrency: { scope: "account-deletion-recovery", key: "cron", limit: 1 }, schedule: "rate(15 minutes)" },
  { id: "agent-access-maintenance", name: "learnrecur/agent-access.maintenance", maxAttempts: 3, concurrency: { scope: "agent-access-maintenance", key: "cron", limit: 1 }, schedule: "rate(5 minutes)" },
  { id: "due-practice-reminders", name: "learnrecur/practice-reminders.due", maxAttempts: 5, concurrency: { scope: "due-practice-reminders", key: "cron", limit: 1 }, schedule: "cron(0 * * * ? *)" },
];

const envelopeSchema = z.strictObject({
  version: z.literal(1),
  id: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_.:-]+$/),
  environment: z.enum(JOB_ENVIRONMENTS),
  name: z.enum(Object.keys(JOB_PAYLOAD_SCHEMAS) as [JobName, ...JobName[]]),
  data: z.unknown(),
});

export function buildJobEnvelope<N extends JobName>(name: N, data: unknown, environment: JobEnvironment): Extract<JobEnvelope, { name: N }>;
export function buildJobEnvelope(name: string, data: unknown, environment: JobEnvironment): JobEnvelope;
export function buildJobEnvelope(name: string, data: unknown, environment: JobEnvironment): JobEnvelope {
  return parseJobEnvelope(JSON.stringify({ version: 1, id: randomUUID(), environment, name, data }), environment);
}

export function parseJobEnvelope(body: string, environment: JobEnvironment): JobEnvelope {
  if (Buffer.byteLength(body) > JOB_BODY_LIMIT_BYTES) throw new Error("JOB_PAYLOAD_TOO_LARGE");
  const envelope = envelopeSchema.parse(JSON.parse(body));
  if (envelope.environment !== environment) throw new Error("JOB_ENVIRONMENT_MISMATCH");
  return { ...envelope, data: JOB_PAYLOAD_SCHEMAS[envelope.name].parse(envelope.data) } as JobEnvelope;
}

export function getJobDefinition(name: JobName): JobDefinition {
  const definition = JOB_DEFINITIONS.find((job) => job.name === name);
  if (!definition) throw new Error("JOB_TYPE_UNSUPPORTED");
  return definition;
}

export function getJobMessageGroupId(job: JobEnvelope): string {
  const { concurrency } = getJobDefinition(job.name);
  const data = job.data as Record<string, unknown>;
  const key = concurrency.key === "cron" ? "cron" : data[concurrency.key];
  if (typeof key !== "string") throw new Error("JOB_CONCURRENCY_KEY_MISSING");
  // Stable lanes preserve the existing upper bound of two jobs per user without
  // introducing a distributed semaphore. A lane collision may reduce throughput.
  const lane = concurrency.limit === 2
    ? createHash("sha256").update(String(data.itemId)).digest()[0] % 2
    : 0;
  return createHash("sha256").update(JSON.stringify([job.environment, concurrency.scope, key, lane])).digest("hex");
}

export function getJobPayloadHash(job: JobEnvelope): string {
  return createHash("sha256").update(JSON.stringify([job.environment, job.name, job.data])).digest("hex");
}

export function retryDelaySeconds(attempt: number): number {
  return Math.min(900, 30 * 2 ** Math.max(0, attempt - 1));
}
