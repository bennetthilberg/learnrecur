import { z } from "zod";
import { JOB_ENVIRONMENTS, type JobEnvironment } from "./contracts";

type JobsConfigEnv = Record<string, string | undefined>;
export type JobsConfig = { environment: JobEnvironment; region: string; queueUrl: string; queueArn: string };

export const jobsEnvSchema = z.object({
  AWS_REGION: z.string().trim().min(1),
  JOBS_ENVIRONMENT: z.enum(JOB_ENVIRONMENTS),
  JOBS_QUEUE_URL: z.string().trim().url(),
});

export function getJobsConfig(env: JobsConfigEnv = process.env): JobsConfig {
  const parsed = jobsEnvSchema.parse(env);
  const { AWS_REGION: region, JOBS_ENVIRONMENT: environment, JOBS_QUEUE_URL: queueUrl } = parsed;
  const url = new URL(queueUrl);
  const match = url.pathname.match(/^\/(\d{12})\/learnrecur-(local|staging|production)-jobs\.fifo$/);
  if (url.protocol !== "https:" || url.host !== `sqs.${region}.amazonaws.com` || url.username || url.password || url.search || url.hash || match?.[2] !== environment) {
    throw new Error("JOB_QUEUE_ENVIRONMENT_MISMATCH");
  }
  const tier = env.DEPLOYMENT_TIER || (env.VERCEL_ENV === "production" ? "production" : env.VERCEL_ENV === "preview" ? "staging" : undefined);
  if (tier && tier !== environment) throw new Error("JOB_DEPLOYMENT_ENVIRONMENT_MISMATCH");
  return { environment, region, queueUrl, queueArn: `arn:aws:sqs:${region}:${match[1]}:learnrecur-${environment}-jobs.fifo` };
}

export function getJobsEnvStatus(env: JobsConfigEnv = process.env):
  | { status: "configured"; environment: JobEnvironment }
  | { status: "missing-env"; message: string } {
  try {
    return { status: "configured", environment: getJobsConfig(env).environment };
  } catch {
    return { status: "missing-env", message: "Background jobs require matching AWS_REGION, JOBS_ENVIRONMENT, and JOBS_QUEUE_URL configuration." };
  }
}
