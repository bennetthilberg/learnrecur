import { SSMClient } from "@aws-sdk/client-ssm";
import { exportWorkerConfiguration } from "../src/lib/jobs/environment-export";

// Opt-in, server-side transfer for secrets that Vercel intentionally does not
// export to a developer machine. The deployer grants temporary PutParameter
// access to this exact revision and removes it after the build completes.
async function main() {
  if (!process.env.AWS_WORKER_CONFIG_EXPORT_REVISION) return;
  const client = new SSMClient({ region: process.env.AWS_REGION, maxAttempts: 3 });
  try {
    const result = await exportWorkerConfiguration(process.env, (command) => client.send(command));
    if (result.exported) console.info(`Exported ${result.count} encrypted worker parameters to production revision ${result.revision}`);
  } finally { client.destroy(); }
}

main().catch((error) => {
  const knownTypes = ["ThrottlingException", "TooManyUpdates", "AccessDeniedException", "ParameterAlreadyExists", "ValidationException"];
  console.error(JSON.stringify({ outcome: "WORKER_CONFIGURATION_EXPORT_FAILED", type: error instanceof Error && knownTypes.includes(error.name) ? error.name : "CONFIGURATION_ERROR" }));
  process.exitCode = 1;
});
