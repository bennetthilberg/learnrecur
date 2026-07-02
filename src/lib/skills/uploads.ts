import "server-only";

import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  Prisma,
  SourceFileKind,
  SourceFileStatus,
  type Skill,
  type SourceFile,
} from "@/generated/prisma/client";
import { formatEnvError, getGeminiEnv } from "@/lib/env";
import {
  getGeminiRuntimeLogContext,
  getGeminiErrorLogDetails,
  getPublicGeminiFailureMessage,
  resolveGeminiRuntimeConfig,
  runLoggedGeminiOperation,
  runWithGeminiProviderFallback,
  type GeminiRuntimeConfig,
} from "@/lib/gemini";
import { getInngestEnvStatus } from "@/lib/inngest/client";
import {
  inngestSourceUploadDraftEventSender,
  type SourceUploadDraftEventSender,
} from "@/lib/inngest/events";
import {
  runOpenRouterJsonChatCompletion,
  type OpenRouterFallbackConfig,
} from "@/lib/openrouter";
import { resolveOptionalOpenRouterFallbackConfig } from "@/lib/openrouter-fallback";
import { getPrisma } from "@/lib/prisma";
import {
  MAX_COLLECTION_NAME_LENGTH,
  SOURCE_SKILL_DRAFT_PROMPT_VERSION,
  buildOpenRouterSourceMediaPart,
  buildSourceContextExcerpt,
  createGeminiSkillDraftGenerator,
  createGeneratedSkillDraftsForSourceFile,
  normalizeTags,
  validateGeneratedSkillDrafts,
  type SkillDraftGenerator,
} from "@/lib/skills";
import {
  isSourceObjectSizeLimitError,
  resolveS3SourceObjectStorage,
  type SourceObjectStorage,
} from "@/lib/storage/s3";
import {
  MAX_SOURCE_UPLOAD_BYTES,
  MAX_SOURCE_UPLOAD_FILES,
  MAX_SOURCE_UPLOAD_LABEL_LENGTH,
  MAX_TOTAL_SOURCE_UPLOAD_BYTES,
  SOURCE_UPLOAD_MAX_FILES_ERROR,
  SOURCE_UPLOAD_TOTAL_MAX_BYTES_ERROR,
  SOURCE_UPLOAD_MAX_BYTES_ERROR,
  SOURCE_UPLOAD_MIME_TYPE_ERROR,
  isSourceUploadMimeType,
  type SourceUploadMimeType,
} from "@/lib/skills/source-upload-policy";
import { checkSourceUploadUsageLimit } from "@/lib/usage-limits";

export const SOURCE_UPLOAD_PREFIX = "source-uploads";
export const SOURCE_UPLOAD_PROMPT_VERSION = "source-upload-drafts-v0";
export const SOURCE_PROCESSING_STALE_AFTER_MS = 15 * 60 * 1000;
export const MAX_SOURCE_UPLOAD_REQUEUE_ATTEMPTS = 3;
const SOURCE_UPLOAD_GENERATION_TIMEOUT_MS = 45_000;
export {
  MAX_SOURCE_UPLOAD_BYTES,
  MAX_SOURCE_UPLOAD_FILES,
  MAX_TOTAL_SOURCE_UPLOAD_BYTES,
} from "@/lib/skills/source-upload-policy";

const sourceUploadInputSchema = z.strictObject({
  originalName: z.string().trim().min(1, "Choose a file to upload.").max(220),
  mimeType: z
    .string()
    .trim()
    .refine(
      (mimeType): mimeType is SourceUploadMimeType => isSourceUploadMimeType(mimeType),
      SOURCE_UPLOAD_MIME_TYPE_ERROR,
    ),
  byteSize: z.coerce
    .number()
    .int()
    .positive("Upload a non-empty file.")
    .max(MAX_SOURCE_UPLOAD_BYTES, SOURCE_UPLOAD_MAX_BYTES_ERROR),
  sourceLabel: optionalTrimmedString().pipe(z.string().max(MAX_SOURCE_UPLOAD_LABEL_LENGTH).optional()),
  focusNote: optionalTrimmedString().pipe(z.string().max(800).optional()),
  collectionName: optionalTrimmedString().pipe(
    z
      .string()
      .max(
        MAX_COLLECTION_NAME_LENGTH,
        `Collection name must be ${MAX_COLLECTION_NAME_LENGTH} characters or fewer.`,
      )
      .optional(),
  ),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
});

const extractedSourceTextSchema = z.strictObject({
  extractedText: z.string().trim().min(40).max(80_000),
});

export type NormalizedSourceUploadInput = {
  originalName: string;
  mimeType: SourceUploadMimeType;
  byteSize: number;
  sourceLabel: string | null;
  focusNote: string | null;
  collectionName: string | null;
  tags: string[];
};

export type SourceUploadInputResult =
  | {
      status: "ready";
      value: NormalizedSourceUploadInput;
    }
  | {
      status: "invalid";
      message: string;
      fieldErrors: Record<string, string[]>;
    };

export type PrepareSourceUploadInput = {
  userId: string;
  now: Date;
  input: unknown;
  storage?: SourceUploadStorage;
};

export type PrepareSourceUploadResult =
  | {
      status: "prepared";
      sourceFileId: string;
      uploadUrl: string;
      objectKey: string;
      headers: Record<string, string>;
      expiresInSeconds: number;
    }
  | Extract<SourceUploadInputResult, { status: "invalid" }>
  | {
      status: "not-prepared";
      reason: "missing-s3-env" | "quota-exceeded" | "storage-failed";
      message: string;
    };

export type SourceTextExtractorInput = {
  bytes: Buffer;
  mimeType: SourceUploadMimeType;
  originalName: string;
  sourceLabel: string | null;
  focusNote: string | null;
};

export type SourceTextExtractor = (input: SourceTextExtractorInput) => Promise<unknown>;
export type SourceUploadStorage = SourceObjectStorage;

export type CompleteSourceUploadDraftsInput = {
  userId: string;
  sourceFileId: string;
  sourceFileIds?: string[];
  now: Date;
  storage?: SourceUploadStorage;
  extractSourceText?: SourceTextExtractor;
  generateSkillDraft?: SkillDraftGenerator;
  model?: string;
};

export type QueueSourceUploadDraftsInput = {
  userId: string;
  sourceFileId: string;
  now: Date;
  storage?: SourceUploadStorage;
  eventSender?: SourceUploadDraftEventSender;
};

type QueueSourceUploadDraftBatchInput = {
  userId: string;
  sourceFileIds: string[];
  now: Date;
  storage?: SourceUploadStorage;
};

export type QueueSourceUploadDraftsResult =
  | {
      status: "queued";
      sourceFileId: string;
      message: string;
    }
  | {
      status: "not-found";
      reason: "source-not-found";
      message: string;
    }
  | {
      status: "not-queued";
      reason:
        | "missing-s3-env"
        | "missing-inngest-env"
        | "invalid-upload"
        | "event-send-failed";
      message: string;
    };

type QueueSourceUploadDraftBatchResult =
  | {
      status: "queued";
      sourceFileIds: string[];
      message: string;
    }
  | Extract<QueueSourceUploadDraftsResult, { status: "not-found" | "not-queued" }>;

export type RequeueSourceUploadDraftInput = {
  userId: string;
  sourceFileId: string;
  now: Date;
  storage?: SourceUploadStorage;
  eventSender?: SourceUploadDraftEventSender;
};

export type RequeueSourceUploadDraftResult =
  | {
      status: "queued";
      sourceFileId: string;
      message: string;
    }
  | {
      status: "not-found";
      reason: "source-not-found";
      message: string;
    }
  | {
      status: "not-queued";
      reason:
        | "missing-s3-env"
        | "missing-inngest-env"
        | "invalid-upload"
        | "event-send-failed"
        | "not-stale"
        | "not-requeueable";
      message: string;
    };

export type DismissFailedSourceUploadInput = {
  userId: string;
  sourceFileId: string;
  now?: Date;
  storage?: SourceUploadStorage;
};

export type DismissFailedSourceUploadResult =
  | {
      status: "dismissed";
      sourceFileId: string;
      message: string;
    }
  | {
      status: "not-found";
      reason: "source-not-found";
      message: string;
    }
  | {
      status: "not-dismissed";
      reason: "not-failed" | "linked-source" | "storage-delete-failed";
      message: string;
    };

export type CompleteSourceUploadDraftsResult =
  | {
      status: "created";
      skills: Skill[];
      sourceFileId: string;
      sourceFileIds?: string[];
      skillSourceRefIds: string[];
    }
  | {
      status: "not-found";
      reason: "source-not-found";
      message: string;
    }
  | {
      status: "not-created";
      reason:
        | "missing-s3-env"
        | "missing-gemini-env"
        | "invalid-upload"
        | "extraction-failed"
        | "invalid-extraction"
        | "generation-failed"
        | "invalid-generation";
      message: string;
    };

export type ExtractedSourceTextValidationResult =
  | {
      status: "ready";
      extractedText: string;
    }
  | {
      status: "invalid";
      reason: "invalid-response";
      message: string;
    };

export function normalizeSourceUploadInput(input: unknown): SourceUploadInputResult {
  const result = sourceUploadInputSchema.safeParse(input);

  if (!result.success) {
    return {
      status: "invalid",
      message: "Upload details need a little attention.",
      fieldErrors: z.flattenError(result.error).fieldErrors,
    };
  }

  const value = result.data;

  return {
    status: "ready",
    value: {
      originalName: value.originalName,
      mimeType: value.mimeType,
      byteSize: value.byteSize,
      sourceLabel: value.sourceLabel ?? null,
      focusNote: value.focusNote ?? null,
      collectionName: value.collectionName ?? null,
      tags: normalizeTags(value.tags),
    },
  };
}

export function buildSourceUploadObjectKey({
  userId,
  sourceFileId,
  originalName,
}: {
  userId: string;
  sourceFileId: string;
  originalName: string;
}) {
  return `${SOURCE_UPLOAD_PREFIX}/${sanitizeKeySegment(userId)}/${sanitizeKeySegment(
    sourceFileId,
  )}/${sanitizeFileName(originalName)}`;
}

function isMetadataTimestampStale(
  metadata: Prisma.JsonValue | null,
  key: string,
  now: Date,
  staleAfterMs = SOURCE_PROCESSING_STALE_AFTER_MS,
): boolean {
  const timestamp = getMetadataString(metadata, key);

  if (!timestamp) {
    return false;
  }

  const timestampTime = Date.parse(timestamp);

  if (!Number.isFinite(timestampTime)) {
    return false;
  }

  return now.getTime() - timestampTime >= staleAfterMs;
}

