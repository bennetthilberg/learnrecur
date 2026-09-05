import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { parse } from "dotenv";
import { createJobsTemplate } from "../infra/aws/jobs-template";
import { selectWorkerEnvironment } from "../src/lib/jobs/environment";

// AWS CLI owns the login session. Secret values use temporary mode-0600 files,
// never process arguments or command output. A deployment states its schedule
// intent explicitly so updating code cannot silently enable cron work.
const { values: options } = parseArgs({ options: {
  environment: { type: "string" }, "env-file": { type: "string" }, schedules: { type: "string" },
  "source-bucket": { type: "string" }, "database-host": { type: "string" }, region: { type: "string", default: "us-east-1" },
  "configuration-revision": { type: "string" },
} });

function aws(args: string[], input?: unknown): Record<string, unknown> {
  const temporary = input ? mkdtempSync(resolve(tmpdir(), "learnrecur-aws-input-")) : undefined;
  try {
    const filename = temporary ? resolve(temporary, "input.json") : undefined;
    if (filename) writeFileSync(filename, JSON.stringify(input), { mode: 0o600 });
    const result = spawnSync("aws", [...args, "--region", options.region!, "--output", "json", "--no-cli-pager", ...(filename ? ["--cli-input-json", `file://${filename}`] : [])], { encoding: "utf8" });
    if (result.status !== 0) {
      const code = result.stderr.match(/An error occurred \(([A-Za-z0-9]+)\)/)?.[1] ?? "CLI_ERROR";
      throw new Error(`AWS ${args.slice(0, 2).join(" ")} failed (${code}); inspect the named stack or CloudTrail for details`);
    }
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  } finally { if (temporary) rmSync(temporary, { recursive: true, force: true }); }
}

function main() {
  const environment = options.environment;
  const reuseRevision = options["configuration-revision"];
  if ((environment !== "staging" && environment !== "production") || (!options["env-file"] === !reuseRevision) || (reuseRevision && !/^[a-zA-Z0-9-]{1,80}$/.test(reuseRevision)) || !options["source-bucket"] || !options["database-host"] || !["enabled", "disabled"].includes(options.schedules ?? "")) {
    throw new Error("Required: --environment staging|production, exactly one of --env-file or --configuration-revision, --source-bucket <verified bucket> --database-host <verified host> --schedules enabled|disabled");
  }
  let input: Record<string, string>;
  if (reuseRevision) {
    const prefix = `/learnrecur/${environment}/jobs/${reuseRevision}/`;
    const result = aws(["ssm", "get-parameters-by-path", "--path", prefix, "--with-decryption"]);
    const parameters = result.Parameters as { Name: string; Value: string; Type: string }[];
    if (!Array.isArray(parameters) || parameters.some((parameter) => !parameter.Name.startsWith(prefix) || parameter.Type !== "SecureString")) throw new Error("Worker configuration snapshot unavailable");
    input = Object.fromEntries(parameters.map((parameter) => [parameter.Name.slice(prefix.length), parameter.Value]));
  } else input = parse(readFileSync(options["env-file"]!));
  const values = selectWorkerEnvironment(input);
  let databaseHost = "";
  try { databaseHost = new URL(values.DATABASE_URL).hostname; } catch { throw new Error("Invalid database configuration"); }
  if (databaseHost !== options["database-host"] || values.S3_BUCKET_NAME !== options["source-bucket"]) throw new Error("Database or source bucket differs from the verified deployment target");
  const identity = aws(["sts", "get-caller-identity"]);
  if (typeof identity.Account !== "string" || !/^\d{12}$/.test(identity.Account)) throw new Error("AWS account unavailable");
  const bucket = `learnrecur-job-artifacts-${identity.Account}-${options.region}`;
  const zip = readFileSync(".aws-build/jobs.zip");
  const key = `${environment}/${createHash("sha256").update(zip).digest("hex")}.zip`;
  aws(["s3api", "put-object", "--bucket", bucket, "--key", key, "--body", resolve(".aws-build/jobs.zip")]);
  const configurationRevision = reuseRevision ?? randomUUID();
  if (!reuseRevision) for (const [name, value] of Object.entries(values)) {
      aws(["ssm", "put-parameter"], { Name: `/learnrecur/${environment}/jobs/${configurationRevision}/${name}`, Value: value, Type: "SecureString", Tier: "Standard", Overwrite: false });
    }
  mkdirSync(".aws-build", { recursive: true });
  const template = resolve(`.aws-build/${environment}-template.json`);
  writeFileSync(template, JSON.stringify(createJobsTemplate(environment), null, 2));
  console.info(`Deploying learnrecur-${environment}-jobs in ${identity.Account}/${options.region}; schedules ${options.schedules}`);
  const deployed = spawnSync("aws", ["cloudformation", "deploy", "--stack-name", `learnrecur-${environment}-jobs`, "--template-file", template,
    "--region", options.region!, "--capabilities", "CAPABILITY_NAMED_IAM", "--no-fail-on-empty-changeset", "--parameter-overrides",
    `CodeBucket=${bucket}`, `CodeKey=${key}`, `SourceBucketName=${values.S3_BUCKET_NAME}`, `EnableSchedules=${options.schedules === "enabled"}`,
    `ConfigurationRevision=${configurationRevision}`,
  ], { stdio: "inherit" });
  if (deployed.status !== 0) throw new Error("CloudFormation deployment failed");
  console.info(`Worker artifact ${key}; synchronized ${Object.keys(values).length} encrypted parameters`);
}

try { main(); } catch (error) { console.error(error instanceof Error ? error.message : "Deployment failed"); process.exitCode = 1; }
