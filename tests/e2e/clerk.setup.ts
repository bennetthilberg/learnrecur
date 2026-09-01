import { clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";

import { provisionClerkTestUsers } from "./support/clerk-test-users";

setup.describe.configure({ mode: "serial" });

setup("provision isolated Clerk users", async () => {
  await clerkSetup();
  await provisionClerkTestUsers();
});