export function isSourceUploadProcessingStale(
  metadata: Prisma.JsonValue | null,
  now: Date,
  staleAfterMs = SOURCE_PROCESSING_STALE_AFTER_MS,
): boolean {
  return isMetadataTimestampStale(
    metadata,
    "processingStartedAt",
    now,
    staleAfterMs,
  );
}

export function isSourceUploadQueuedStale(
  metadata: Prisma.JsonValue | null,
  now: Date,
  staleAfterMs = SOURCE_PROCESSING_STALE_AFTER_MS,
): boolean {
  return isMetadataTimestampStale(metadata, "queuedAt", now, staleAfterMs);
}

export function getSourceUploadRetryCount(metadata: Prisma.JsonValue | null): number {
  const metadataObject = getMetadataObject(metadata);
  const retryCount = metadataObject.retryCount;

  return typeof retryCount === "number" && Number.isFinite(retryCount) ? retryCount : 0;
}

export function canRequeueSourceUploadMetadata(metadata: Prisma.JsonValue | null): boolean {
  return (
    !isSourceUploadDismissalPendingMetadata(metadata) &&
    !isMultiFileSourceUploadBatchMetadata(metadata) &&
    getSourceUploadRetryCount(metadata) < MAX_SOURCE_UPLOAD_REQUEUE_ATTEMPTS
  );
}

export function isDismissedSourceUploadMetadata(metadata: Prisma.JsonValue | null): boolean {
  return Boolean(getMetadataString(metadata, "dismissedAt"));
}

function isSourceUploadDismissalPendingMetadata(metadata: Prisma.JsonValue | null): boolean {
  return Boolean(getMetadataString(metadata, "dismissalPendingAt"));
}

function isMultiFileSourceUploadBatchMetadata(metadata: Prisma.JsonValue | null): boolean {
  return getMetadataStringArray(metadata, "batchSourceFileIds").length > 1;
}

function buildPendingSourceUploadDismissalMetadata(
  metadata: Prisma.JsonValue | null,
  now: Date,
): Prisma.InputJsonObject {
  return {
    ...getMetadataObject(metadata),
    dismissalPendingAt: now.toISOString(),
  };
}

function buildDismissedSourceUploadMetadata(
  metadata: Prisma.JsonValue | null,
  now: Date,
): Prisma.InputJsonObject {
  const metadataObject = {
    ...getMetadataObject(metadata),
  };
  delete metadataObject.dismissalPendingAt;

  return {
    ...metadataObject,
    dismissedAt: now.toISOString(),
  };
}

export function buildSourceUploadRequeueMetadata(
  metadata: Prisma.JsonValue | null,
  now: Date,
  options: {
    requeueAttemptId?: string;
  } = {},
): Prisma.InputJsonObject {
  const metadataObject = getMetadataObject(metadata);
  const retryCount = getSourceUploadRetryCount(metadata);
  const timestamp = now.toISOString();

  return {
    ...metadataObject,
    queuedAt: timestamp,
    requeuedAt: timestamp,
    ...(options.requeueAttemptId ? { requeueAttemptId: options.requeueAttemptId } : {}),
    retryCount: retryCount + 1,
  };
}

export function validateExtractedSourceText(input: unknown): ExtractedSourceTextValidationResult {
  const result = extractedSourceTextSchema.safeParse(input);

  if (!result.success) {
    return {
      status: "invalid",
      reason: "invalid-response",
      message: "The AI could not extract enough study text from this file.",
    };
  }

  return {
    status: "ready",
    extractedText:
      buildSourceContextExcerpt([result.data.extractedText]) ?? result.data.extractedText,
  };
}

export async function prepareSourceUpload(
  input: PrepareSourceUploadInput,
): Promise<PrepareSourceUploadResult> {
  const normalized = normalizeSourceUploadInput(input.input);

  if (normalized.status === "invalid") {
    return normalized;
  }

  const storageSetup = resolveUploadStorage(input.storage);

  if (storageSetup.status === "missing-env") {
    return {
      status: "not-prepared",
      reason: "missing-s3-env",
      message: storageSetup.message,
    };
  }

  const preparedRecord = await createSourceUploadRecord({
    userId: input.userId,
    now: input.now,
    normalized: normalized.value,
    storageBucket: storageSetup.storage.bucketName,
  });

  if (preparedRecord.status === "limited") {
    return {
      status: "not-prepared",
      reason: "quota-exceeded",
      message: preparedRecord.message,
    };
  }

  const prisma = getPrisma();

  try {
    const expiresInSeconds = 600;
    const uploadUrl = await storageSetup.storage.createPresignedUploadUrl({
      key: preparedRecord.objectKey,
      mimeType: normalized.value.mimeType,
      byteSize: normalized.value.byteSize,
      maxBytes: MAX_SOURCE_UPLOAD_BYTES,
      expiresInSeconds,
    });

    return {
      status: "prepared",
      sourceFileId: preparedRecord.sourceFileId,
      uploadUrl,
      objectKey: preparedRecord.objectKey,
      headers: {
        "Content-Type": normalized.value.mimeType,
      },
      expiresInSeconds,
    };
  } catch (error) {
    await prisma.sourceFile.deleteMany({
      where: {
        id: preparedRecord.sourceFileId,
        userId: input.userId,
      },
    });

    return {
      status: "not-prepared",
      reason: "storage-failed",
      message: `S3 upload preparation failed: ${formatEnvError(error)}`,
    };
  }
}

async function createSourceUploadRecord(input: {
  userId: string;
  now: Date;
  normalized: NormalizedSourceUploadInput;
  storageBucket: string;
}): Promise<
  | {
      status: "created";
      sourceFileId: string;
      objectKey: string;
    }
  | {
      status: "limited";
      message: string;
    }
> {
  const prisma = getPrisma();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await prisma.$transaction(
        async (tx) => {
          const quota = await checkSourceUploadUsageLimit({
            userId: input.userId,
            byteSize: input.normalized.byteSize,
            now: input.now,
            prisma: tx,
          });

          if (quota.status === "limited") {
            return {
              status: "limited" as const,
              message: quota.message,
            };
          }

          const sourceFile = await tx.sourceFile.create({
            data: {
              userId: input.userId,
              kind: sourceFileKindFromMimeType(input.normalized.mimeType),
              status: SourceFileStatus.DRAFT,
              originalName: input.normalized.sourceLabel ?? input.normalized.originalName,
              mimeType: input.normalized.mimeType,
              byteSize: input.normalized.byteSize,
              storageBucket: input.storageBucket,
              metadata: buildUploadMetadata({
                normalized: input.normalized,
                model: null,
                now: input.now,
              }),
            },
            select: {
              id: true,
            },
          });
          const objectKey = buildSourceUploadObjectKey({
            userId: input.userId,
            sourceFileId: sourceFile.id,
            originalName: input.normalized.originalName,
          });

          await tx.sourceFile.update({
            where: {
              id_userId: {
                id: sourceFile.id,
                userId: input.userId,
              },
            },
            data: {
              storageKey: objectKey,
            },
          });

          return {
            status: "created" as const,
            sourceFileId: sourceFile.id,
            objectKey,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        },
      );
    } catch (error) {
      if (!isTransactionWriteConflict(error) || attempt === 1) {
        throw error;
      }
    }
  }

  return {
    status: "limited",
    message: "Upload quota changed while preparing this upload. Try again.",
  };
}

function normalizeCompletionSourceFileIds(input: CompleteSourceUploadDraftsInput):
  | {
      status: "ready";
      sourceFileIds: string[];
    }
  | {
      status: "invalid";
      message: string;
    } {
  const sourceFileIdsInput = Array.isArray(input.sourceFileIds) ? input.sourceFileIds : [];
  const rawSourceFileIds =
    sourceFileIdsInput.length > 0
      ? sourceFileIdsInput
      : [input.sourceFileId];
  const sourceFileIds = rawSourceFileIds
    .filter((sourceFileId): sourceFileId is string => typeof sourceFileId === "string")
    .map((sourceFileId) => sourceFileId.trim())
    .filter(Boolean);
  const uniqueSourceFileIds = sourceFileIds.filter((sourceFileId, index) => {
    return sourceFileIds.indexOf(sourceFileId) === index;
  });

  if (uniqueSourceFileIds.length === 0) {
    return {
      status: "invalid",
      message: "Choose at least one uploaded source file.",
    };
  }

  if (uniqueSourceFileIds.length > MAX_SOURCE_UPLOAD_FILES) {
    return {
      status: "invalid",
      message: SOURCE_UPLOAD_MAX_FILES_ERROR,
    };
  }

  return {
    status: "ready",
    sourceFileIds: uniqueSourceFileIds,
  };
}

export async function completeSourceUploadDrafts(
  input: CompleteSourceUploadDraftsInput,
): Promise<CompleteSourceUploadDraftsResult> {
  const normalizedSourceFileIds = normalizeCompletionSourceFileIds(input);

  if (normalizedSourceFileIds.status === "invalid") {
    return notCreated("invalid-upload", normalizedSourceFileIds.message);
  }

  if (normalizedSourceFileIds.sourceFileIds.length === 1) {
    const sourceFileId = normalizedSourceFileIds.sourceFileIds[0];
    const queued = await queueSourceUploadDrafts({
      userId: input.userId,
      sourceFileId,
      now: input.now,
      storage: input.storage,
      eventSender: {
        async sendSourceUploadDraftRequested() {
          return;
        },
      },
    });

    if (queued.status !== "queued") {
      if (queued.status === "not-found") {
        return sourceUploadSourceNotFound();
      }

      return notCreated(queueFailureToCompletionReason(queued.reason), queued.message);
    }
  } else {
    const queued = await queueSourceUploadDraftBatch({
      userId: input.userId,
      sourceFileIds: normalizedSourceFileIds.sourceFileIds,
      now: input.now,
      storage: input.storage,
    });

    if (queued.status !== "queued") {
      if (queued.status === "not-found") {
        return sourceUploadSourceNotFound();
      }

      return notCreated(queueFailureToCompletionReason(queued.reason), queued.message);
    }
  }

  return runQueuedSourceUploadDraftJob({
    ...input,
    sourceFileId: normalizedSourceFileIds.sourceFileIds[0],
    sourceFileIds: normalizedSourceFileIds.sourceFileIds,
  });
}

export async function cleanupPreparedSourceUploads({
  userId,
  sourceFileIds,
  storage,
}: {
  userId: string;
  sourceFileIds: string[];
  storage?: SourceUploadStorage;
}): Promise<void> {
  const uniqueSourceFileIds = sourceFileIds
    .map((sourceFileId) => sourceFileId.trim())
    .filter(Boolean)
    .filter((sourceFileId, index, allSourceFileIds) => {
      return allSourceFileIds.indexOf(sourceFileId) === index;
    });

  if (uniqueSourceFileIds.length === 0) {
    return;
  }

  const prisma = getPrisma();
  const sourceFiles = await prisma.sourceFile.findMany({
    where: {
      id: {
        in: uniqueSourceFileIds,
      },
      userId,
      status: SourceFileStatus.DRAFT,
    },
  });
  const storageSetup = resolveUploadStorage(storage);
  const cleanupStorage = storageSetup.status === "ready" ? storageSetup.storage : null;

  await cleanupUploadedSources(sourceFiles, cleanupStorage);
}

