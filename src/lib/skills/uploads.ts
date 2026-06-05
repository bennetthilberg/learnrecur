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
import { getPrisma } from "@/lib/prisma";
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
  resolveS3SourceObjectStorage,
  type SourceObjectStorage,
} from "@/lib/storage/s3";

export const MAX_SOURCE_UPLOAD_BYTES = 10 * 1024 * 1024;
export const SOURCE_UPLOAD_PREFIX = "source-uploads";
export const SOURCE_UPLOAD_PROMPT_VERSION = "source-upload-drafts-v0";

const allowedSourceUploadMimeTypes = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "application/pdf",
] as const;

const sourceUploadInputSchema = z.strictObject({
  originalName: z.string().trim().min(1, "Choose a file to upload.").max(220),
  mimeType: z
    .string()
    .trim()
    .refine(
      (mimeType): mimeType is SourceUploadMimeType =>
        allowedSourceUploadMimeTypes.includes(mimeType as SourceUploadMimeType),
      "Upload a PNG, JPEG, WebP, or PDF file.",
    ),
  byteSize: z.coerce
    .number()
    .int()
    .positive("Upload a non-empty file.")
    .max(MAX_SOURCE_UPLOAD_BYTES, "Upload a file smaller than 10 MB."),
  sourceLabel: optionalTrimmedString().pipe(z.string().max(160).optional()),
  focusNote: optionalTrimmedString().pipe(z.string().max(800).optional()),
  collectionName: optionalTrimmedString(),
  tags: z.union([z.string(), z.array(z.string())]).optional(),
});

const extractedSourceTextSchema = z.strictObject({
  extractedText: z.string().trim().min(40).max(80_000),
});

type SourceUploadMimeType = (typeof allowedSourceUploadMimeTypes)[number];

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
      reason: "missing-s3-env" | "storage-failed";
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

