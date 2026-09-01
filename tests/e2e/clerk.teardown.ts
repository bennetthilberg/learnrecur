import { config as loadEnv } from "dotenv";
import { test as teardown } from "@playwright/test";

import { cleanupClerkTestUsers } from "./support/clerk-test-users";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

teardown.describe.configure({ mode: "serial" });

teardown("remove Clerk and database test users", async () => {
  await cleanupClerkTestUsers();
});