async function queueSourceUploadDraftBatch(
  input: QueueSourceUploadDraftBatchInput,
): Promise<QueueSourceUploadDraftBatchResult> {
  const prisma = getPrisma();
  const sourceFiles = await prisma.sourceFile.findMany({
    where: {
      id: {
        in: input.sourceFileIds,
      },
      userId: input.userId,
    },
  });
  const orderedSourceFiles = input.sourceFileIds
    .map((sourceFileId) => sourceFiles.find((sourceFile) => sourceFile.id === sourceFileId))
    .filter((sourceFile): sourceFile is SourceFile => Boolean(sourceFile));

  if (orderedSourceFiles.length !== input.sourceFileIds.length) {
    const storageSetup = resolveUploadStorage(input.storage);
    await cleanupUploadedSources(
      orderedSourceFiles.filter((sourceFile) => sourceFile.status === SourceFileStatus.DRAFT),
      storageSetup.status === "ready" ? storageSetup.storage : null,
    );
    return sourceUploadSourceNotFound();
  }

  const invalidStatusSource = orderedSourceFiles.find((sourceFile) => {
    return (
      sourceFile.status !== SourceFileStatus.DRAFT &&
      sourceFile.status !== SourceFileStatus.UPLOADED
    );
  });

  if (invalidStatusSource) {
    const storageSetup = resolveUploadStorage(input.storage);
    await cleanupUploadedSources(
      orderedSourceFiles.filter((sourceFile) => sourceFile.status === SourceFileStatus.DRAFT),
      storageSetup.status === "ready" ? storageSetup.storage : null,
    );
    return notQueued("invalid-upload", "This upload has already been processed or is processing.");
  }

  const storageSetup = resolveUploadStorage(input.storage);

  if (storageSetup.status === "missing-env") {
    await cleanupUploadedSources(
      orderedSourceFiles.filter((sourceFile) => sourceFile.status === SourceFileStatus.DRAFT),
      null,
    );
    return notQueued("missing-s3-env", storageSetup.message);
  }

  const validatedSources: Array<{
    sourceFile: SourceFile;
    byteSize: number;
  }> = [];

  for (const sourceFile of orderedSourceFiles) {
    const uploadValidation = await validateStoredSourceUpload(sourceFile, storageSetup.storage);

    if (uploadValidation.status === "invalid") {
      await cleanupUploadedSources(
        orderedSourceFiles.filter((candidate) => candidate.status === SourceFileStatus.DRAFT),
        storageSetup.storage,
      );
      return notQueued("invalid-upload", uploadValidation.message);
    }

    validatedSources.push({
      sourceFile,
      byteSize: uploadValidation.byteSize,
    });
  }

  const totalByteSize = validatedSources.reduce((sum, source) => sum + source.byteSize, 0);

  if (totalByteSize > MAX_TOTAL_SOURCE_UPLOAD_BYTES) {
    await cleanupUploadedSources(
      orderedSourceFiles.filter((sourceFile) => sourceFile.status === SourceFileStatus.DRAFT),
      storageSetup.storage,
    );
    return notQueued("invalid-upload", SOURCE_UPLOAD_TOTAL_MAX_BYTES_ERROR);
  }

  try {
    await prisma.$transaction(async (tx) => {
      for (const source of validatedSources) {
        if (source.sourceFile.status === SourceFileStatus.UPLOADED) {
          continue;
        }

        const queuedSource = await tx.sourceFile.updateMany({
          where: {
            id: source.sourceFile.id,
            userId: input.userId,
            status: SourceFileStatus.DRAFT,
            updatedAt: source.sourceFile.updatedAt,
          },
          data: {
            status: SourceFileStatus.UPLOADED,
            byteSize: source.byteSize,
            metadata: buildQueuedUploadMetadata(source.sourceFile.metadata, input.now, {
              batchSourceFileIds: input.sourceFileIds,
            }),
          },
        });

        if (queuedSource.count !== 1) {
          throw new SourceUploadBatchQueueError();
        }
      }
    });
  } catch (error) {
    if (error instanceof SourceUploadBatchQueueError) {
      return notQueued("invalid-upload", "This upload has already been processed or is processing.");
    }

    throw error;
  }

  return {
    status: "queued",
    sourceFileIds: input.sourceFileIds,
    message: "Upload received. Skills will appear in the library after preparation.",
  };
}

export async function queueSourceUploadDrafts(
  input: QueueSourceUploadDraftsInput,
): Promise<QueueSourceUploadDraftsResult> {
  const prisma = getPrisma();
  const sourceFile = await prisma.sourceFile.findFirst({
    where: {
      id: input.sourceFileId,
      userId: input.userId,
    },
  });

  if (!sourceFile) {
    return sourceUploadSourceNotFound();
  }

  if (sourceFile.status !== SourceFileStatus.DRAFT) {
    if (
      sourceFile.status === SourceFileStatus.UPLOADED ||
      sourceFile.status === SourceFileStatus.PROCESSING
    ) {
      return {
        status: "queued",
        sourceFileId: sourceFile.id,
        message: "Skill preparation has already started.",
      };
    }

    return notQueued("invalid-upload", "This upload has already been processed or failed.");
  }

  const storageSetup = resolveUploadStorage(input.storage);

  if (storageSetup.status === "missing-env") {
    await cleanupUploadedSource(sourceFile, null);
    return notQueued("missing-s3-env", storageSetup.message);
  }

  if (!sourceFile.storageKey || !sourceFile.storageBucket || !sourceFile.mimeType) {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notQueued("invalid-upload", "Uploaded source metadata is incomplete.");
  }

  if (!isAllowedSourceUploadMimeType(sourceFile.mimeType)) {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notQueued("invalid-upload", "Uploaded source MIME type is not supported.");
  }

  let head;

  try {
    head = await storageSetup.storage.headObject({
      key: sourceFile.storageKey,
      bucket: sourceFile.storageBucket,
    });
  } catch (error) {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notQueued("invalid-upload", `Could not verify S3 upload: ${formatEnvError(error)}`);
  }

  const actualByteSize = head.byteSize ?? sourceFile.byteSize;

  if (!actualByteSize || actualByteSize > MAX_SOURCE_UPLOAD_BYTES) {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notQueued("invalid-upload", "Uploaded file is missing or larger than 10 MB.");
  }

  if (head.mimeType && head.mimeType !== sourceFile.mimeType) {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notQueued("invalid-upload", "Uploaded file type did not match the prepared upload.");
  }

  if (!input.eventSender) {
    const inngestEnv = getInngestEnvStatus();

    if (inngestEnv.status === "missing-env") {
      await cleanupUploadedSource(sourceFile, storageSetup.storage);
      return notQueued("missing-inngest-env", inngestEnv.message);
    }
  }

  const queued = await prisma.sourceFile.updateMany({
    where: {
      id: sourceFile.id,
      userId: input.userId,
      status: SourceFileStatus.DRAFT,
    },
    data: {
      status: SourceFileStatus.UPLOADED,
      byteSize: actualByteSize,
      metadata: buildQueuedUploadMetadata(sourceFile.metadata, input.now),
    },
  });

  if (queued.count !== 1) {
    return notQueued("invalid-upload", "This upload has already been processed or is processing.");
  }

  const eventSender = input.eventSender ?? inngestSourceUploadDraftEventSender;

  try {
    await eventSender.sendSourceUploadDraftRequested({
      userId: input.userId,
      sourceFileId: sourceFile.id,
      requestedAt: input.now.toISOString(),
    });
  } catch (error) {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notQueued(
      "event-send-failed",
      `Could not start skill preparation: ${formatEnvError(error)}`,
    );
  }

  return {
    status: "queued",
    sourceFileId: sourceFile.id,
    message: "Upload received. Skills will appear in the library after preparation.",
  };
}

export async function requeueSourceUploadDraft(
  input: RequeueSourceUploadDraftInput,
): Promise<RequeueSourceUploadDraftResult> {
  const prisma = getPrisma();
  const sourceFile = await prisma.sourceFile.findFirst({
    where: {
      id: input.sourceFileId,
      userId: input.userId,
    },
    include: {
      _count: {
        select: {
          skillRefs: true,
        },
      },
    },
  });

  if (!sourceFile) {
    return sourceUploadSourceNotFound();
  }

  if (sourceFile.status === SourceFileStatus.PROCESSING) {
    if (!isSourceUploadProcessingStale(sourceFile.metadata, input.now)) {
      return requeueNotQueued(
        "not-stale",
        "Skill preparation is still running. Give the background worker a little more time.",
      );
    }
  } else if (sourceFile.status === SourceFileStatus.UPLOADED) {
    if (!isSourceUploadQueuedStale(sourceFile.metadata, input.now)) {
      return requeueNotQueued(
        "not-stale",
        "Skill preparation is still queued. Give the background worker a little more time.",
      );
    }
  } else if (sourceFile.status === SourceFileStatus.FAILED) {
    if (!isFailedSourceUploadRequeueable(sourceFile)) {
      return requeueNotQueued(
        "not-requeueable",
        "Only saved uploads without linked skills can be restarted.",
      );
    }
  } else {
    return requeueNotQueued(
      "not-requeueable",
      "Only saved uploads with waiting, failed, or stuck preparation can be restarted.",
    );
  }

  if (!canRequeueSourceUploadMetadata(sourceFile.metadata)) {
    return requeueNotQueued(
      "not-requeueable",
      "This upload has reached the retry limit. Upload a new copy to try again.",
    );
  }

  const storageSetup = resolveUploadStorage(input.storage);

  if (storageSetup.status === "missing-env") {
    return requeueNotQueued("missing-s3-env", storageSetup.message);
  }

  const uploadValidation = await validateStoredSourceUpload(sourceFile, storageSetup.storage);

  if (uploadValidation.status === "invalid") {
    return requeueNotQueued("invalid-upload", uploadValidation.message);
  }

  if (!input.eventSender) {
    const inngestEnv = getInngestEnvStatus();

    if (inngestEnv.status === "missing-env") {
      return requeueNotQueued("missing-inngest-env", inngestEnv.message);
    }
  }

  const requeueAttemptId = randomUUID();
  const requeueMetadata = buildSourceUploadRequeueMetadata(sourceFile.metadata, input.now, {
    requeueAttemptId,
  });
  const requeued = await prisma.sourceFile.updateMany({
    where: {
      id: sourceFile.id,
      userId: input.userId,
      status: sourceFile.status,
      storageBucket: sourceFile.storageBucket,
      storageKey: sourceFile.storageKey,
      updatedAt: sourceFile.updatedAt,
    },
    data: {
      status: SourceFileStatus.UPLOADED,
      byteSize: uploadValidation.byteSize,
      metadata: requeueMetadata,
    },
  });

  if (requeued.count !== 1) {
    return requeueNotQueued(
      "invalid-upload",
      "This upload changed while the retry was starting. Refresh and try again.",
    );
  }

  const eventSender = input.eventSender ?? inngestSourceUploadDraftEventSender;

  try {
    await eventSender.sendSourceUploadDraftRequested({
      userId: input.userId,
      sourceFileId: sourceFile.id,
      requestedAt: input.now.toISOString(),
    });
  } catch (error) {
    await prisma.sourceFile.updateMany({
      where: {
        id: sourceFile.id,
        userId: input.userId,
        status: SourceFileStatus.UPLOADED,
        storageBucket: sourceFile.storageBucket,
        storageKey: sourceFile.storageKey,
        metadata: {
          equals: requeueMetadata,
        },
      },
      data: {
        status: sourceFile.status,
        byteSize: sourceFile.byteSize,
        metadata: sourceFile.metadata ?? Prisma.DbNull,
      },
    });

    return requeueNotQueued(
      "event-send-failed",
      `Could not restart skill preparation: ${formatEnvError(error)}`,
    );
  }

  return {
    status: "queued",
    sourceFileId: sourceFile.id,
    message: "Skill preparation restarted.",
  };
}

