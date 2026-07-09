import "server-only";

import { MaterialCleanupStatus } from "@/generated/prisma/client";
import { getInngestEnvStatus } from "@/lib/inngest/client";
import {
  inngestMaterialCleanupEventSender,
  type MaterialCleanupEventSender,
} from "@/lib/inngest/events";
import { requestMaterialDeletion } from "@/lib/materials/lifecycle";
import { getPrisma } from "@/lib/prisma";
import { resolveS3SourceObjectStorage, type SourceObjectStorage } from "@/lib/storage/s3";

export async function queueMaterialDeletion(input: {
  userId: string;
  materialId: string;
  confirmationTitle: string;
  now: Date;
  eventSender?: MaterialCleanupEventSender;
}) {
  const deletion = await requestMaterialDeletion(input);
  if (deletion.status !== "queued") {
    return deletion;
  }
  const envStatus = getInngestEnvStatus();
  if (envStatus.status === "missing-env" && !input.eventSender) {
    return {
      status: "not-deleted" as const,
      reason: "queue-unavailable" as const,
      message: envStatus.message,
    };
  }

  try {
    await (input.eventSender ?? inngestMaterialCleanupEventSender).sendMaterialCleanupRequested({
      userId: input.userId,
      materialId: deletion.materialId,
      cleanupJobId: deletion.cleanupJobId,
      requestedAt: input.now.toISOString(),
    });
  } catch {
    return {
      status: "not-deleted" as const,
      reason: "queue-unavailable" as const,
      message: "Material deletion was saved but cleanup could not be queued. Try again.",
    };
  }

  return deletion;
}

export async function runMaterialCleanupJob(input: {
  userId: string;
  materialId: string;
  cleanupJobId: string;
  storage?: SourceObjectStorage;
}) {
  const prisma = getPrisma();
  const material = await prisma.studyMaterial.findFirst({
    where: {
      id: input.materialId,
      userId: input.userId,
      cleanupJob: { id: input.cleanupJobId },
    },
    select: {
      id: true,
      cleanupJob: { select: { id: true, status: true } },
      revisions: {
        select: {
          storageBucket: true,
          storageKey: true,
          sourceFiles: { select: { storageBucket: true, storageKey: true } },
        },
      },
    },
  });
  if (!material?.cleanupJob) {
    return { status: "already-clean" as const };
  }

  await prisma.materialCleanupJob.update({
    where: { id: material.cleanupJob.id },
    data: {
      status: MaterialCleanupStatus.RUNNING,
      attemptCount: { increment: 1 },
      startedAt: new Date(),
      errorMessage: null,
    },
  });

  const storageSetup = input.storage
    ? { status: "ready" as const, storage: input.storage }
    : resolveS3SourceObjectStorage();
  if (storageSetup.status === "missing-env") {
    await markCleanupFailed(material.cleanupJob.id, storageSetup.message);
    throw new Error(storageSetup.message);
  }

  try {
    const objects = new Map<string, { bucket: string; key: string }>();
    for (const revision of material.revisions) {
      addObject(objects, revision.storageBucket, revision.storageKey);
      for (const sourceFile of revision.sourceFiles) {
        addObject(objects, sourceFile.storageBucket, sourceFile.storageKey);
      }
    }
    for (const object of objects.values()) {
      await storageSetup.storage.deleteObject({ bucket: object.bucket, key: object.key });
    }

    await prisma.materialCleanupJob.update({
      where: { id: material.cleanupJob.id },
      data: { status: MaterialCleanupStatus.SUCCEEDED, completedAt: new Date() },
    });
    await prisma.studyMaterial.deleteMany({
      where: { id: material.id, userId: input.userId },
    });
    return { status: "deleted" as const, deletedObjectCount: objects.size };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Material cleanup failed.";
    await markCleanupFailed(material.cleanupJob.id, message);
    throw error;
  }
}

async function markCleanupFailed(cleanupJobId: string, message: string) {
  await getPrisma().materialCleanupJob.updateMany({
    where: { id: cleanupJobId },
    data: { status: MaterialCleanupStatus.FAILED, errorMessage: message.slice(0, 1_000) },
  });
}

function addObject(
  objects: Map<string, { bucket: string; key: string }>,
  bucket: string | null,
  key: string | null,
) {
  if (bucket && key) {
    objects.set(`${bucket}\u0000${key}`, { bucket, key });
  }
}
