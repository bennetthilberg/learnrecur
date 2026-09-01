import { createClerkClient } from "@clerk/backend";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  shouldDeleteManagedClerkUser,
  type ManagedClerkUser,
} from "./clerk-orphans";
import { deleteDatabaseTestUsers } from "./database";

export const clerkManifestPath = path.resolve("test-results/e2e-clerk-users.json");

export type ClerkTestUser = {
  email: string;
  id: string;
  workerIndex: number;
};

type ClerkTestManifest = {
  createdAt: string;
  runId: string;
  users: ClerkTestUser[];
};

export async function provisionClerkTestUsers() {
  assertDevelopmentClerkKeys();
  await cleanupClerkTestUsers();
  await cleanupOrphanedClerkTestUsers();

  const runId = randomUUID().replaceAll("-", "").slice(0, 16);
  const manifest: ClerkTestManifest = {
    createdAt: new Date().toISOString(),
    runId,
    users: [],
  };
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  const userCount = readUserCount();

  await persistManifest(manifest);

  try {
    for (let workerIndex = 0; workerIndex < userCount; workerIndex += 1) {
      const email = `learnrecur-e2e-${runId}-${workerIndex}+clerk_test@example.com`;
      const user = await clerk.users.createUser({
        emailAddress: [email],
        firstName: "LearnRecur",
        lastName: `E2E ${workerIndex + 1}`,
        privateMetadata: {
          learnrecurE2E: {
            runId,
            scope: process.env.CI ? "ci" : "local",
            workerIndex,
          },
        },
        skipLegalChecks: true,
        skipPasswordRequirement: true,
      });

      manifest.users.push({ email, id: user.id, workerIndex });
      await persistManifest(manifest);
    }
  } catch (error) {
    await cleanupClerkTestUsers();
    throw error;
  }

  return manifest;
}

async function cleanupOrphanedClerkTestUsers() {
  const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
  const orphanIds: string[] = [];
  let offset = 0;

  while (true) {
    const page = await clerk.users.getUserList({
      limit: 100,
      offset,
      query: "learnrecur-e2e-",
    });
    orphanIds.push(
      ...page.data
        .filter((user) =>
          shouldDeleteManagedClerkUser(user as ManagedClerkUser, {
            ci: Boolean(process.env.CI),
            now: Date.now(),
          }),
        )
        .map((user) => user.id),
    );
    offset += page.data.length;
    if (offset >= page.totalCount || page.data.length === 0) {
      break;
    }
  }

  if (orphanIds.length === 0) {
    return;
  }

  if (process.env.DATABASE_URL) {
    await deleteDatabaseTestUsers(orphanIds);
  }
  const results = await Promise.allSettled(
    orphanIds.map((userId) => clerk.users.deleteUser(userId)),
  );
  const errors = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason)
    .filter((error) => !isClerkNotFound(error));
  if (errors.length > 0) {
    throw new AggregateError(errors, "Authenticated E2E orphan cleanup did not complete.");
  }
}

export async function readClerkTestManifest() {
  return JSON.parse(await readFile(clerkManifestPath, "utf8")) as ClerkTestManifest;
}

export async function cleanupClerkTestUsers() {
  let manifest: ClerkTestManifest;
  try {
    manifest = await readClerkTestManifest();
  } catch (error) {
    if (isMissingFile(error)) {
      return;
    }
    throw error;
  }

  const errors: unknown[] = [];

  if (manifest.users.length > 0 && process.env.DATABASE_URL) {
    try {
      await deleteDatabaseTestUsers(manifest.users.map((user) => user.id));
    } catch (error) {
      errors.push(error);
    }
  }

  if (process.env.CLERK_SECRET_KEY) {
    const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY });
    const results = await Promise.allSettled(
      manifest.users.map((user) => clerk.users.deleteUser(user.id)),
    );
    for (const result of results) {
      if (result.status === "rejected" && !isClerkNotFound(result.reason)) {
        errors.push(result.reason);
      }
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "Authenticated E2E cleanup did not complete.");
  }

  await rm(clerkManifestPath, { force: true });
}

export function getWorkerUser(manifest: ClerkTestManifest, parallelIndex: number) {
  const user = manifest.users.find((candidate) => candidate.workerIndex === parallelIndex);
  if (!user) {
    throw new Error(
      `No Clerk test user was provisioned for parallel worker ${parallelIndex}. ` +
        "Keep E2E_CLERK_USER_COUNT aligned with Playwright's worker count.",
    );
  }
  return user;
}

function assertDevelopmentClerkKeys() {
  const publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;
  const secretKey = process.env.CLERK_SECRET_KEY;

  if (!publishableKey || !secretKey) {
    throw new Error(
      "Authenticated E2E requires NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY and CLERK_SECRET_KEY.",
    );
  }

  if (!publishableKey.startsWith("pk_test_") || !secretKey.startsWith("sk_test_")) {
    throw new Error("Authenticated E2E only accepts Clerk development-instance keys.");
  }
}

function readUserCount() {
  const value = process.env.E2E_CLERK_USER_COUNT ?? "2";
  const count = Number.parseInt(value, 10);
  if (!Number.isInteger(count) || count < 2 || count > 6) {
    throw new Error("E2E_CLERK_USER_COUNT must be an integer between 2 and 6.");
  }
  return count;
}

async function persistManifest(manifest: ClerkTestManifest) {
  await mkdir(path.dirname(clerkManifestPath), { recursive: true });
  await writeFile(clerkManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
}

function isMissingFile(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isClerkNotFound(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404
  );
}