function isFailedSourceUploadRequeueable(sourceFile: {
  kind: SourceFileKind;
  storageKey: string | null;
  metadata: Prisma.JsonValue | null;
  _count: {
    skillRefs: number;
  };
}) {
  return (
    sourceFile.kind !== SourceFileKind.TEXT &&
    Boolean(sourceFile.storageKey) &&
    !isMultiFileSourceUploadBatchMetadata(sourceFile.metadata) &&
    sourceFile._count.skillRefs === 0
  );
}

export async function dismissFailedSourceUpload(
  input: DismissFailedSourceUploadInput,
): Promise<DismissFailedSourceUploadResult> {
  const prisma = getPrisma();
  const sourceFile = await prisma.sourceFile.findFirst({
    where: {
      id: input.sourceFileId,
      userId: input.userId,
    },
    select: {
      id: true,
      kind: true,
      status: true,
      metadata: true,
      storageBucket: true,
      storageKey: true,
      updatedAt: true,
      _count: {
        select: {
          skillRefs: true,
        },
      },
    },
  });

  if (!sourceFile) {
    return sourceUploadSourceNotFound();
  }

  if (sourceFile._count.skillRefs > 0) {
    return {
      status: "not-dismissed",
      reason: "linked-source",
      message: "Linked source material cannot be dismissed from the processing list.",
    };
  }

  const now = input.now ?? new Date();

  if (!isSourceUploadDismissible(sourceFile, now)) {
    return {
      status: "not-dismissed",
      reason: "not-failed",
      message: "Only failed or capped saved uploads can be dismissed.",
    };
  }

  const dismissedObject = {
    storageBucket: sourceFile.storageBucket,
    storageKey: sourceFile.storageKey,
  };
  const pendingDismissalMetadata = buildPendingSourceUploadDismissalMetadata(
    sourceFile.metadata,
    now,
  );
  const dismissedMetadata = buildDismissedSourceUploadMetadata(sourceFile.metadata, now);

  const pendingDismissal = await prisma.$transaction(async (tx) => {
    const claimedSource = await tx.sourceFile.updateMany({
      where: {
        id: sourceFile.id,
        userId: input.userId,
        kind: sourceFile.kind,
        status: sourceFile.status,
        storageBucket: sourceFile.storageBucket,
        storageKey: sourceFile.storageKey,
        updatedAt: sourceFile.updatedAt,
        skillRefs: {
          none: {},
        },
      },
      data: {
        status: SourceFileStatus.FAILED,
        metadata: pendingDismissalMetadata,
      },
    });

    if (claimedSource.count !== 1) {
      return null;
    }

    return tx.sourceFile.findFirst({
      where: {
        id: sourceFile.id,
        userId: input.userId,
        kind: sourceFile.kind,
        status: SourceFileStatus.FAILED,
        storageBucket: sourceFile.storageBucket,
        storageKey: sourceFile.storageKey,
        metadata: {
          equals: pendingDismissalMetadata,
        },
      },
      select: {
        updatedAt: true,
      },
    });
  });

  if (!pendingDismissal) {
    return sourceUploadSourceNotFound();
  }

  const deletedObject = await deleteDismissedSourceUploadObject(dismissedObject, input.storage);

  if (deletedObject.status === "failed") {
    const restoredSource = await prisma.sourceFile.updateMany({
      where: {
        id: sourceFile.id,
        userId: input.userId,
        kind: sourceFile.kind,
        status: SourceFileStatus.FAILED,
        storageBucket: sourceFile.storageBucket,
        storageKey: sourceFile.storageKey,
        updatedAt: pendingDismissal.updatedAt,
        metadata: {
          equals: pendingDismissalMetadata,
        },
      },
      data: {
        status: sourceFile.status,
        metadata: sourceFile.metadata ?? Prisma.DbNull,
      },
    });

    if (restoredSource.count !== 1) {
      console.error("[skills] failed to restore source upload dismissal claim", {
        sourceFileId: sourceFile.id,
        userId: input.userId,
      });
    }

    return {
      status: "not-dismissed",
      reason: "storage-delete-failed",
      message: deletedObject.message,
    };
  }

  const dismissedSource = await prisma.sourceFile.updateMany({
    where: {
      id: sourceFile.id,
      userId: input.userId,
      kind: sourceFile.kind,
      status: SourceFileStatus.FAILED,
      storageBucket: sourceFile.storageBucket,
      storageKey: sourceFile.storageKey,
      updatedAt: pendingDismissal.updatedAt,
      metadata: {
        equals: pendingDismissalMetadata,
      },
    },
    data: {
      metadata: dismissedMetadata,
      storageBucket: null,
      storageKey: null,
    },
  });

  if (dismissedSource.count !== 1) {
    console.error("[skills] failed to finalize source upload dismissal", {
      sourceFileId: sourceFile.id,
      userId: input.userId,
    });
    return sourceUploadSourceNotFound();
  }

  return {
    status: "dismissed",
    sourceFileId: sourceFile.id,
    message: "Source upload dismissed.",
  };
}

export function isSourceUploadDismissible(
  sourceFile: {
    kind: SourceFileKind;
    status: SourceFileStatus;
    metadata: Prisma.JsonValue | null;
    _count: {
      skillRefs: number;
    };
  },
  now: Date,
) {
  if (
    sourceFile._count.skillRefs > 0 ||
    (sourceFile.kind !== SourceFileKind.IMAGE && sourceFile.kind !== SourceFileKind.PDF) ||
    isDismissedSourceUploadMetadata(sourceFile.metadata)
  ) {
    return false;
  }

  if (sourceFile.status === SourceFileStatus.FAILED) {
    return true;
  }

  const canRequeueByRetryLimit = canRequeueSourceUploadMetadata(sourceFile.metadata);

  if (canRequeueByRetryLimit) {
    return false;
  }

  if (sourceFile.status === SourceFileStatus.UPLOADED) {
    return true;
  }

  return (
    sourceFile.status === SourceFileStatus.PROCESSING &&
    isSourceUploadProcessingStale(sourceFile.metadata, now)
  );
}

async function deleteDismissedSourceUploadObject(
  sourceFile: {
    storageBucket: string | null;
    storageKey: string | null;
  },
  storage?: SourceUploadStorage,
): Promise<
  | {
      status: "deleted";
    }
  | {
      status: "failed";
      message: string;
    }
> {
  if (!sourceFile.storageKey) {
    return {
      status: "deleted",
    };
  }

  const storageSetup = resolveUploadStorage(storage);

  if (storageSetup.status === "missing-env") {
    return {
      status: "failed",
      message: storageSetup.message,
    };
  }

  if (sourceFile.storageBucket && storageSetup.storage.bucketName !== sourceFile.storageBucket) {
    return {
      status: "failed",
      message: "Stored source bucket does not match the configured S3 bucket.",
    };
  }

  try {
    await storageSetup.storage.deleteObject({
      key: sourceFile.storageKey,
      bucket: sourceFile.storageBucket ?? undefined,
    });

    return {
      status: "deleted",
    };
  } catch (error) {
    return {
      status: "failed",
      message: error instanceof Error ? error.message : "Could not delete stored source object.",
    };
  }
}

class SourceUploadBatchLockError extends Error {
  constructor() {
    super("Source upload batch changed while processing started.");
    this.name = "SourceUploadBatchLockError";
  }
}

class SourceUploadBatchQueueError extends Error {
  constructor() {
    super("Source upload batch changed while queueing started.");
    this.name = "SourceUploadBatchQueueError";
  }
}

