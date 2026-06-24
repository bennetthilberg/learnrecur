import { config as loadEnv } from "dotenv";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

delete process.env.LEARNRECUR_STRICT_ENV;
delete process.env.VERCEL_ENV;
