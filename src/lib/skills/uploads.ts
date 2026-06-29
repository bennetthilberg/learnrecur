import "server-only";

import { GoogleGenAI } from "@google/genai";
import { z } from "zod";

import {
  Prisma,
  SourceFileKind,
  SourceFileStatus,
  type Skill,
} from "@/generated/prisma/client";
import { formatEnvError, getGeminiEnv } from "@/lib/env";
import {
  getGeminiErrorLogDetails,
  getPublicGeminiFailureMessage,
  runWithGeminiProviderFallback,
} from "@/lib/gemini";
import { getInngestEnvStatus } from "@/lib/inngest/client";
import {
  inngestSourceUploadDraftEventSender,
  type SourceUploadDraftEventSender,
} from "@/lib/inngest/events";
import { getPrisma } from "@/lib/prisma";
import { resolveOptionalQwenFallbackConfig } from "@/lib/qwen-fallback";
import {
  buildQwenImageDataUrl,
  runQwenJsonChatCompletion,
  type QwenFallbackConfig,
} from "@/lib/qwen";
import {
  SOURCE_SKILL_DRAFT_PROMPT_VERSION,
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
  SOURCE_UPLOAD_MAX_BYTES_ERROR,
  SOURCE_UPLOAD_MIME_TYPE_ERROR,
  isSourceUploadMimeType,
  type SourceUploadMimeType,
} from "@/lib/skills/source-upload-policy";
import { checkSourceUploadUsageLimit } from "@/lib/usage-limits";

export const SOURCE_UPLOAD_PREFIX = "source-uploads";
export const SOURCE_UPLOAD_PROMPT_VERSION = "source-upload-drafts-v0";
export const SOURCE_PROCESSING_STALE_AFTER_MS = 15 * 60 * 1000;
const SOURCE_UPLOAD_GENERATION_TIMEOUT_MS = 45_000;
export { MAX_SOURCE_UPLOAD_BYTES } from "@/lib/skills/source-upload-policy";

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
  sourceLabel: optionalTrimmedString().pipe(z.string().max(160).optional()),
  focusNote: optionalTrimmedString().pipe(z.string().max(800).optional()),
  collectionName: optionalTrimmedString(),
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
      reason: "not-failed" | "linked-source";
      message: string;
    };