export async function runQueuedSourceUploadDraftJob(
  input: CompleteSourceUploadDraftsInput,
): Promise<CompleteSourceUploadDraftsResult> {
  const normalizedSourceFileIds = normalizeCompletionSourceFileIds(input);

  if (normalizedSourceFileIds.status === "invalid") {
    return notCreated("invalid-upload", normalizedSourceFileIds.message);
  }

  if (normalizedSourceFileIds.sourceFileIds.length > 1) {
    return runQueuedSourceUploadDraftBatchJob(input, normalizedSourceFileIds.sourceFileIds);
  }

  const sourceFileId = normalizedSourceFileIds.sourceFileIds[0];
  const prisma = getPrisma();
  const sourceFile = await prisma.sourceFile.findFirst({
    where: {
      id: sourceFileId,
      userId: input.userId,
    },
  });

  if (!sourceFile) {
    return sourceUploadSourceNotFound();
  }

  if (sourceFile.status !== SourceFileStatus.UPLOADED) {
    return notCreated("invalid-upload", "This upload has already been processed or is processing.");
  }

  const storageSetup = resolveUploadStorage(input.storage);

  if (storageSetup.status === "missing-env") {
    await markUploadedSourceFailed(
      sourceFile,
      null,
      input.now,
      "missing-s3-env",
      storageSetup.message,
    );
    return notCreated("missing-s3-env", storageSetup.message);
  }

  if (!sourceFile.storageKey || !sourceFile.storageBucket || !sourceFile.mimeType) {
    await markUploadedSourceFailed(
      sourceFile,
      storageSetup.storage,
      input.now,
      "invalid-upload",
      "Uploaded source metadata is incomplete.",
      { retainStoredObject: false },
    );
    return notCreated("invalid-upload", "Uploaded source metadata is incomplete.");
  }

  if (!isAllowedSourceUploadMimeType(sourceFile.mimeType)) {
    await markUploadedSourceFailed(
      sourceFile,
      storageSetup.storage,
      input.now,
      "invalid-upload",
      "Uploaded source MIME type is not supported.",
      { retainStoredObject: false },
    );
    return notCreated("invalid-upload", "Uploaded source MIME type is not supported.");
  }

  const processingMetadata = buildProcessingUploadMetadata(sourceFile.metadata, input.now);
  const lockedForProcessing = await prisma.sourceFile.updateMany({
    where: {
      id: sourceFile.id,
      userId: input.userId,
      status: SourceFileStatus.UPLOADED,
      storageBucket: sourceFile.storageBucket,
      storageKey: sourceFile.storageKey,
      updatedAt: sourceFile.updatedAt,
    },
    data: {
      status: SourceFileStatus.PROCESSING,
      metadata: processingMetadata,
    },
  });

  if (lockedForProcessing.count !== 1) {
    return notCreated("invalid-upload", "This upload has already been processed or is processing.");
  }

  const processingSourceFile = {
    ...sourceFile,
    status: SourceFileStatus.PROCESSING,
    metadata: processingMetadata as Prisma.JsonValue,
  };

  const uploadValidation = await validateStoredSourceUpload(sourceFile, storageSetup.storage);

  if (uploadValidation.status === "invalid") {
    const failedSourceFile = {
      ...processingSourceFile,
      byteSize: uploadValidation.byteSize ?? processingSourceFile.byteSize,
    };

    await markUploadedSourceFailed(
      failedSourceFile,
      storageSetup.storage,
      input.now,
      "invalid-upload",
      uploadValidation.message,
      { retainStoredObject: uploadValidation.retainStoredObject },
    );
    return notCreated("invalid-upload", uploadValidation.message);
  }

  const actualByteSize = uploadValidation.byteSize;
  const revalidatedProcessingSourceFile = {
    ...processingSourceFile,
    byteSize: actualByteSize,
  };

  const setup = resolveUploadGenerationSetup(input);

  if (setup.status === "missing-env") {
    await markUploadedSourceFailed(
      revalidatedProcessingSourceFile,
      storageSetup.storage,
      input.now,
      "missing-gemini-env",
      setup.message,
    );
    return notCreated("missing-gemini-env", setup.message);
  }

  let bytes: Buffer;

  try {
    bytes = await storageSetup.storage.getObjectBytes({
      key: sourceFile.storageKey,
      bucket: sourceFile.storageBucket,
      maxBytes: MAX_SOURCE_UPLOAD_BYTES,
    });
  } catch (error) {
    const isMissingObject = isMissingStoredSourceObjectError(error);
    const isSizeLimit = isSourceObjectSizeLimitError(error);
    const message = isMissingObject || isSizeLimit
      ? "Uploaded file is missing or larger than 10 MB."
      : `Could not read S3 upload: ${formatEnvError(error)}`;
    await markUploadedSourceFailed(
      revalidatedProcessingSourceFile,
      storageSetup.storage,
      input.now,
      "invalid-upload",
      message,
      { retainStoredObject: !(isMissingObject || isSizeLimit) },
    );
    return notCreated("invalid-upload", message);
  }

  if (bytes.length === 0 || bytes.length > MAX_SOURCE_UPLOAD_BYTES) {
    const message = "Uploaded file is missing or larger than 10 MB.";
    await markUploadedSourceFailed(
      revalidatedProcessingSourceFile,
      storageSetup.storage,
      input.now,
      "invalid-upload",
      message,
      { retainStoredObject: false },
    );
    return notCreated("invalid-upload", message);
  }

  let rawExtraction: unknown;

  try {
    rawExtraction = await withTimeout(
      setup.extractSourceText({
        bytes,
        mimeType: sourceFile.mimeType,
        originalName:
          getMetadataString(sourceFile.metadata, "originalFileName") ?? sourceFile.originalName,
        sourceLabel: sourceFile.originalName,
        focusNote: getMetadataString(sourceFile.metadata, "focusNote"),
      }),
      SOURCE_UPLOAD_GENERATION_TIMEOUT_MS,
      "extractSourceText timed out",
    );
  } catch (error) {
    const message = getPublicGeminiFailureMessage(error);
    console.error("[ai] source extraction failed", getGeminiErrorLogDetails(error));
    await markUploadedSourceFailed(
      revalidatedProcessingSourceFile,
      storageSetup.storage,
      input.now,
      "extraction-failed",
      message,
    );
    return notCreated("extraction-failed", message);
  }

  const extraction = validateExtractedSourceText(rawExtraction);

  if (extraction.status === "invalid") {
    console.warn(
      "[ai] source extraction returned invalid output",
      getSourceExtractionValidationLogDetails(rawExtraction),
    );
    await markUploadedSourceFailed(
      revalidatedProcessingSourceFile,
      storageSetup.storage,
      input.now,
      "invalid-extraction",
      extraction.message,
    );
    return notCreated("invalid-extraction", extraction.message);
  }

  let rawDraftGeneration: unknown;

  try {
    rawDraftGeneration = await withTimeout(
      setup.generateSkillDraft({
        sourceText: extraction.extractedText,
        sourceLabel: sourceFile.originalName,
        focusNote: getMetadataString(sourceFile.metadata, "focusNote"),
        collectionName: getMetadataString(sourceFile.metadata, "collectionName"),
        tags: getMetadataStringArray(sourceFile.metadata, "tags"),
        sourceContext: extraction.extractedText,
        sourceMedia: [
          {
            sourceFileId: sourceFile.id,
            label: sourceFile.originalName,
            mimeType: sourceFile.mimeType,
            bytes,
          },
        ],
      }),
      SOURCE_UPLOAD_GENERATION_TIMEOUT_MS,
      "generateSkillDraft timed out",
    );
  } catch (error) {
    const message = getPublicGeminiFailureMessage(error);
    console.error("[ai] source draft generation failed", getGeminiErrorLogDetails(error));
    await markUploadedSourceFailed(
      revalidatedProcessingSourceFile,
      storageSetup.storage,
      input.now,
      "generation-failed",
      message,
    );
    return notCreated("generation-failed", message);
  }

  const generatedDrafts = validateGeneratedSkillDrafts(rawDraftGeneration);

  if (generatedDrafts.status === "invalid") {
    await markUploadedSourceFailed(
      revalidatedProcessingSourceFile,
      storageSetup.storage,
      input.now,
      "invalid-generation",
      generatedDrafts.message,
    );
    return notCreated("invalid-generation", generatedDrafts.message);
  }

  const created = await createGeneratedSkillDraftsForSourceFile({
    userId: input.userId,
    sourceFileId: sourceFile.id,
    sourceFileGuard: {
      status: SourceFileStatus.PROCESSING,
      storageBucket: sourceFile.storageBucket,
      storageKey: sourceFile.storageKey,
    },
    collectionName: getMetadataString(sourceFile.metadata, "collectionName"),
    focusNote: getMetadataString(sourceFile.metadata, "focusNote"),
    tags: getMetadataStringArray(sourceFile.metadata, "tags"),
    drafts: generatedDrafts.drafts,
    sourceFileUpdate: {
      status: SourceFileStatus.READY,
      byteSize: actualByteSize,
      extractedText: extraction.extractedText,
      metadata: buildUploadMetadata({
        normalized: {
          originalName:
            getMetadataString(sourceFile.metadata, "originalFileName") ?? sourceFile.originalName,
          mimeType: sourceFile.mimeType,
          byteSize: actualByteSize,
          sourceLabel: sourceFile.originalName,
          focusNote: getMetadataString(sourceFile.metadata, "focusNote"),
          collectionName: getMetadataString(sourceFile.metadata, "collectionName"),
          tags: getMetadataStringArray(sourceFile.metadata, "tags"),
        },
        model: setup.model,
        now: input.now,
      }),
    },
  });

  if (created.status === "not-found") {
    await markUploadedSourceFailed(
      revalidatedProcessingSourceFile,
      storageSetup.storage,
      input.now,
      "source-not-found",
      "Uploaded source material was not found.",
    );
    return sourceUploadSourceNotFound();
  }

  return {
    status: "created",
    skills: created.skills,
    sourceFileId: created.sourceFileId,
    skillSourceRefIds: created.skillSourceRefIds,
  };
}

type StoredSourceUploadBatchItem = {
  sourceFile: SourceFile;
  mimeType: SourceUploadMimeType;
  storageBucket: string;
  storageKey: string;
  byteSize: number;
};

type ProcessingSourceUploadBatchItem = StoredSourceUploadBatchItem & {
  sourceFile: SourceFile;
};

type SourceUploadBatchItemWithBytes = ProcessingSourceUploadBatchItem & {
  bytes: Buffer;
  originalName: string;
  label: string;
};

type ProcessedSourceUploadBatchItem = SourceUploadBatchItemWithBytes & {
  extractedText: string;
};

