import { spawnSync } from "node:child_process";

import { getVercelBuildSteps } from "./lib/release-commands";

const environment = process.env.VERCEL_ENV;
if (environment !== "production") {
  console.log(`[vercel-build] ${environment ?? "local"} build; hosted migrations are skipped`);
}

for (const step of getVercelBuildSteps(environment)) {
  console.log(`[vercel-build] starting ${step.label}`);
  const result = spawnSync(
    process.platform === "win32" ? `${step.command}.cmd` : step.command,
    [...step.args],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${step.label} exited with status ${result.status ?? "unknown"}.`);
  }
}
