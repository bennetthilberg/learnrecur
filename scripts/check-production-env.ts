import { config as loadEnv } from "dotenv";

import {
  formatEnvError,
  getProductionEnv,
  shouldCheckProductionEnv,
} from "../src/lib/env";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

const strict = process.argv.includes("--strict") || shouldCheckProductionEnv();

if (!strict) {
  console.log(
    "Skipping strict production environment check. Set LEARNRECUR_STRICT_ENV=1 or pass --strict to enforce it.",
  );
  process.exit(0);
}

try {
  getProductionEnv();
  console.log("Production environment check passed.");
} catch (error) {
  console.error("Production environment check failed:");
  console.error(formatEnvError(error));
  process.exit(1);
}