async function runQueuedSourceUploadDraftBatchJob(
  input: CompleteSourceUploadDraftsInput,
  sourceFileIds: string[],
): Promise<CompleteSourceUploadDraftsResult> {
  const prisma = getPrisma();
  const sourceFiles = await prisma.sourceFile.findMany({
    where: {
      id: {
        in: sourceFileIds,
      },
      userId: input.userId,
    },
  });

  if (sourceFiles.length !== sourceFileIds.length) {
    return sourceUploadSourceNotFound();
  }

  const orderedSourceFiles = sourceFileIds.map((sourceFileId) => {
    const sourceFile = sourceFiles.find((candidate) => candidate.id === sourceFileId);

    if (!sourceFile) {
      throw new Error(`Missing source file ${sourceFileId} after source lookup.`);
    }

    return sourceFile;
  });

  if (orderedSourceFiles.some((sourceFile) => sourceFile.status !== SourceFileStatus.UPLOADED)) {
    return notCreated("invalid-upload", "This upload has already been processed or is processing.");
  }

  const storageSetup = resolveUploadStorage(input.storage);

  if (storageSetup.status === "missing-env") {
    await markUploadedSourcesFailed(
      orderedSourceFiles,
      null,
      input.now,
      "missing-s3-env",
      storageSetup.message,
      { batchSourceFileIds: sourceFileIds },
    );
    return notCreated("missing-s3-env", storageSetup.message);
  }

  const storedSources: StoredSourceUploadBatchItem[] = [];

  for (const sourceFile of orderedSourceFiles) {
    const { storageBucket, storageKey, mimeType } = sourceFile;

    if (!storageKey || !storageBucket || !mimeType) {
      const message = "Uploaded source metadata is incomplete.";
      await markUploadedSourcesFailed(
        orderedSourceFiles,
        storageSetup.storage,
        input.now,
        "invalid-upload",
        message,
        { retainStoredObject: false, batchSourceFileIds: sourceFileIds },
      );
      return notCreated("invalid-upload", message);
    }

    if (!isAllowedSourceUploadMimeType(mimeType)) {
      const message = "Uploaded source MIME type is not supported.";
      await markUploadedSourcesFailed(
        orderedSourceFiles,
        storageSetup.storage,
        input.now,
        "invalid-upload",
        message,
        { retainStoredObject: false, batchSourceFileIds: sourceFileIds },
      );
      return notCreated("invalid-upload", message);
    }

    storedSources.push({
      sourceFile,
      mimeType,
      storageBucket,
      storageKey,
      byteSize: sourceFile.byteSize ?? 0,
    });
  }

  const validatedSources: StoredSourceUploadBatchItem[] = [];

  for (const source of storedSources) {
    const uploadValidation = await validateStoredSourceUpload(source.sourceFile, storageSetup.storage);

    if (uploadValidation.status === "invalid") {
      await markUploadedSourcesFailed(
        orderedSourceFiles,
        storageSetup.storage,
        input.now,
        "invalid-upload",
        uploadValidation.message,
        {
          retainStoredObject: uploadValidation.retainStoredObject,
          batchSourceFileIds: sourceFileIds,
        },
      );
      return notCreated("invalid-upload", uploadValidation.message);
    }

    validatedSources.push({
      ...source,
      byteSize: uploadValidation.byteSize,
    });
  }

  const totalByteSize = validatedSources.reduce((sum, source) => sum + source.byteSize, 0);

  if (totalByteSize > MAX_TOTAL_SOURCE_UPLOAD_BYTES) {
    await markUploadedSourcesFailed(
      orderedSourceFiles,
      storageSetup.storage,
      input.now,
      "invalid-upload",
      SOURCE_UPLOAD_TOTAL_MAX_BYTES_ERROR,
      { batchSourceFileIds: sourceFileIds },
    );
    return notCreated("invalid-upload", SOURCE_UPLOAD_TOTAL_MAX_BYTES_ERROR);
  }

  let processingSources: ProcessingSourceUploadBatchItem[];

  try {
    processingSources = await prisma.$transaction(async (tx) => {
      const lockedSources: ProcessingSourceUploadBatchItem[] = [];

      for (const source of validatedSources) {
        const processingMetadata = buildProcessingUploadMetadata(source.sourceFile.metadata, input.now, {
          batchSourceFileIds: sourceFileIds,
        });
        const lockedForProcessing = await tx.sourceFile.updateMany({
          where: {
            id: source.sourceFile.id,
            userId: input.userId,
            status: SourceFileStatus.UPLOADED,
            storageBucket: source.storageBucket,
            storageKey: source.storageKey,
            updatedAt: source.sourceFile.updatedAt,
          },
          data: {
            status: SourceFileStatus.PROCESSING,
            byteSize: source.byteSize,
            metadata: processingMetadata,
          },
        });

        if (lockedForProcessing.count !== 1) {
          throw new SourceUploadBatchLockError();
        }

        lockedSources.push({
          ...source,
          sourceFile: {
            ...source.sourceFile,
            status: SourceFileStatus.PROCESSING,
            byteSize: source.byteSize,
            metadata: processingMetadata as Prisma.JsonValue,
          },
        });
      }

      return lockedSources;
    });
  } catch (error) {
    if (error instanceof SourceUploadBatchLockError) {
      return notCreated(
        "invalid-upload",
        "This upload has already been processed or is processing.",
      );
    }

    throw error;
  }

  const setup = resolveUploadGenerationSetup(input);

  if (setup.status === "missing-env") {
    await markUploadedSourcesFailed(
      processingSources.map((source) => source.sourceFile),
      storageSetup.storage,
      input.now,
      "missing-gemini-env",
      setup.message,
      { batchSourceFileIds: sourceFileIds },
    );
    return notCreated("missing-gemini-env", setup.message);
  }

  const sourcesWithBytes: SourceUploadBatchItemWithBytes[] = [];
  let actualTotalByteSize = 0;

  for (const source of processingSources) {
    let bytes: Buffer;

    try {
      bytes = await storageSetup.storage.getObjectBytes({
        key: source.storageKey,
        bucket: source.storageBucket,
        maxBytes: MAX_SOURCE_UPLOAD_BYTES,
      });
    } catch (error) {
      const isMissingObject = isMissingStoredSourceObjectError(error);
      const isSizeLimit = isSourceObjectSizeLimitError(error);
      const message =
        isMissingObject || isSizeLimit
          ? "Uploaded file is missing or larger than 10 MB."
          : `Could not read S3 upload: ${formatEnvError(error)}`;
      await markUploadedSourcesFailed(
        processingSources.map((processingSource) => processingSource.sourceFile),
        storageSetup.storage,
        input.now,
        "invalid-upload",
        message,
        {
          retainStoredObject: !(isMissingObject || isSizeLimit),
          batchSourceFileIds: sourceFileIds,
        },
      );
      return notCreated("invalid-upload", message);
    }

    if (bytes.length === 0 || bytes.length > MAX_SOURCE_UPLOAD_BYTES) {
      const message = "Uploaded file is missing or larger than 10 MB.";
      await markUploadedSourcesFailed(
        processingSources.map((processingSource) => processingSource.sourceFile),
        storageSetup.storage,
        input.now,
        "invalid-upload",
        message,
        { retainStoredObject: false, batchSourceFileIds: sourceFileIds },
      );
      return notCreated("invalid-upload", message);
    }

    actualTotalByteSize += bytes.length;

    if (actualTotalByteSize > MAX_TOTAL_SOURCE_UPLOAD_BYTES) {
      await markUploadedSourcesFailed(
        processingSources.map((processingSource) => processingSource.sourceFile),
        storageSetup.storage,
        input.now,
        "invalid-upload",
        SOURCE_UPLOAD_TOTAL_MAX_BYTES_ERROR,
        { retainStoredObject: false, batchSourceFileIds: sourceFileIds },
      );
      return notCreated("invalid-upload", SOURCE_UPLOAD_TOTAL_MAX_BYTES_ERROR);
    }

    const originalName =
      getMetadataString(source.sourceFile.metadata, "originalFileName") ??
      source.sourceFile.originalName;
    const label = source.sourceFile.originalName;
    sourcesWithBytes.push({
      ...source,
      bytes,
      originalName,
      label,
    });
  }

  const extractionResults = await Promise.all(
    sourcesWithBytes.map(async (source) => {
      try {
        const rawExtraction = await withTimeout(
          setup.extractSourceText({
            bytes: source.bytes,
            mimeType: source.mimeType,
            originalName: source.originalName,
            sourceLabel: source.label,
            focusNote: getMetadataString(source.sourceFile.metadata, "focusNote"),
          }),
          SOURCE_UPLOAD_GENERATION_TIMEOUT_MS,
          "extractSourceText timed out",
        );

        return {
          status: "extracted" as const,
          source,
          rawExtraction,
        };
      } catch (error) {
        return {
          status: "failed" as const,
          source,
          error,
        };
      }
    }),
  );

  const failedExtraction = extractionResults.find((result) => result.status === "failed");

  if (failedExtraction) {
    const message = getPublicGeminiFailureMessage(failedExtraction.error);
    console.error("[ai] source extraction failed", {
      ...getGeminiErrorLogDetails(failedExtraction.error),
      sourceFileId: failedExtraction.source.sourceFile.id,
    });
    await markUploadedSourcesFailed(
      processingSources.map((processingSource) => processingSource.sourceFile),
      storageSetup.storage,
      input.now,
      "extraction-failed",
      message,
      { batchSourceFileIds: sourceFileIds },
    );
    return notCreated("extraction-failed", message);
  }

  const processedSources: ProcessedSourceUploadBatchItem[] = [];

  for (const result of extractionResults) {
    if (result.status !== "extracted") {
      continue;
    }

    const extraction = validateExtractedSourceText(result.rawExtraction);

    if (extraction.status === "invalid") {
      console.warn("[ai] source extraction returned invalid output", {
        ...getSourceExtractionValidationLogDetails(result.rawExtraction),
        sourceFileId: result.source.sourceFile.id,
      });
      await markUploadedSourcesFailed(
        processingSources.map((processingSource) => processingSource.sourceFile),
        storageSetup.storage,
        input.now,
        "invalid-extraction",
        extraction.message,
        { batchSourceFileIds: sourceFileIds },
      );
      return notCreated("invalid-extraction", extraction.message);
    }

    processedSources.push({
      ...result.source,
      extractedText: extraction.extractedText,
    });
  }

  const sourceTextSections = processedSources.map((source, index) => {
    return `Source ${index + 1}: ${source.label}\n${source.extractedText}`;
  });
  const combinedSourceText =
    buildSourceContextExcerpt(sourceTextSections) ?? sourceTextSections.join("\n\n---\n\n");
  const primarySource = processedSources[0];
  let rawDraftGeneration: unknown;

  try {
    rawDraftGeneration = await withTimeout(
      setup.generateSkillDraft({
        sourceText: combinedSourceText,
        sourceLabel:
          processedSources.length === 1
            ? primarySource.label
            : `${primarySource.label} and ${processedSources.length - 1} more`,
        focusNote: getMetadataString(primarySource.sourceFile.metadata, "focusNote"),
        collectionName: getMetadataString(primarySource.sourceFile.metadata, "collectionName"),
        tags: getMetadataStringArray(primarySource.sourceFile.metadata, "tags"),
        sourceContext: combinedSourceText,
        sourceMedia: processedSources.map((source) => ({
          sourceFileId: source.sourceFile.id,
          label: source.label,
          mimeType: source.mimeType,
          bytes: source.bytes,
        })),
      }),
      SOURCE_UPLOAD_GENERATION_TIMEOUT_MS,
      "generateSkillDraft timed out",
    );
  } catch (error) {
    const message = getPublicGeminiFailureMessage(error);
    console.error("[ai] source draft generation failed", getGeminiErrorLogDetails(error));
    await markUploadedSourcesFailed(
      processingSources.map((source) => source.sourceFile),
      storageSetup.storage,
      input.now,
      "generation-failed",
      message,
      { batchSourceFileIds: sourceFileIds },
    );
    return notCreated("generation-failed", message);
  }

  const generatedDrafts = validateGeneratedSkillDrafts(rawDraftGeneration);

  if (generatedDrafts.status === "invalid") {
    await markUploadedSourcesFailed(
      processingSources.map((source) => source.sourceFile),
      storageSetup.storage,
      input.now,
      "invalid-generation",
      generatedDrafts.message,
      { batchSourceFileIds: sourceFileIds },
    );
    return notCreated("invalid-generation", generatedDrafts.message);
  }

  const created = await createGeneratedSkillDraftsForSourceFile({
    userId: input.userId,
    sourceFileId: primarySource.sourceFile.id,
    sourceFileGuard: buildReadySourceFileGuard(primarySource),
    additionalSourceFiles: processedSources.slice(1).map((source) => ({
      sourceFileId: source.sourceFile.id,
      sourceFileGuard: buildReadySourceFileGuard(source),
      sourceFileUpdate: buildReadySourceFileUpdate(source, setup.model, input.now),
    })),
    collectionName: getMetadataString(primarySource.sourceFile.metadata, "collectionName"),
    focusNote: getMetadataString(primarySource.sourceFile.metadata, "focusNote"),
    tags: getMetadataStringArray(primarySource.sourceFile.metadata, "tags"),
    drafts: generatedDrafts.drafts,
    sourceFileUpdate: buildReadySourceFileUpdate(primarySource, setup.model, input.now),
  });

  if (created.status === "not-found") {
    await markUploadedSourcesFailed(
      processingSources.map((source) => source.sourceFile),
      storageSetup.storage,
      input.now,
      "source-not-found",
      "Uploaded source material was not found.",
      { batchSourceFileIds: sourceFileIds },
    );
    return sourceUploadSourceNotFound();
  }

  return {
    status: "created",
    skills: created.skills,
    sourceFileId: created.sourceFileId,
    sourceFileIds: processedSources.map((source) => source.sourceFile.id),
    skillSourceRefIds: created.skillSourceRefIds,
  };
}