export type CompleteSourceUploadDraftsResult =
  | {
      status: "created";
      skills: Skill[];
      sourceFileId: string;
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

export function isSourceUploadProcessingStale(
  metadata: Prisma.JsonValue | null,
  now: Date,
  staleAfterMs = SOURCE_PROCESSING_STALE_AFTER_MS,
): boolean {
  const startedAt = getMetadataString(metadata, "processingStartedAt");

  if (!startedAt) {
    return false;
  }

  const startedAtTime = Date.parse(startedAt);

  if (!Number.isFinite(startedAtTime)) {
    return false;
  }

  return now.getTime() - startedAtTime >= staleAfterMs;
}

export function buildSourceUploadRequeueMetadata(
  metadata: Prisma.JsonValue | null,
  now: Date,
): Prisma.InputJsonObject {
  const metadataObject = getMetadataObject(metadata);
  const retryCount = typeof metadataObject.retryCount === "number" ? metadataObject.retryCount : 0;
  const timestamp = now.toISOString();

  return {
    ...metadataObject,
    queuedAt: timestamp,
    requeuedAt: timestamp,
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

export async function completeSourceUploadDrafts(
  input: CompleteSourceUploadDraftsInput,
): Promise<CompleteSourceUploadDraftsResult> {
  const queued = await queueSourceUploadDrafts({
    userId: input.userId,
    sourceFileId: input.sourceFileId,
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

  return runQueuedSourceUploadDraftJob(input);
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
  } else if (sourceFile.status === SourceFileStatus.FAILED) {
    if (!isFailedSourceUploadRequeueable(sourceFile)) {
      return requeueNotQueued(
        "not-requeueable",
        "Only saved uploads without linked skills can be restarted.",
      );
    }
  } else if (sourceFile.status !== SourceFileStatus.UPLOADED) {
    return requeueNotQueued(
      "not-requeueable",
      "Only saved uploads with waiting, failed, or stuck preparation can be restarted.",
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

  const requeued = await prisma.sourceFile.updateMany({
    where: {
      id: sourceFile.id,
      userId: input.userId,
      status: sourceFile.status,
    },
    data: {
      status: SourceFileStatus.UPLOADED,
      byteSize: uploadValidation.byteSize,
      metadata: buildSourceUploadRequeueMetadata(sourceFile.metadata, input.now),
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
  _count: {
    skillRefs: number;
  };
}) {
  return (
    sourceFile.kind !== SourceFileKind.TEXT &&
    Boolean(sourceFile.storageKey) &&
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

  if (
    sourceFile.status !== SourceFileStatus.FAILED ||
    (sourceFile.kind !== SourceFileKind.IMAGE && sourceFile.kind !== SourceFileKind.PDF)
  ) {
    return {
      status: "not-dismissed",
      reason: "not-failed",
      message: "Only failed uploaded sources can be dismissed.",
    };
  }

  if (sourceFile._count.skillRefs > 0) {
    return {
      status: "not-dismissed",
      reason: "linked-source",
      message: "Linked source material cannot be dismissed from the processing list.",
    };
  }

  const deleted = await prisma.sourceFile.deleteMany({
    where: {
      id: sourceFile.id,
      userId: input.userId,
      status: SourceFileStatus.FAILED,
    },
  });

  if (deleted.count !== 1) {
    return sourceUploadSourceNotFound();
  }

  return {
    status: "dismissed",
    sourceFileId: sourceFile.id,
    message: "Failed source upload dismissed.",
  };
}

export async function runQueuedSourceUploadDraftJob(
  input: CompleteSourceUploadDraftsInput,
): Promise<CompleteSourceUploadDraftsResult> {
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
    );
    return notCreated("invalid-upload", "Uploaded source MIME type is not supported.");
  }

  const actualByteSize = sourceFile.byteSize;

  if (!actualByteSize || actualByteSize > MAX_SOURCE_UPLOAD_BYTES) {
    const message = "Uploaded file is missing or larger than 10 MB.";
    await markUploadedSourceFailed(sourceFile, storageSetup.storage, input.now, "invalid-upload", message);
    return notCreated("invalid-upload", message);
  }

  const lockedForProcessing = await prisma.sourceFile.updateMany({
    where: {
      id: sourceFile.id,
      userId: input.userId,
      status: SourceFileStatus.UPLOADED,
    },
    data: {
      status: SourceFileStatus.PROCESSING,
      metadata: buildProcessingUploadMetadata(sourceFile.metadata, input.now),
    },
  });

  if (lockedForProcessing.count !== 1) {
    return notCreated("invalid-upload", "This upload has already been processed or is processing.");
  }

  const setup = resolveUploadGenerationSetup(input);

  if (setup.status === "missing-env") {
    await markUploadedSourceFailed(
      sourceFile,
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
    const message = isSourceObjectSizeLimitError(error)
      ? "Uploaded file is missing or larger than 10 MB."
      : `Could not read S3 upload: ${formatEnvError(error)}`;
    await markUploadedSourceFailed(
      sourceFile,
      storageSetup.storage,
      input.now,
      "invalid-upload",
      message,
    );
    return notCreated("invalid-upload", message);
  }

  if (bytes.length === 0 || bytes.length > MAX_SOURCE_UPLOAD_BYTES) {
    const message = "Uploaded file is missing or larger than 10 MB.";
    await markUploadedSourceFailed(
      sourceFile,
      storageSetup.storage,
      input.now,
      "invalid-upload",
      message,
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
      sourceFile,
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
      sourceFile,
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
      }),
      SOURCE_UPLOAD_GENERATION_TIMEOUT_MS,
      "generateSkillDraft timed out",
    );
  } catch (error) {
    const message = getPublicGeminiFailureMessage(error);
    console.error("[ai] source draft generation failed", getGeminiErrorLogDetails(error));
    await markUploadedSourceFailed(
      sourceFile,
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
      sourceFile,
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
      sourceFile,
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

  let env: ReturnType<typeof getGeminiEnv>;

  try {
    env = getGeminiEnv();
  } catch (error) {
    return {
      status: "missing-env",
      model: input.model ?? (process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash"),
      message: formatEnvError(error),
    };
  }

  const qwenFallbackResult = resolveOptionalQwenFallbackConfig();
  const qwenFallback =
    qwenFallbackResult.status === "ready" ? qwenFallbackResult.config : null;

  if (qwenFallbackResult.status === "invalid") {
    console.warn("[ai] qwen fallback disabled for upload generation", {
      message: qwenFallbackResult.message,
    });
  }

  return {
    status: "ready",
    model: env.GEMINI_MODEL,
    extractSourceText: input.extractSourceText ?? createGeminiSourceTextExtractor({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      qwenFallback,
    }),
    generateSkillDraft: input.generateSkillDraft ?? createGeminiSkillDraftGenerator({
      apiKey: env.GEMINI_API_KEY,
      model: env.GEMINI_MODEL,
      qwenFallback,
    }),
  };
}

function createGeminiSourceTextExtractor({
  apiKey,
  model,
  qwenFallback,
}: {
  apiKey: string;
  model: string;
  qwenFallback?: QwenFallbackConfig | null;
}): SourceTextExtractor {
  return async (input) => {
    const ai = new GoogleGenAI({ apiKey });
    const qwenSourceFallback =
      qwenFallback && input.mimeType.startsWith("image/")
        ? {
            provider: "qwen",
            model: qwenFallback.model,
            run: () => createQwenSourceTextExtractor(qwenFallback)(input),
          }
        : null;

    return runWithGeminiProviderFallback({
      fallback: qwenSourceFallback,
      operation: "source text extraction",
      primaryModel: model,
      runPrimary: async () => {
        const response = await ai.models.generateContent({
          model,
          contents: [
            {
              inlineData: {
                data: input.bytes.toString("base64"),
                mimeType: input.mimeType,
              },
            },
            {
              text: buildSourceExtractionPrompt(input),
            },
          ],
          config: {
            responseMimeType: "application/json",
            responseJsonSchema: geminiSourceExtractionJsonSchema,
          },
        });
        const text = response.text;

        if (!text) {
          throw new Error("Gemini returned no text.");
        }

        return JSON.parse(text) as unknown;
      },
    });
  };
}

function createQwenSourceTextExtractor({
  apiKey,
  baseUrl,
  model,
}: QwenFallbackConfig): SourceTextExtractor {
  return async (input) =>
    normalizeQwenSourceTextExtraction(await runQwenJsonChatCompletion({
      apiKey,
      baseUrl,
      model,
      operation: "source text extraction",
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
            {
              type: "image_url",
              image_url: {
                url: buildQwenImageDataUrl(input.bytes, input.mimeType),
              },
            },
          ],
        },
      ],
    }));
}

function normalizeQwenSourceTextExtraction(input: unknown): unknown {
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

async function markUploadedSourceFailed(
  sourceFile: {
    id: string;
    userId: string;
    metadata: Prisma.JsonValue | null;
    storageBucket: string | null;
    storageKey: string | null;
  },
  storage: SourceUploadStorage | null,
  now: Date,
  reason: string,
  message: string,
) {
  void storage;

  await getPrisma().sourceFile.updateMany({
    where: {
      id: sourceFile.id,
      userId: sourceFile.userId,
    },
    data: {
      status: SourceFileStatus.FAILED,
      publicUrl: null,
      metadata: buildFailedUploadMetadata(sourceFile.metadata, now, reason, message),
    },
  });
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
): Prisma.InputJsonObject {
  return {
    ...getMetadataObject(metadata),
    queuedAt: now.toISOString(),
  };
}

function buildProcessingUploadMetadata(
  metadata: Prisma.JsonValue | null,
  now: Date,
): Prisma.InputJsonObject {
  return {
    ...getMetadataObject(metadata),
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

function sourceFileKindFromMimeType(mimeType: SourceUploadMimeType) {
  if (mimeType === "application/pdf") {
    return SourceFileKind.PDF;
  }

  return SourceFileKind.IMAGE;
}

function isAllowedSourceUploadMimeType(mimeType: string): mimeType is SourceUploadMimeType {
  return isSourceUploadMimeType(mimeType);
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
    }
> {
  if (!sourceFile.storageKey || !sourceFile.storageBucket || !sourceFile.mimeType) {
    return {
      status: "invalid",
      message: "Uploaded source metadata is incomplete.",
    };
  }

  if (!isAllowedSourceUploadMimeType(sourceFile.mimeType)) {
    return {
      status: "invalid",
      message: "Uploaded source MIME type is not supported.",
    };
  }

  let head;

  try {
    head = await storage.headObject({
      key: sourceFile.storageKey,
      bucket: sourceFile.storageBucket,
    });
  } catch (error) {
    return {
      status: "invalid",
      message: `Could not verify S3 upload: ${formatEnvError(error)}`,
    };
  }

  const actualByteSize = head.byteSize ?? sourceFile.byteSize;

  if (!actualByteSize || actualByteSize > MAX_SOURCE_UPLOAD_BYTES) {
    return {
      status: "invalid",
      message: "Uploaded file is missing or larger than 10 MB.",
    };
  }

  if (head.mimeType && head.mimeType !== sourceFile.mimeType) {
    return {
      status: "invalid",
      message: "Uploaded file type did not match the prepared upload.",
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