export function validateExtractedSourceText(input: unknown): ExtractedSourceTextValidationResult {
  const result = extractedSourceTextSchema.safeParse(input);

  if (!result.success) {
    return {
      status: "invalid",
      reason: "invalid-response",
      message: "Gemini could not extract enough study text from this file.",
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

  const prisma = getPrisma();
  const sourceFile = await prisma.sourceFile.create({
    data: {
      userId: input.userId,
      kind: sourceFileKindFromMimeType(normalized.value.mimeType),
      status: SourceFileStatus.DRAFT,
      originalName: normalized.value.sourceLabel ?? normalized.value.originalName,
      mimeType: normalized.value.mimeType,
      byteSize: normalized.value.byteSize,
      storageBucket: storageSetup.storage.bucketName,
      metadata: buildUploadMetadata({
        normalized: normalized.value,
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
    originalName: normalized.value.originalName,
  });

  await prisma.sourceFile.update({
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

  try {
    const expiresInSeconds = 600;
    const uploadUrl = await storageSetup.storage.createPresignedUploadUrl({
      key: objectKey,
      mimeType: normalized.value.mimeType,
      expiresInSeconds,
    });

    return {
      status: "prepared",
      sourceFileId: sourceFile.id,
      uploadUrl,
      objectKey,
      headers: {
        "Content-Type": normalized.value.mimeType,
      },
      expiresInSeconds,
    };
  } catch (error) {
    await prisma.sourceFile.deleteMany({
      where: {
        id: sourceFile.id,
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

export async function completeSourceUploadDrafts(
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

  if (sourceFile.status !== SourceFileStatus.DRAFT) {
    return notCreated("invalid-upload", "This upload has already been processed or is processing.");
  }

  const storageSetup = resolveUploadStorage(input.storage);

  if (storageSetup.status === "missing-env") {
    await cleanupUploadedSource(sourceFile, null);
    return notCreated("missing-s3-env", storageSetup.message);
  }

  if (!sourceFile.storageKey || !sourceFile.storageBucket || !sourceFile.mimeType) {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notCreated("invalid-upload", "Uploaded source metadata is incomplete.");
  }

  if (!isAllowedSourceUploadMimeType(sourceFile.mimeType)) {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notCreated("invalid-upload", "Uploaded source MIME type is not supported.");
  }

  const lockedForProcessing = await prisma.sourceFile.updateMany({
    where: {
      id: sourceFile.id,
      userId: input.userId,
      status: SourceFileStatus.DRAFT,
    },
    data: {
      status: SourceFileStatus.PROCESSING,
    },
  });

  if (lockedForProcessing.count !== 1) {
    return notCreated("invalid-upload", "This upload has already been processed or is processing.");
  }

  let head;

  try {
    head = await storageSetup.storage.headObject({ key: sourceFile.storageKey });
  } catch (error) {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notCreated("invalid-upload", `Could not verify S3 upload: ${formatEnvError(error)}`);
  }

  const actualByteSize = head.byteSize ?? sourceFile.byteSize;

  if (!actualByteSize || actualByteSize > MAX_SOURCE_UPLOAD_BYTES) {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notCreated("invalid-upload", "Uploaded file is missing or larger than 10 MB.");
  }

  if (head.mimeType && head.mimeType !== sourceFile.mimeType) {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notCreated("invalid-upload", "Uploaded file type did not match the prepared upload.");
  }

  await prisma.sourceFile.update({
    where: {
      id_userId: {
        id: sourceFile.id,
        userId: input.userId,
      },
    },
    data: {
      byteSize: actualByteSize,
    },
  });

  const setup = resolveUploadGenerationSetup(input);

  if (setup.status === "missing-env") {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notCreated("missing-gemini-env", setup.message);
  }

  let bytes: Buffer;

  try {
    bytes = await storageSetup.storage.getObjectBytes({ key: sourceFile.storageKey });
  } catch (error) {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notCreated("invalid-upload", `Could not read S3 upload: ${formatEnvError(error)}`);
  }

  let rawExtraction: unknown;

  try {
    rawExtraction = await setup.extractSourceText({
      bytes,
      mimeType: sourceFile.mimeType,
      originalName: getMetadataString(sourceFile.metadata, "originalFileName") ?? sourceFile.originalName,
      sourceLabel: sourceFile.originalName,
      focusNote: getMetadataString(sourceFile.metadata, "focusNote"),
    });
  } catch (error) {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notCreated(
      "extraction-failed",
      `Gemini source extraction failed: ${formatEnvError(error)}`,
    );
  }

  const extraction = validateExtractedSourceText(rawExtraction);

  if (extraction.status === "invalid") {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notCreated("invalid-extraction", extraction.message);
  }

  let rawDraftGeneration: unknown;

  try {
    rawDraftGeneration = await setup.generateSkillDraft({
      sourceText: extraction.extractedText,
      sourceLabel: sourceFile.originalName,
      focusNote: getMetadataString(sourceFile.metadata, "focusNote"),
      collectionName: getMetadataString(sourceFile.metadata, "collectionName"),
      tags: getMetadataStringArray(sourceFile.metadata, "tags"),
      sourceContext: extraction.extractedText,
    });
  } catch (error) {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
    return notCreated(
      "generation-failed",
      `Gemini skill draft generation failed: ${formatEnvError(error)}`,
    );
  }

  const generatedDrafts = validateGeneratedSkillDrafts(rawDraftGeneration);

  if (generatedDrafts.status === "invalid") {
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
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
    await cleanupUploadedSource(sourceFile, storageSetup.storage);
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

  try {
    const env = getGeminiEnv();

    return {
      status: "ready",
      model: env.GEMINI_MODEL,
      extractSourceText: input.extractSourceText ?? createGeminiSourceTextExtractor({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
      }),
      generateSkillDraft: input.generateSkillDraft ?? createGeminiSkillDraftGenerator({
        apiKey: env.GEMINI_API_KEY,
        model: env.GEMINI_MODEL,
      }),
    };
  } catch (error) {
    return {
      status: "missing-env",
      model: input.model ?? (process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash"),
      message: formatEnvError(error),
    };
  }
}

function createGeminiSourceTextExtractor({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}): SourceTextExtractor {
  return async (input) => {
    const ai = new GoogleGenAI({ apiKey });
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
  };
}

function buildSourceExtractionPrompt(input: SourceTextExtractorInput) {
  return [
    "Extract study text from this uploaded learning source for LearnRecur.",
    "Return only JSON matching the provided response schema.",
    "Do not summarize, solve, or generate exercises.",
    "Extract the educational text that should guide later skill draft generation.",
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
    storageKey: string | null;
  },
  storage: SourceUploadStorage | null,
) {
  if (storage && sourceFile.storageKey) {
    try {
      await storage.deleteObject({ key: sourceFile.storageKey });
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

function sourceFileKindFromMimeType(mimeType: SourceUploadMimeType) {
  if (mimeType === "application/pdf") {
    return SourceFileKind.PDF;
  }

  return SourceFileKind.IMAGE;
}

function isAllowedSourceUploadMimeType(mimeType: string): mimeType is SourceUploadMimeType {
  return allowedSourceUploadMimeTypes.includes(mimeType as SourceUploadMimeType);
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