function buildReadySourceFileGuard(source: ProcessedSourceUploadBatchItem): Prisma.SourceFileWhereInput {
  return {
    status: SourceFileStatus.PROCESSING,
    storageBucket: source.storageBucket,
    storageKey: source.storageKey,
  };
}

function buildReadySourceFileUpdate(
  source: ProcessedSourceUploadBatchItem,
  model: string | null,
  now: Date,
): Pick<Prisma.SourceFileUncheckedUpdateInput, "status" | "byteSize" | "extractedText" | "metadata"> {
  return {
    status: SourceFileStatus.READY,
    byteSize: source.byteSize,
    extractedText: source.extractedText,
    metadata: buildUploadMetadata({
      normalized: {
        originalName: source.originalName,
        mimeType: source.mimeType,
        byteSize: source.byteSize,
        sourceLabel: source.label,
        focusNote: getMetadataString(source.sourceFile.metadata, "focusNote"),
        collectionName: getMetadataString(source.sourceFile.metadata, "collectionName"),
        tags: getMetadataStringArray(source.sourceFile.metadata, "tags"),
      },
      model,
      now,
    }),
  };
}

function resolveUploadGenerationSetup(
  input: CompleteSourceUploadDraftsInput,
):
  | {
      status: "ready";
      model: string;
      extractSourceText: SourceTextExtractor;
      generateSkillDraft: SkillDraftGenerator;
    }
  | {
      status: "missing-env";
      model: string;
      message: string;
    } {
  if (input.extractSourceText && input.generateSkillDraft) {
    return {
      status: "ready",
      model: input.model ?? "test-generator",
      extractSourceText: input.extractSourceText,
      generateSkillDraft: input.generateSkillDraft,
    };
  }

  const openRouterFallbackResult = resolveOptionalOpenRouterFallbackConfig();
  const openRouterFallback =
    openRouterFallbackResult.status === "ready" ? openRouterFallbackResult.config : null;

  if (openRouterFallbackResult.status === "invalid") {
    console.warn("[ai] openrouter fallback disabled for upload generation", {
      message: openRouterFallbackResult.message,
    });
  }

  let gemini: GeminiRuntimeConfig;

  try {
    gemini = resolveGeminiRuntimeConfig(getGeminiEnv());
  } catch (error) {
    return {
      status: "missing-env",
      model: input.model ?? (process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash"),
      message: formatEnvError(error),
    };
  }

  return {
    status: "ready",
    model: gemini.model,
    extractSourceText: input.extractSourceText ?? createGeminiSourceTextExtractor({
      gemini,
      openRouterFallback,
    }),
    generateSkillDraft: input.generateSkillDraft ?? createGeminiSkillDraftGenerator({
      gemini,
      openRouterFallback,
    }),
  };
}

function createGeminiSourceTextExtractor({
  gemini,
  openRouterFallback,
}: {
  gemini: GeminiRuntimeConfig;
  openRouterFallback?: OpenRouterFallbackConfig | null;
}): SourceTextExtractor {
  return async (input) => {
    const openRouterSourceFallback =
      openRouterFallback
        ? {
            provider: "openrouter",
            model: openRouterFallback.model,
            run: () => createOpenRouterSourceTextExtractor(openRouterFallback)(input),
          }
        : null;

    return runWithGeminiProviderFallback({
      fallback: openRouterSourceFallback,
      operation: "source text extraction",
      primary: getGeminiRuntimeLogContext(gemini),
      primaryModel: gemini.model,
      runPrimary: async () => {
        const prompt = buildSourceExtractionPrompt(input);

        return runLoggedGeminiOperation({
          config: gemini,
          operation: "source text extraction",
          metadata: {
            promptChars: prompt.length,
            schemaName: "geminiSourceExtractionJsonSchema",
            media: {
              count: 1,
              totalBytes: input.bytes.length,
              mimeTypes: [input.mimeType],
            },
          },
          run: async (ai) => {
            const response = await ai.models.generateContent({
              model: gemini.model,
              contents: [
                {
                  role: "user",
                  parts: [
                    {
                      inlineData: {
                        data: input.bytes.toString("base64"),
                        mimeType: input.mimeType,
                      },
                    },
                    {
                      text: prompt,
                    },
                  ],
                },
              ],
              config: {
                responseMimeType: "application/json",
                responseJsonSchema: geminiSourceExtractionJsonSchema,
                thinkingConfig: {
                  thinkingBudget: 128,
                },
              },
            });
            const text = response.text;

            if (!text) {
              throw new Error("Gemini returned no text.");
            }

            return {
              response,
              value: JSON.parse(text) as unknown,
            };
          },
        });
      },
    });
  };
}

function createOpenRouterSourceTextExtractor({
  apiKey,
  baseUrl,
  model,
}: OpenRouterFallbackConfig): SourceTextExtractor {
  return async (input) =>
    normalizeOpenRouterSourceTextExtraction(await runOpenRouterJsonChatCompletion({
      apiKey,
      baseUrl,
      model,
      metadata: {
        promptChars: buildSourceExtractionPrompt(input).length,
        schemaName: "openRouterSourceExtractionJsonSchema",
        media: {
          count: 1,
          totalBytes: input.bytes.length,
          mimeTypes: [input.mimeType],
        },
      },
      operation: "source text extraction",
      responseJsonSchema: openRouterSourceExtractionJsonSchema,
      responseJsonSchemaName: "sourceTextExtraction",
      messages: [
        {
          role: "system",
          content: "You extract learning material for LearnRecur. Return only a valid JSON object.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildSourceExtractionPrompt(input),
            },
            buildOpenRouterSourceMediaPart({
              bytes: input.bytes,
              filename: input.originalName,
              mimeType: input.mimeType,
            }),
          ],
        },
      ],
    }));
}

function normalizeOpenRouterSourceTextExtraction(input: unknown): unknown {
  const record = getObjectRecord(input);

  if (!record) {
    return input;
  }

  const extractedText = readStringField(record, "extractedText")
    ?? readStringField(record, "sourceText")
    ?? readStringField(record, "text")
    ?? readStringField(record, "content");

  return extractedText ? { extractedText } : input;
}

function getSourceExtractionValidationLogDetails(input: unknown) {
  const record = getObjectRecord(input);
  const extractedText = record ? readStringField(record, "extractedText") : null;

  return {
    type: Array.isArray(input) ? "array" : typeof input,
    keys: record ? Object.keys(record).slice(0, 8) : [],
    extractedTextLength: extractedText?.length ?? null,
  };
}

function getObjectRecord(input: unknown): Record<string, unknown> | null {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : null;
}

function readStringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];

  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function buildSourceExtractionPrompt(input: SourceTextExtractorInput) {
  return [
    "Extract study text from this uploaded learning source for LearnRecur.",
    "Return only JSON with exactly this shape: {\"extractedText\":\"...\"}.",
    "Do not summarize, solve, or generate exercises.",
    "Extract the educational text that should guide later skill draft generation.",
    "The extractedText value must be the visible or embedded educational text, not commentary about the file.",
    "If the file is an image, read visible notes, worksheet text, diagrams labels, and captions.",
    "If the file is a PDF, extract the text most relevant to the study material.",
    "",
    `File name: ${input.originalName}`,
    `Source label: ${input.sourceLabel ?? "none"}`,
    `Focus note: ${input.focusNote ?? "none"}`,
  ].join("\n");
}

const geminiSourceExtractionJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["extractedText"],
  properties: {
    extractedText: {
      type: "string",
    },
  },
};

const openRouterSourceExtractionJsonSchema = geminiSourceExtractionJsonSchema;

function resolveUploadStorage(storage?: SourceUploadStorage):
  | {
      status: "ready";
      storage: SourceUploadStorage;
    }
  | {
      status: "missing-env";
      message: string;
    } {
  if (storage) {
    return {
      status: "ready",
      storage,
    };
  }

  return resolveS3SourceObjectStorage();
}

async function cleanupUploadedSource(
  sourceFile: {
    id: string;
    userId: string;
    storageBucket: string | null;
    storageKey: string | null;
  },
  storage: SourceUploadStorage | null,
) {
  if (storage && sourceFile.storageKey) {
    try {
      await storage.deleteObject({
        key: sourceFile.storageKey,
        bucket: sourceFile.storageBucket ?? undefined,
      });
    } catch {
      // Cleanup is best effort; the database row is still removed so the user
      // cannot keep referencing failed private study material.
    }
  }

  await getPrisma().sourceFile.deleteMany({
    where: {
      id: sourceFile.id,
      userId: sourceFile.userId,
    },
  });
}

async function cleanupUploadedSources(
  sourceFiles: Array<{
    id: string;
    userId: string;
    storageBucket: string | null;
    storageKey: string | null;
  }>,
  storage: SourceUploadStorage | null,
) {
  for (const sourceFile of sourceFiles) {
    await cleanupUploadedSource(sourceFile, storage);
  }
}

