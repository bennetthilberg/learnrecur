import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

delete process.env.LEARNRECUR_STRICT_ENV;
delete process.env.VERCEL_ENV;

// Domain tests exercise queue decisions with injected senders. Never inherit a
// real production queue from the developer's environment or CI secrets.
process.env.JOBS_ENVIRONMENT = "local";
process.env.JOBS_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/learnrecur-local-jobs.fifo";
delete process.env.LEARNRECUR_DEPLOYMENT_TIER;
