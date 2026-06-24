import { writeFile } from "node:fs/promises";
import { config as loadEnv } from "dotenv";

import { GenerationJobStatus } from "../src/generated/prisma/client";
import { formatEnvError } from "../src/lib/env";
import { getOpsOverview } from "../src/lib/ops";
import { getPrisma } from "../src/lib/prisma";
import { getUserDataExport } from "../src/lib/settings/data-export";
import { requeueSourceUploadDraft } from "../src/lib/skills/uploads";
import { resolveS3SourceObjectStorage } from "../src/lib/storage/s3";

loadEnv({ path: ".env.local", quiet: true });
loadEnv({ path: ".env", quiet: true });

type Args = Record<string, string | true>;

const command = process.argv[2];
const args = parseArgs(process.argv.slice(3));

main().catch((error) => {
  console.error(formatEnvError(error));
  process.exit(1);
});

async function main() {
  switch (command) {
    case "report":
      return report();
    case "export-user":
      return exportUser();
    case "delete-user":
      return deleteUser();
    case "disable-reminders":
      return disableReminders();
    case "mark-generation-job-failed":
      return markGenerationJobFailed();
    case "requeue-source-upload":
      return requeueSourceUpload();
    case "storage-audit":
      return storageAudit();
    default:
      printUsage();
      process.exit(command ? 1 : 0);
  }
}

async function report() {
  const overview = await getOpsOverview({ now: new Date() });
  console.log(JSON.stringify(overview, null, 2));
}

async function exportUser() {
  const userId = requireStringArg("user-id");
  const out = requireStringArg("out");
  const result = await getUserDataExport({
    userId,
    generatedAt: new Date(),
  });

  if (result.status !== "ready") {
    throw new Error(result.message);
  }

  await writeFile(out, `${JSON.stringify(result.export, null, 2)}\n`, "utf8");
  console.log(`Wrote ${result.filename} to ${out}.`);
}

async function deleteUser() {
  const userId = requireStringArg("user-id");
  const confirmed = args.confirm === userId;
  const deleteS3 = args["delete-s3"] === true;
  const prisma = getPrisma();
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
    select: {
      id: true,
      email: true,
      collections: { select: { id: true } },
      sourceFiles: {
        select: {
          id: true,
          storageBucket: true,
          storageKey: true,
        },
      },
      skills: { select: { id: true } },
      exercises: { select: { id: true } },
      exerciseAttempts: { select: { id: true } },
      reviewLogs: { select: { id: true } },
      exerciseFlags: { select: { id: true } },
      generationJobs: { select: { id: true } },
      reminderPreference: { select: { id: true } },
      reminderSendLogs: { select: { id: true } },
    },
  });

  if (!user) {
    throw new Error(`No app user found for ${userId}.`);
  }

  const storageObjects = user.sourceFiles
    .filter((sourceFile) => sourceFile.storageKey)
    .map((sourceFile) => ({
      bucket: sourceFile.storageBucket,
      key: sourceFile.storageKey as string,
    }));

  const summary = {
    user: {
      id: user.id,
      email: user.email,
    },
    counts: {
      collections: user.collections.length,
      sourceFiles: user.sourceFiles.length,
      skills: user.skills.length,
      exercises: user.exercises.length,
      exerciseAttempts: user.exerciseAttempts.length,
      reviewLogs: user.reviewLogs.length,
      exerciseFlags: user.exerciseFlags.length,
      generationJobs: user.generationJobs.length,
      reminderPreference: user.reminderPreference ? 1 : 0,
      reminderSendLogs: user.reminderSendLogs.length,
      storageObjects: storageObjects.length,
    },
    storageObjects,
  };

  if (!confirmed) {
    console.log(JSON.stringify({ dryRun: true, ...summary }, null, 2));
    console.log(`Re-run with --confirm ${userId} --delete-s3 to delete this app user.`);
    return;
  }

  if (!deleteS3) {
    throw new Error("Refusing to delete app data without --delete-s3. Run the dry run first.");
  }

  const storageSetup = resolveS3SourceObjectStorage();

  if (storageSetup.status === "missing-env") {
    throw new Error(storageSetup.message);
  }

  for (const object of storageObjects) {
    await storageSetup.storage.deleteObject({
      bucket: object.bucket ?? undefined,
      key: object.key,
    });
  }

  await prisma.user.delete({
    where: {
      id: userId,
    },
  });

  console.log(JSON.stringify({ deleted: true, ...summary }, null, 2));
}

