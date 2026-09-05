import { PutParameterCommand } from "@aws-sdk/client-ssm";
import { selectWorkerEnvironment, workerEnvironmentManifest } from "./environment";

export async function exportWorkerConfiguration(env: Record<string, string | undefined>, send: (command: PutParameterCommand) => Promise<unknown>, pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {
  const revision = env.AWS_WORKER_CONFIG_EXPORT_REVISION;
  if (!revision) return { exported: false as const };
  if (env.VERCEL !== "1" || env.JOBS_ENVIRONMENT !== "production" || env.VERCEL_ENV !== "production" || env.LEARNRECUR_DEPLOYMENT_TIER !== "production" || !/^[a-zA-Z0-9-]{1,80}$/.test(revision)) {
    throw new Error("WORKER_CONFIGURATION_EXPORT_CONTEXT_INVALID");
  }
  const values = selectWorkerEnvironment(env);
  for (const [key, value] of Object.entries({ ...values, _MANIFEST: workerEnvironmentManifest(values) })) {
    const command = new PutParameterCommand({ Name: `/learnrecur/production/jobs/${revision}/${key}`, Type: "SecureString", Tier: "Standard", Value: value, Overwrite: false });
    for (let attempt = 0; ; attempt++) {
      try { await send(command); break; } catch (error) {
        if (attempt >= 5 || !(error instanceof Error) || !["ThrottlingException", "TooManyUpdates"].includes(error.name)) throw error;
        await pause(Math.min(5000, 500 * 2 ** attempt));
      }
    }
    // PutParameter has a lower default rate limit than read operations.
    await pause(400);
  }
  return { exported: true as const, revision, count: Object.keys(values).length };
}
