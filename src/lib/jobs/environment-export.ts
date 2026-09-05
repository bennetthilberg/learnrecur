import { PutParameterCommand } from "@aws-sdk/client-ssm";
import { selectWorkerEnvironment } from "./environment";

export async function exportWorkerConfiguration(env: Record<string, string | undefined>, send: (command: PutParameterCommand) => Promise<unknown>) {
  const revision = env.AWS_WORKER_CONFIG_EXPORT_REVISION;
  if (!revision) return { exported: false as const };
  if (env.VERCEL !== "1" || env.JOBS_ENVIRONMENT !== "production" || env.VERCEL_ENV !== "production" || env.LEARNRECUR_DEPLOYMENT_TIER !== "production" || !/^[a-zA-Z0-9-]{1,80}$/.test(revision)) {
    throw new Error("WORKER_CONFIGURATION_EXPORT_CONTEXT_INVALID");
  }
  const values = selectWorkerEnvironment(env);
  for (const [key, value] of Object.entries(values)) {
    await send(new PutParameterCommand({ Name: `/learnrecur/production/jobs/${revision}/${key}`, Type: "SecureString", Tier: "Standard", Value: value, Overwrite: false }));
  }
  return { exported: true as const, revision, count: Object.keys(values).length };
}