async function markUploadedSourceFailed(
  sourceFile: {
    id: string;
    userId: string;
    status: SourceFileStatus;
    byteSize: number | null;
    metadata: Prisma.JsonValue | null;
    storageBucket: string | null;
    storageKey: string | null;
  },
  storage: SourceUploadStorage | null,
  now: Date,
  reason: string,
  message: string,
  options: {
    retainStoredObject?: boolean;
  } = {},
) {
  const retainStoredObject = options.retainStoredObject ?? true;
  const prisma = getPrisma();

  await prisma.$transaction(async (tx) => {
    const markedFailed = await tx.sourceFile.updateMany({
      where: {
        id: sourceFile.id,
        userId: sourceFile.userId,
        status: sourceFile.status,
        storageBucket: sourceFile.storageBucket,
        storageKey: sourceFile.storageKey,
      },
      data: {
        status: SourceFileStatus.FAILED,
        byteSize: sourceFile.byteSize,
        publicUrl: null,
        metadata: buildFailedUploadMetadata(sourceFile.metadata, now, reason, message),
      },
    });

    if (markedFailed.count !== 1 || retainStoredObject) {
      return;
    }

    let deletedStoredObject = false;

    if (storage && sourceFile.storageKey) {
      try {
        await storage.deleteObject({
          key: sourceFile.storageKey,
          bucket: sourceFile.storageBucket ?? undefined,
        });
        deletedStoredObject = true;
      } catch {
        // Keep storage metadata when deletion fails so quota accounting and
        // explicit cleanup still have a row pointing at the object.
      }
    } else if (!sourceFile.storageKey) {
      deletedStoredObject = true;
    }

    if (!deletedStoredObject) {
      return;
    }

    await tx.sourceFile.updateMany({
      where: {
        id: sourceFile.id,
        userId: sourceFile.userId,
        status: SourceFileStatus.FAILED,
        storageBucket: sourceFile.storageBucket,
        storageKey: sourceFile.storageKey,
      },
      data: {
        byteSize: null,
        storageBucket: null,
        storageKey: null,
      },
    });
  });
}

async function markUploadedSourcesFailed(
  sourceFiles: Array<{
    id: string;
    userId: string;
    status: SourceFileStatus;
    byteSize: number | null;
    metadata: Prisma.JsonValue | null;
    storageBucket: string | null;
    storageKey: string | null;
  }>,
  storage: SourceUploadStorage | null,
  now: Date,
  reason: string,
  message: string,
  options: {
    retainStoredObject?: boolean;
    batchSourceFileIds?: string[];
  } = {},
) {
  for (const sourceFile of sourceFiles) {
    const metadata = options.batchSourceFileIds
      ? ({
          ...getMetadataObject(sourceFile.metadata),
          ...buildSourceUploadBatchMetadata(options.batchSourceFileIds),
        } as Prisma.JsonValue)
      : sourceFile.metadata;

    await markUploadedSourceFailed(
      {
        ...sourceFile,
        metadata,
      },
      storage,
      now,
      reason,
      message,
      options,
    );
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function buildUploadMetadata({
  normalized,
  model,
  now,
}: {
  normalized: NormalizedSourceUploadInput;
  model: string | null;
  now: Date;
}): Prisma.InputJsonObject {
  return {
    createdBy: SOURCE_UPLOAD_PROMPT_VERSION,
    draftPromptVersion: SOURCE_SKILL_DRAFT_PROMPT_VERSION,
    originalFileName: normalized.originalName,
    focusNote: normalized.focusNote,
    collectionName: normalized.collectionName,
    tags: normalized.tags,
    model,
    generatedAt: model ? now.toISOString() : null,
    preparedAt: now.toISOString(),
  };
}

function buildQueuedUploadMetadata(
  metadata: Prisma.JsonValue | null,
  now: Date,
  options: {
    batchSourceFileIds?: string[];
  } = {},
): Prisma.InputJsonObject {
  return {
    ...getMetadataObject(metadata),
    ...buildSourceUploadBatchMetadata(options.batchSourceFileIds),
    queuedAt: now.toISOString(),
  };
}

function buildProcessingUploadMetadata(
  metadata: Prisma.JsonValue | null,
  now: Date,
  options: {
    batchSourceFileIds?: string[];
  } = {},
): Prisma.InputJsonObject {
  return {
    ...getMetadataObject(metadata),
    ...buildSourceUploadBatchMetadata(options.batchSourceFileIds),
    processingStartedAt: now.toISOString(),
  };
}

function buildFailedUploadMetadata(
  metadata: Prisma.JsonValue | null,
  now: Date,
  reason: string,
  message: string,
): Prisma.InputJsonObject {
  return {
    ...getMetadataObject(metadata),
    failedAt: now.toISOString(),
    failureReason: reason,
    errorMessage: message.slice(0, 500),
  };
}

function buildSourceUploadBatchMetadata(sourceFileIds?: string[]): Prisma.InputJsonObject {
  const batchSourceFileIds = (sourceFileIds ?? [])
    .map((sourceFileId) => sourceFileId.trim())
    .filter(Boolean);

  if (batchSourceFileIds.length <= 1) {
    return {};
  }

  return {
    batchSourceFileIds,
  };
}

function sourceFileKindFromMimeType(mimeType: SourceUploadMimeType) {
  if (mimeType === "application/pdf") {
    return SourceFileKind.PDF;
  }

  return SourceFileKind.IMAGE;
}

function isAllowedSourceUploadMimeType(mimeType: string): mimeType is SourceUploadMimeType {
  return isSourceUploadMimeType(mimeType);
}

function isMissingStoredSourceObjectError(error: unknown): boolean {
  const maybeStorageError = error as {
    name?: unknown;
    Code?: unknown;
    code?: unknown;
    $metadata?: {
      httpStatusCode?: unknown;
    };
  };
  const codes = [maybeStorageError.name, maybeStorageError.Code, maybeStorageError.code];

  return (
    codes.some((code) => code === "NoSuchKey" || code === "NotFound") ||
    maybeStorageError.$metadata?.httpStatusCode === 404
  );
}

async function validateStoredSourceUpload(
  sourceFile: {
    storageBucket: string | null;
    storageKey: string | null;
    mimeType: string | null;
    byteSize: number | null;
  },
  storage: SourceUploadStorage,
): Promise<
  | {
      status: "ready";
      byteSize: number;
    }
  | {
      status: "invalid";
      message: string;
      retainStoredObject: boolean;
      byteSize?: number;
    }
> {
  if (!sourceFile.storageKey || !sourceFile.storageBucket || !sourceFile.mimeType) {
    return {
      status: "invalid",
      message: "Uploaded source metadata is incomplete.",
      retainStoredObject: false,
    };
  }

  if (!isAllowedSourceUploadMimeType(sourceFile.mimeType)) {
    return {
      status: "invalid",
      message: "Uploaded source MIME type is not supported.",
      retainStoredObject: false,
    };
  }

  let head;

  try {
    head = await storage.headObject({
      key: sourceFile.storageKey,
      bucket: sourceFile.storageBucket,
    });
  } catch (error) {
    if (isMissingStoredSourceObjectError(error)) {
      return {
        status: "invalid",
        message: "Uploaded file is missing or larger than 10 MB.",
        retainStoredObject: false,
      };
    }

    return {
      status: "invalid",
      message: `Could not verify S3 upload: ${formatEnvError(error)}`,
      retainStoredObject: true,
    };
  }

  const actualByteSize = head.byteSize ?? sourceFile.byteSize;

  if (!actualByteSize || actualByteSize > MAX_SOURCE_UPLOAD_BYTES) {
    return {
      status: "invalid",
      message: "Uploaded file is missing or larger than 10 MB.",
      retainStoredObject: false,
      ...(actualByteSize !== null && actualByteSize !== undefined
        ? { byteSize: actualByteSize }
        : {}),
    };
  }

  if (head.mimeType && head.mimeType !== sourceFile.mimeType) {
    return {
      status: "invalid",
      message: "Uploaded file type did not match the prepared upload.",
      retainStoredObject: false,
      byteSize: actualByteSize,
    };
  }

  return {
    status: "ready",
    byteSize: actualByteSize,
  };
}

function notCreated(
  reason: Extract<CompleteSourceUploadDraftsResult, { status: "not-created" }>["reason"],
  message: string,
): Extract<CompleteSourceUploadDraftsResult, { status: "not-created" }> {
  return {
    status: "not-created",
    reason,
    message,
  };
}

function notQueued(
  reason: Extract<QueueSourceUploadDraftsResult, { status: "not-queued" }>["reason"],
  message: string,
): Extract<QueueSourceUploadDraftsResult, { status: "not-queued" }> {
  return {
    status: "not-queued",
    reason,
    message,
  };
}

function requeueNotQueued(
  reason: Extract<RequeueSourceUploadDraftResult, { status: "not-queued" }>["reason"],
  message: string,
): Extract<RequeueSourceUploadDraftResult, { status: "not-queued" }> {
  return {
    status: "not-queued",
    reason,
    message,
  };
}

function queueFailureToCompletionReason(
  reason: Extract<QueueSourceUploadDraftsResult, { status: "not-queued" }>["reason"],
): Extract<CompleteSourceUploadDraftsResult, { status: "not-created" }>["reason"] {
  if (reason === "event-send-failed" || reason === "missing-inngest-env") {
    return "invalid-upload";
  }

  return reason;
}

function sourceUploadSourceNotFound(): Extract<
  CompleteSourceUploadDraftsResult,
  { status: "not-found" }
> {
  return {
    status: "not-found",
    reason: "source-not-found",
    message: "Uploaded source material was not found.",
  };
}

function optionalTrimmedString() {
  return z.preprocess((value) => {
    if (typeof value === "string" && value.trim() === "") {
      return undefined;
    }

    return value;
  }, z.string().trim().optional());
}

function sanitizeKeySegment(value: string) {
  return (
    value
      .trim()
      .replace(/[^A-Za-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 96) || "unknown"
  );
}

function sanitizeFileName(value: string) {
  const trimmed = value.trim().toLowerCase();
  const extensionMatch = trimmed.match(/\.([a-z0-9]{1,12})$/);
  const extension = extensionMatch?.[1] ?? "upload";
  const stem = extensionMatch ? trimmed.slice(0, -extension.length - 1) : trimmed;
  const sanitizedStem =
    stem
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "source";

  return `${sanitizedStem}.${extension}`;
}

function getMetadataObject(metadata: Prisma.JsonValue | null): Record<string, unknown> {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }

  return metadata as Record<string, unknown>;
}

function getMetadataString(metadata: Prisma.JsonValue | null, key: string): string | null {
  const value = getMetadataObject(metadata)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getMetadataStringArray(metadata: Prisma.JsonValue | null, key: string): string[] {
  const value = getMetadataObject(metadata)[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function isTransactionWriteConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034";
}