async function disableReminders() {
  const userId = requireStringArg("user-id");
  requireConfirm(userId);

  const result = await getPrisma().reminderPreference.updateMany({
    where: {
      userId,
    },
    data: {
      enabled: false,
    },
  });

  console.log(`Disabled reminder preferences for ${result.count} row(s).`);
}

async function markGenerationJobFailed() {
  const jobId = requireStringArg("job-id");
  const reason = requireStringArg("reason");
  requireConfirm(jobId);

  const job = await getPrisma().generationJob.update({
    where: {
      id: jobId,
    },
    data: {
      status: GenerationJobStatus.FAILED,
      errorMessage: reason,
      completedAt: new Date(),
    },
    select: {
      id: true,
      status: true,
    },
  });

  console.log(JSON.stringify(job, null, 2));
}

async function requeueSourceUpload() {
  const userId = requireStringArg("user-id");
  const sourceFileId = requireStringArg("source-file-id");
  requireConfirm(sourceFileId);

  const result = await requeueSourceUploadDraft({
    userId,
    sourceFileId,
    now: new Date(),
  });

  console.log(JSON.stringify(result, null, 2));
}

async function storageAudit() {
  const storageSetup = resolveS3SourceObjectStorage();

  if (storageSetup.status === "missing-env") {
    throw new Error(storageSetup.message);
  }

  const prisma = getPrisma();
  const dbRows = await prisma.sourceFile.findMany({
    where: {
      storageKey: {
        not: null,
      },
    },
    select: {
      id: true,
      userId: true,
      storageBucket: true,
      storageKey: true,
      status: true,
      updatedAt: true,
    },
  });
  const dbKeys = new Set(dbRows.map((row) => row.storageKey).filter(Boolean));
  const s3Keys = await storageSetup.storage.listObjects({ prefix: "source-uploads/" });
  const s3KeySet = new Set(s3Keys);
  const missingObjects = dbRows.filter((row) => row.storageKey && !s3KeySet.has(row.storageKey));
  const orphanObjects = s3Keys.filter((key) => !dbKeys.has(key));

  console.log(
    JSON.stringify(
      {
        dryRun: true,
        dbObjectRows: dbRows.length,
        s3Objects: s3Keys.length,
        missingObjects,
        orphanObjects,
      },
      null,
      2,
    ),
  );
}

function parseArgs(values: string[]): Args {
  const parsed: Args = {};

  for (let index = 0; index < values.length; index += 1) {
    const raw = values[index];

    if (!raw.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${raw}`);
    }

    const key = raw.slice(2);
    const next = values[index + 1];

    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }

  return parsed;
}

function requireStringArg(name: string): string {
  const value = args[name];

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing --${name}.`);
  }

  return value.trim();
}

function requireConfirm(expected: string) {
  if (args.confirm !== expected) {
    throw new Error(`Refusing to mutate data without --confirm ${expected}.`);
  }
}

function printUsage() {
  console.log(`Usage:
  npm run ops -- report
  npm run ops -- export-user --user-id USER_ID --out ./export.json
  npm run ops -- delete-user --user-id USER_ID
  npm run ops -- delete-user --user-id USER_ID --confirm USER_ID --delete-s3
  npm run ops -- disable-reminders --user-id USER_ID --confirm USER_ID
  npm run ops -- mark-generation-job-failed --job-id JOB_ID --reason "reason" --confirm JOB_ID
  npm run ops -- requeue-source-upload --user-id USER_ID --source-file-id SOURCE_ID --confirm SOURCE_ID
  npm run ops -- storage-audit`);
}
