import "server-only";

import { createHash, randomUUID } from "node:crypto";

import {
  MaterialPageTextStatus,
  MaterialRevisionStatus,
  Prisma,
  SourceFileKind,
  SourceFileStatus,
  StudyMaterialKind,
  StudyMaterialStatus,
} from "@/generated/prisma/client";
import { getInngestEnvStatus } from "@/lib/inngest/client";
import {
  inngestMaterialIngestionEventSender,
  type MaterialIngestionEventSender,
} from "@/lib/inngest/events";
import {
  MAX_MATERIAL_PDF_BYTES,
  MAX_MATERIAL_PDF_PAGES,
  MAX_WEBSITE_REVISION_BYTES,
  confirmWebsiteImportInputSchema,
  prepareMaterialPdfInputSchema,
} from "@/lib/materials/contracts";
import {
  createGeminiMaterialEmbeddingGenerator,
  type MaterialEmbeddingGenerator,
} from "@/lib/materials/embeddings";
import {
  createNextMaterialRevision,
  finalizeMaterialRevision,
} from "@/lib/materials/lifecycle";
import {
  buildPdfIndex,
  chunkSectionText,
  estimateTokens,
  extractPdfPages,
  type ExtractedPdfPage,
} from "@/lib/materials/pdf";
import { storeMaterialChunkEmbedding } from "@/lib/materials/retrieval";
import {
  extractReadableWebPage,
  fetchPublicWebResource,
  validatePublicHttpsUrl,
  type FetchWebResource,
  type ResolveHostname,
} from "@/lib/materials/web";
import { getPrisma } from "@/lib/prisma";
import {
  resolveS3SourceObjectStorage,
  type SourceObjectStorage,
} from "@/lib/storage/s3";
import {
  checkSourceStorageUsageLimit,
} from "@/lib/usage-limits";

const MATERIAL_STORAGE_PREFIX = "materials";
const MATERIAL_EMBEDDING_BATCH_SIZE = 32;
const MATERIAL_SOURCE_EXCERPT_LIMIT = 4_000;
const MATERIAL_WEBSITE_FETCH_CONCURRENCY = 16;
const MATERIAL_WEBSITE_PAGE_FETCH_BYTES = 5 * 1024 * 1024;

export class MaterialIngestionError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "MaterialIngestionError";
    this.retryable = options.retryable;
  }
}

export type PrepareMaterialPdfResult =
  | {
      status: "prepared";
      materialId: string;
      materialRevisionId: string;
      sourceFileId: string;
      uploadUrl: string;
      headers: Record<string, string>;
      expiresInSeconds: number;
    }
  | {
      status: "invalid" | "not-prepared";
      message: string;
      fieldErrors?: Record<string, string[]>;
    };

export type QueueMaterialIngestionResult =
  | {
      status: "queued";
      materialId: string;
      materialRevisionId: string;
      message: string;
    }
  | {
      status: "not-found" | "not-queued";
      message: string;
    };

export async function prepareMaterialPdf(input: {
  userId: string;
  now: Date;
  input: unknown;
  storage?: SourceObjectStorage;
}): Promise<PrepareMaterialPdfResult> {
  const parsed = prepareMaterialPdfInputSchema.safeParse(input.input);
  if (!parsed.success) {
    return {
      status: "invalid",
      message: "PDF details need a little attention.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }

  const storageSetup = resolveMaterialStorage(input.storage);
  if (storageSetup.status === "missing-env") {
    return { status: "not-prepared", message: storageSetup.message };
  }

  const prisma = getPrisma();
  const created = await prisma.$transaction(
    async (tx) => {
      const quota = await checkSourceStorageUsageLimit({
        userId: input.userId,
        byteSize: parsed.data.byteSize,
        prisma: tx,
      });
      if (quota.status === "limited") {
        return { status: "limited" as const, message: quota.message };
      }

      const material = await tx.studyMaterial.create({
        data: {
          userId: input.userId,
          collectionId: parsed.data.collectionId ?? null,
          title: parsed.data.title,
          kind: StudyMaterialKind.PDF,
        },
        select: { id: true },
      });
      const revision = await tx.materialRevision.create({
        data: {
          userId: input.userId,
          materialId: material.id,
          revisionNumber: 1,
          storageBucket: storageSetup.storage.bucketName,
        },
        select: { id: true },
      });
      const objectKey = buildMaterialObjectKey({
        userId: input.userId,
        materialId: material.id,
        materialRevisionId: revision.id,
        fileName: parsed.data.originalName,
      });
      const sourceFile = await tx.sourceFile.create({
        data: {
          userId: input.userId,
          collectionId: parsed.data.collectionId ?? null,
          materialRevisionId: revision.id,
          kind: SourceFileKind.PDF,
          status: SourceFileStatus.DRAFT,
          originalName: parsed.data.originalName,
          mimeType: parsed.data.mimeType,
          byteSize: parsed.data.byteSize,
          storageBucket: storageSetup.storage.bucketName,
          storageKey: objectKey,
        },
        select: { id: true },
      });
      await tx.materialRevision.update({
        where: { id: revision.id },
        data: { storageKey: objectKey },
      });

      return {
        status: "created" as const,
        materialId: material.id,
        materialRevisionId: revision.id,
        sourceFileId: sourceFile.id,
        objectKey,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  if (created.status === "limited") {
    return { status: "not-prepared", message: created.message };
  }

  try {
    const expiresInSeconds = 600;
    const uploadUrl = await storageSetup.storage.createPresignedUploadUrl({
      key: created.objectKey,
      mimeType: parsed.data.mimeType,
      byteSize: parsed.data.byteSize,
      maxBytes: MAX_MATERIAL_PDF_BYTES,
      expiresInSeconds,
    });

    return {
      status: "prepared",
      materialId: created.materialId,
      materialRevisionId: created.materialRevisionId,
      sourceFileId: created.sourceFileId,
      uploadUrl,
      headers: {
        "Content-Type": parsed.data.mimeType,
        "Content-Length": String(parsed.data.byteSize),
      },
      expiresInSeconds,
    };
  } catch (error) {
    await prisma.studyMaterial.deleteMany({
      where: { id: created.materialId, userId: input.userId },
    });
    return {
      status: "not-prepared",
      message: error instanceof Error ? error.message : "Could not prepare the private PDF upload.",
    };
  }
}

export async function discardPreparedMaterialPdf(input: {
  userId: string;
  materialId: string;
  materialRevisionId: string;
  storage?: SourceObjectStorage;
}) {
  const prisma = getPrisma();
  const claimed = await prisma.$transaction(async (tx) => {
    const revision = await tx.materialRevision.findFirst({
      where: {
        id: input.materialRevisionId,
        materialId: input.materialId,
        userId: input.userId,
        status: MaterialRevisionStatus.PENDING_UPLOAD,
        material: { kind: StudyMaterialKind.PDF },
      },
      select: {
        id: true,
        sourceFiles: {
          where: { kind: SourceFileKind.PDF },
          take: 1,
          select: { id: true, storageBucket: true, storageKey: true },
        },
      },
    });
    const sourceFile = revision?.sourceFiles[0];
    if (!revision || !sourceFile) {
      return null;
    }

    const claimedRevision = await tx.materialRevision.updateMany({
      where: {
        id: revision.id,
        materialId: input.materialId,
        userId: input.userId,
        status: MaterialRevisionStatus.PENDING_UPLOAD,
      },
      data: {
        status: MaterialRevisionStatus.FAILED,
        errorCode: "UPLOAD_ABANDONED",
        errorMessage: "The private PDF upload did not finish.",
      },
    });
    if (claimedRevision.count !== 1) {
      return null;
    }

    await tx.sourceFile.updateMany({
      where: {
        id: sourceFile.id,
        userId: input.userId,
        materialRevisionId: revision.id,
        status: SourceFileStatus.DRAFT,
      },
      data: { status: SourceFileStatus.FAILED },
    });

    return sourceFile;
  });

  if (!claimed) {
    return { status: "already-handled" as const };
  }

  const storageSetup = resolveMaterialStorage(input.storage);
  if (storageSetup.status === "missing-env") {
    return {
      status: "retained" as const,
      message:
        "The upload failed and the material was marked for attention, but storage cleanup is unavailable.",
    };
  }

  try {
    if (claimed.storageKey && claimed.storageBucket) {
      await storageSetup.storage.deleteObject({
        key: claimed.storageKey,
        bucket: claimed.storageBucket,
      });
    }
  } catch {
    return {
      status: "retained" as const,
      message:
        "The upload failed and the material was marked for attention because storage cleanup did not finish.",
    };
  }

  const deletedMaterial = await prisma.studyMaterial.deleteMany({
    where: {
      id: input.materialId,
      userId: input.userId,
      activeRevisionId: null,
      revisions: {
        every: {
          id: input.materialRevisionId,
          status: MaterialRevisionStatus.FAILED,
          errorCode: "UPLOAD_ABANDONED",
        },
      },
    },
  });

  return deletedMaterial.count === 1
    ? { status: "discarded" as const }
    : {
        status: "retained" as const,
        message:
          "The upload failed and was marked for attention because the material changed during cleanup.",
      };
}

export async function queueMaterialPdfIngestion(input: {
  userId: string;
  materialRevisionId: string;
  now: Date;
  storage?: SourceObjectStorage;
  eventSender?: MaterialIngestionEventSender;
}): Promise<QueueMaterialIngestionResult> {
  const envStatus = getInngestEnvStatus();
  if (envStatus.status === "missing-env" && !input.eventSender) {
    return { status: "not-queued", message: envStatus.message };
  }
  const storageSetup = resolveMaterialStorage(input.storage);
  if (storageSetup.status === "missing-env") {
    return { status: "not-queued", message: storageSetup.message };
  }

  const prisma = getPrisma();
  const revision = await prisma.materialRevision.findFirst({
    where: {
      id: input.materialRevisionId,
      userId: input.userId,
      status: {
        in: [
          MaterialRevisionStatus.PENDING_UPLOAD,
          MaterialRevisionStatus.QUEUED,
          MaterialRevisionStatus.PROCESSING,
          MaterialRevisionStatus.READY,
        ],
      },
      material: { kind: StudyMaterialKind.PDF },
    },
    select: {
      id: true,
      materialId: true,
      status: true,
      sourceFiles: {
        where: { kind: SourceFileKind.PDF },
        take: 1,
        select: {
          id: true,
          byteSize: true,
          mimeType: true,
          storageBucket: true,
          storageKey: true,
        },
      },
    },
  });
  const sourceFile = revision?.sourceFiles[0];
  if (!revision || !sourceFile?.storageKey || !sourceFile.storageBucket) {
    return { status: "not-found", message: "Material PDF upload was not found." };
  }
  if (revision.status !== MaterialRevisionStatus.PENDING_UPLOAD) {
    return {
      status: "queued",
      materialId: revision.materialId,
      materialRevisionId: revision.id,
      message:
        revision.status === MaterialRevisionStatus.READY
          ? "Material is already ready."
          : "Material processing has already started.",
    };
  }

  try {
    const head = await storageSetup.storage.headObject({
      key: sourceFile.storageKey,
      bucket: sourceFile.storageBucket,
    });
    if (head.byteSize !== sourceFile.byteSize || head.mimeType?.split(";")[0] !== "application/pdf") {
      return {
        status: "not-queued",
        message: "The uploaded PDF did not match the prepared file. Choose it again.",
      };
    }
  } catch {
    return {
      status: "not-queued",
      message: "The private PDF upload could not be verified. Try uploading it again.",
    };
  }

  await prisma.$transaction([
    prisma.materialRevision.update({
      where: { id: revision.id },
      data: { status: MaterialRevisionStatus.QUEUED, errorCode: null, errorMessage: null },
    }),
    prisma.sourceFile.update({
      where: { id: sourceFile.id },
      data: { status: SourceFileStatus.UPLOADED },
    }),
  ]);

  try {
    await (input.eventSender ?? inngestMaterialIngestionEventSender).sendMaterialIngestionRequested({
      userId: input.userId,
      materialRevisionId: revision.id,
      requestedAt: input.now.toISOString(),
    });
  } catch {
    await prisma.materialRevision.update({
      where: { id: revision.id },
      data: {
        status: MaterialRevisionStatus.FAILED,
        errorCode: "EVENT_SEND_FAILED",
        errorMessage: "Background processing could not be queued.",
      },
    });
    return {
      status: "not-queued",
      message: "Background processing could not be queued. Try again.",
    };
  }

  return {
    status: "queued",
    materialId: revision.materialId,
    materialRevisionId: revision.id,
    message: "PDF uploaded. LearnRecur is building its outline.",
  };
}

export async function queueWebsiteMaterialImport(input: {
  userId: string;
  now: Date;
  input: unknown;
  storage?: SourceObjectStorage;
  eventSender?: MaterialIngestionEventSender;
}): Promise<QueueMaterialIngestionResult | { status: "invalid"; message: string; fieldErrors: Record<string, string[]> }> {
  const parsed = confirmWebsiteImportInputSchema.safeParse(input.input);
  if (!parsed.success) {
    return {
      status: "invalid",
      message: "Website import details need a little attention.",
      fieldErrors: parsed.error.flatten().fieldErrors,
    };
  }
  const source = new URL(parsed.data.sourceUrl);
  const selectedUrls = [...new Set(parsed.data.selectedUrls)];
  if (selectedUrls.some((value) => new URL(value).origin !== source.origin)) {
    return {
      status: "invalid",
      message: "Website pages must come from the same textbook site.",
      fieldErrors: { selectedUrls: ["Choose only pages from the discovered textbook."] },
    };
  }

  const storageSetup = resolveMaterialStorage(input.storage);
  if (storageSetup.status === "missing-env") {
    return { status: "not-queued", message: storageSetup.message };
  }
  const envStatus = getInngestEnvStatus();
  if (envStatus.status === "missing-env" && !input.eventSender) {
    return { status: "not-queued", message: envStatus.message };
  }

  const prisma = getPrisma();
  const created = await prisma.$transaction(async (tx) => {
    const material = await tx.studyMaterial.create({
      data: {
        userId: input.userId,
        collectionId: parsed.data.collectionId ?? null,
        title: parsed.data.title,
        kind: StudyMaterialKind.WEB,
      },
      select: { id: true },
    });
    const revision = await tx.materialRevision.create({
      data: {
        userId: input.userId,
        materialId: material.id,
        revisionNumber: 1,
        status: MaterialRevisionStatus.QUEUED,
        sourceUrl: parsed.data.sourceUrl,
        storageBucket: storageSetup.storage.bucketName,
      },
      select: { id: true },
    });
    const storageKey = buildMaterialObjectKey({
      userId: input.userId,
      materialId: material.id,
      materialRevisionId: revision.id,
      fileName: "website-snapshot.json",
    });
    const sourceFile = await tx.sourceFile.create({
      data: {
        userId: input.userId,
        collectionId: parsed.data.collectionId ?? null,
        materialRevisionId: revision.id,
        kind: SourceFileKind.URL,
        status: SourceFileStatus.UPLOADED,
        originalName: parsed.data.title,
        mimeType: "application/json",
        storageBucket: storageSetup.storage.bucketName,
        storageKey,
        metadata: {
          sourceUrl: parsed.data.sourceUrl,
          selectedUrls,
        },
      },
      select: { id: true },
    });
    await tx.materialRevision.update({
      where: { id: revision.id },
      data: { storageKey },
    });
    return { materialId: material.id, materialRevisionId: revision.id, sourceFileId: sourceFile.id };
  });

  try {
    await (input.eventSender ?? inngestMaterialIngestionEventSender).sendMaterialIngestionRequested({
      userId: input.userId,
      materialRevisionId: created.materialRevisionId,
      requestedAt: input.now.toISOString(),
    });
  } catch {
    await prisma.$transaction([
      prisma.materialRevision.update({
        where: { id: created.materialRevisionId },
        data: {
          status: MaterialRevisionStatus.FAILED,
          errorCode: "EVENT_SEND_FAILED",
          errorMessage: "Background processing could not be queued.",
        },
      }),
      prisma.sourceFile.update({
        where: { id: created.sourceFileId },
        data: { status: SourceFileStatus.FAILED },
      }),
    ]);
    return { status: "not-queued", message: "Background processing could not be queued. Try again." };
  }

  return {
    status: "queued",
    materialId: created.materialId,
    materialRevisionId: created.materialRevisionId,
    message: "Website pages saved for import. LearnRecur is building the outline.",
  };
}

export async function retryMaterialIngestion(input: {
  userId: string;
  materialRevisionId: string;
  now: Date;
  eventSender?: MaterialIngestionEventSender;
}): Promise<QueueMaterialIngestionResult> {
  const prisma = getPrisma();
  const revision = await prisma.materialRevision.findFirst({
    where: {
      id: input.materialRevisionId,
      userId: input.userId,
      status: MaterialRevisionStatus.FAILED,
    },
    select: { id: true, materialId: true },
  });
  if (!revision) {
    return { status: "not-found", message: "Failed material revision was not found." };
  }

  await prisma.materialRevision.update({
    where: { id: revision.id },
    data: { status: MaterialRevisionStatus.QUEUED, errorCode: null, errorMessage: null },
  });
  try {
    await (input.eventSender ?? inngestMaterialIngestionEventSender).sendMaterialIngestionRequested({
      userId: input.userId,
      materialRevisionId: revision.id,
      requestedAt: input.now.toISOString(),
    });
  } catch {
    await prisma.materialRevision.update({
      where: { id: revision.id },
      data: { status: MaterialRevisionStatus.FAILED, errorCode: "EVENT_SEND_FAILED" },
    });
    return { status: "not-queued", message: "Background processing could not be queued. Try again." };
  }

  return {
    status: "queued",
    materialId: revision.materialId,
    materialRevisionId: revision.id,
    message: "Material processing queued again.",
  };
}

export async function queueWebsiteMaterialRefresh(input: {
  userId: string;
  materialId: string;
  now: Date;
  storage?: SourceObjectStorage;
  eventSender?: MaterialIngestionEventSender;
}): Promise<QueueMaterialIngestionResult> {
  const storageSetup = resolveMaterialStorage(input.storage);
  if (storageSetup.status === "missing-env") {
    return { status: "not-queued", message: storageSetup.message };
  }
  const envStatus = getInngestEnvStatus();
  if (envStatus.status === "missing-env" && !input.eventSender) {
    return { status: "not-queued", message: envStatus.message };
  }
  const prisma = getPrisma();
  const material = await prisma.studyMaterial.findFirst({
    where: { id: input.materialId, userId: input.userId, kind: StudyMaterialKind.WEB },
    select: {
      id: true,
      collectionId: true,
      title: true,
      activeRevision: {
        select: {
          sourceUrl: true,
          sourceFiles: {
            where: { kind: SourceFileKind.URL },
            take: 1,
            select: { metadata: true },
          },
        },
      },
    },
  });
  const sourceUrl = material?.activeRevision?.sourceUrl;
  const metadata = material?.activeRevision?.sourceFiles[0]?.metadata;
  if (!material || !sourceUrl || readStringArray(metadata ?? null, "selectedUrls").length === 0) {
    return { status: "not-found", message: "Ready website material was not found." };
  }
  const revision = await createNextMaterialRevision({
    userId: input.userId,
    materialId: material.id,
    sourceUrl,
  });
  if (!revision) {
    return { status: "not-found", message: "Website material was not found." };
  }
  const storageKey = buildMaterialObjectKey({
    userId: input.userId,
    materialId: material.id,
    materialRevisionId: revision.id,
    fileName: "website-snapshot.json",
  });
  await prisma.$transaction([
    prisma.materialRevision.update({
      where: { id: revision.id },
      data: {
        status: MaterialRevisionStatus.QUEUED,
        storageBucket: storageSetup.storage.bucketName,
        storageKey,
      },
    }),
    prisma.sourceFile.create({
      data: {
        userId: input.userId,
        collectionId: material.collectionId,
        materialRevisionId: revision.id,
        kind: SourceFileKind.URL,
        status: SourceFileStatus.UPLOADED,
        originalName: material.title,
        mimeType: "application/json",
        storageBucket: storageSetup.storage.bucketName,
        storageKey,
        metadata: metadata ?? Prisma.JsonNull,
      },
    }),
  ]);

  try {
    await (input.eventSender ?? inngestMaterialIngestionEventSender).sendMaterialIngestionRequested({
      userId: input.userId,
      materialRevisionId: revision.id,
      requestedAt: input.now.toISOString(),
    });
  } catch {
    await prisma.materialRevision.update({
      where: { id: revision.id },
      data: { status: MaterialRevisionStatus.FAILED, errorCode: "EVENT_SEND_FAILED" },
    });
    return { status: "not-queued", message: "Website refresh could not be queued. Try again." };
  }

  return {
    status: "queued",
    materialId: material.id,
    materialRevisionId: revision.id,
    message: "Website refresh queued as a new revision.",
  };
}

export async function runMaterialIngestionJob(input: {
  userId: string;
  materialRevisionId: string;
  storage?: SourceObjectStorage;
  embeddingGenerator?: MaterialEmbeddingGenerator | null;
  fetchResource?: FetchWebResource;
  resolveHostname?: ResolveHostname;
}) {
  const prisma = getPrisma();
  const existing = await prisma.materialRevision.findFirst({
    where: { id: input.materialRevisionId, userId: input.userId },
    select: { status: true },
  });
  if (!existing) {
    return { status: "not-found" as const };
  }
  if (existing.status === MaterialRevisionStatus.READY) {
    return { status: "ready" as const, alreadyProcessed: true };
  }

  const claimed = await prisma.materialRevision.updateMany({
    where: {
      id: input.materialRevisionId,
      userId: input.userId,
      status: {
        in: [
          MaterialRevisionStatus.QUEUED,
          MaterialRevisionStatus.FAILED,
          MaterialRevisionStatus.PROCESSING,
        ],
      },
    },
    data: {
      status: MaterialRevisionStatus.PROCESSING,
      errorCode: null,
      errorMessage: null,
    },
  });
  if (claimed.count !== 1) {
    return { status: "not-claimed" as const };
  }

  try {
    const revision = await prisma.materialRevision.findFirstOrThrow({
      where: { id: input.materialRevisionId, userId: input.userId },
      select: {
        id: true,
        materialId: true,
        sourceUrl: true,
        storageBucket: true,
        storageKey: true,
        material: { select: { kind: true } },
        sourceFiles: {
          orderBy: { createdAt: "asc" },
          take: 1,
          select: {
            id: true,
            byteSize: true,
            mimeType: true,
            storageBucket: true,
            storageKey: true,
            metadata: true,
          },
        },
      },
    });
    const sourceFile = revision.sourceFiles[0];
    if (!sourceFile) {
      throw new MaterialIngestionError("Material source record is missing.", { retryable: false });
    }
    const storageSetup = resolveMaterialStorage(input.storage);
    if (storageSetup.status === "missing-env") {
      throw new MaterialIngestionError(storageSetup.message, { retryable: true });
    }
    const embeddingGenerator =
      input.embeddingGenerator === undefined
        ? safelyResolveEmbeddingGenerator()
        : input.embeddingGenerator;

    const result = revision.material.kind === StudyMaterialKind.PDF
      ? await ingestPdfRevision({
          userId: input.userId,
          materialId: revision.materialId,
          materialRevisionId: revision.id,
          sourceFile,
          storage: storageSetup.storage,
          embeddingGenerator,
        })
      : await ingestWebsiteRevision({
          userId: input.userId,
          materialId: revision.materialId,
          materialRevisionId: revision.id,
          sourceUrl: revision.sourceUrl,
          sourceFile,
          storage: storageSetup.storage,
          embeddingGenerator,
          fetchResource: input.fetchResource,
          resolveHostname: input.resolveHostname,
        });

    return { status: "ready" as const, alreadyProcessed: false, ...result };
  } catch (error) {
    const ingestionError = normalizeIngestionError(error);
    await prisma.$transaction([
      prisma.materialRevision.updateMany({
        where: { id: input.materialRevisionId, userId: input.userId },
        data: {
          status: MaterialRevisionStatus.FAILED,
          errorCode: ingestionError.retryable ? "TRANSIENT_INGESTION_FAILURE" : "INGESTION_REJECTED",
          errorMessage: ingestionError.message.slice(0, 1_000),
        },
      }),
      prisma.sourceFile.updateMany({
        where: { materialRevisionId: input.materialRevisionId, userId: input.userId },
        data: { status: SourceFileStatus.FAILED },
      }),
    ]);
    throw ingestionError;
  }
}

async function ingestPdfRevision(input: {
  userId: string;
  materialId: string;
  materialRevisionId: string;
  sourceFile: MaterialSourceFile;
  storage: SourceObjectStorage;
  embeddingGenerator: MaterialEmbeddingGenerator | null;
}) {
  if (!input.sourceFile.storageKey || !input.sourceFile.storageBucket) {
    throw new MaterialIngestionError("Material PDF storage location is missing.", { retryable: false });
  }
  const bytes = await input.storage.getObjectBytes({
    key: input.sourceFile.storageKey,
    bucket: input.sourceFile.storageBucket,
    maxBytes: MAX_MATERIAL_PDF_BYTES,
  });
  const extracted = await extractPdfPages(bytes, { maximumPages: MAX_MATERIAL_PDF_PAGES });
  if (extracted.pages.every((page) => page.needsOcr)) {
    // Keep the revision usable: selected pages can be OCRed lazily and cached.
    // A placeholder section gives scope planning a stable page range meanwhile.
    extracted.pages[0] = { ...extracted.pages[0], text: "Scanned document", needsOcr: true };
  }
  const index = buildPdfIndex(extracted.pages);
  if (index.sections.length === 0) {
    index.sections.push({
      ordinal: 0,
      level: 1,
      title: "Document",
      normalizedTitle: "document",
      pageStart: 1,
      pageEnd: extracted.pageCount,
      headingPath: ["Document"],
    });
  }
  const persisted = await persistPdfIndex({
    userId: input.userId,
    materialRevisionId: input.materialRevisionId,
    sourceFileId: input.sourceFile.id,
    pages: extracted.pages,
    sections: index.sections,
    chunks: index.chunks,
  });
  const embedded = await embedPersistedChunks({
    userId: input.userId,
    materialRevisionId: input.materialRevisionId,
    chunks: persisted.chunks,
    embeddingGenerator: input.embeddingGenerator,
  });
  const excerpt = extracted.pages
    .filter((page) => !page.needsOcr)
    .map((page) => page.text)
    .join("\n\n")
    .slice(0, MATERIAL_SOURCE_EXCERPT_LIMIT);
  const prisma = getPrisma();
  await prisma.sourceFile.update({
    where: { id: input.sourceFile.id },
    data: { status: SourceFileStatus.READY, extractedText: excerpt || null },
  });
  await finalizeMaterialRevision({
    userId: input.userId,
    materialId: input.materialId,
    materialRevisionId: input.materialRevisionId,
    contentHash: sha256(bytes),
    byteSize: bytes.byteLength,
    pageCount: extracted.pageCount,
    storageBucket: input.sourceFile.storageBucket,
    storageKey: input.sourceFile.storageKey,
    processingMetadata: {
      parser: "pdfjs",
      chunkTargetTokens: 800,
      chunkOverlapTokens: 120,
      pagesRequiringOcr: index.pagesRequiringOcr,
      embeddingStatus: embedded ? "ready" : "unavailable",
    },
  });

  return { pageCount: extracted.pageCount, chunkCount: persisted.chunks.length };
}

async function ingestWebsiteRevision(input: {
  userId: string;
  materialId: string;
  materialRevisionId: string;
  sourceUrl: string | null;
  sourceFile: MaterialSourceFile;
  storage: SourceObjectStorage;
  embeddingGenerator: MaterialEmbeddingGenerator | null;
  fetchResource?: FetchWebResource;
  resolveHostname?: ResolveHostname;
}) {
  if (!input.sourceUrl || !input.sourceFile.storageKey || !input.sourceFile.storageBucket) {
    throw new MaterialIngestionError("Website material source details are missing.", { retryable: false });
  }
  if (!input.storage.putObject) {
    throw new MaterialIngestionError("Private website snapshot storage is unavailable.", {
      retryable: true,
    });
  }
  const base = await validatePublicHttpsUrl(input.sourceUrl, input.resolveHostname);
  const selectedUrls = readStringArray(input.sourceFile.metadata, "selectedUrls");
  if (selectedUrls.length === 0) {
    throw new MaterialIngestionError("No website pages were selected for import.", { retryable: false });
  }
  const fetchResource = input.fetchResource ?? fetchPublicWebResource;
  const snapshots: Array<{ url: string; title: string; html: string }> = [];
  let fetchedBytes = 0;

  for (let start = 0; start < selectedUrls.length; ) {
    const remaining = MAX_WEBSITE_REVISION_BYTES - fetchedBytes;
    if (remaining <= 0) {
      throw new MaterialIngestionError("Website revision exceeded the 50 MB fetched-content limit.", {
        retryable: false,
      });
    }
    const quotaBoundConcurrency = Math.max(
      1,
      Math.min(
        MATERIAL_WEBSITE_FETCH_CONCURRENCY,
        Math.floor(remaining / MATERIAL_WEBSITE_PAGE_FETCH_BYTES),
      ),
    );
    const batch = selectedUrls.slice(start, start + quotaBoundConcurrency);
    const maximumBytesPerPage = Math.min(
      MATERIAL_WEBSITE_PAGE_FETCH_BYTES,
      Math.floor(remaining / batch.length),
    );
    const fetchedBatch = await Promise.all(
      batch.map(async (selectedUrl) => {
        const requested = await validatePublicHttpsUrl(selectedUrl, input.resolveHostname);
        if (requested.origin !== base.origin) {
          throw new MaterialIngestionError(
            "Website imports can only follow pages from the same origin.",
            { retryable: false },
          );
        }
        const resource = await fetchResource(requested.toString(), {
          maximumBytes: maximumBytesPerPage,
          requiredOrigin: base.origin,
        });
        const finalUrl = await validatePublicHttpsUrl(resource.url, input.resolveHostname);
        if (finalUrl.origin !== base.origin) {
          throw new MaterialIngestionError(
            "Website imports can only follow pages from the same origin.",
            { retryable: false },
          );
        }
        if (!resource.contentType.toLowerCase().includes("text/html")) {
          throw new MaterialIngestionError("A selected website page was not readable HTML.", {
            retryable: false,
          });
        }
        const html = resource.bytes.toString("utf8");
        const readable = extractReadableWebPage(html, new URL(resource.url).pathname);
        return {
          byteSize: resource.bytes.byteLength,
          snapshot: { url: finalUrl.toString(), title: readable.title, html },
        };
      }),
    );
    const batchBytes = fetchedBatch.reduce((sum, page) => sum + page.byteSize, 0);
    if (batchBytes > remaining) {
      throw new MaterialIngestionError("Website revision exceeded the 50 MB fetched-content limit.", {
        retryable: false,
      });
    }
    fetchedBytes += batchBytes;
    snapshots.push(...fetchedBatch.map((page) => page.snapshot));
    start += batch.length;
  }

  const snapshotBytes = Buffer.from(JSON.stringify({ version: 1, pages: snapshots }));
  if (snapshotBytes.byteLength > MAX_WEBSITE_REVISION_BYTES) {
    throw new MaterialIngestionError("Website revision exceeded the 50 MB snapshot limit.", {
      retryable: false,
    });
  }
  const quota = await checkSourceStorageUsageLimit({
    userId: input.userId,
    byteSize: snapshotBytes.byteLength,
  });
  if (quota.status === "limited") {
    throw new MaterialIngestionError(quota.message, { retryable: false });
  }
  if (!(await canWriteWebsiteSnapshot(input))) {
    throw websiteSnapshotDeletionError();
  }
  await input.storage.putObject({
    key: input.sourceFile.storageKey,
    bucket: input.sourceFile.storageBucket,
    bytes: snapshotBytes,
    mimeType: "application/json",
  });
  if (!(await canWriteWebsiteSnapshot(input))) {
    await input.storage.deleteObject({
      key: input.sourceFile.storageKey,
      bucket: input.sourceFile.storageBucket,
    });
    throw websiteSnapshotDeletionError();
  }

  const persisted = await persistWebsiteIndex({
    userId: input.userId,
    materialRevisionId: input.materialRevisionId,
    sourceFileId: input.sourceFile.id,
    snapshots,
  });
  const embedded = await embedPersistedChunks({
    userId: input.userId,
    materialRevisionId: input.materialRevisionId,
    chunks: persisted.chunks,
    embeddingGenerator: input.embeddingGenerator,
  });
  const prisma = getPrisma();
  await prisma.sourceFile.update({
    where: { id: input.sourceFile.id },
    data: {
      status: SourceFileStatus.READY,
      byteSize: snapshotBytes.byteLength,
      extractedText: persisted.chunks.map((chunk) => chunk.text).join("\n\n").slice(0, MATERIAL_SOURCE_EXCERPT_LIMIT),
    },
  });
  await finalizeMaterialRevision({
    userId: input.userId,
    materialId: input.materialId,
    materialRevisionId: input.materialRevisionId,
    contentHash: sha256(snapshotBytes),
    byteSize: snapshotBytes.byteLength,
    fetchedPageCount: snapshots.length,
    storageBucket: input.sourceFile.storageBucket,
    storageKey: input.sourceFile.storageKey,
    processingMetadata: {
      parser: "cheerio",
      fetchedBytes,
      chunkTargetTokens: 800,
      chunkOverlapTokens: 120,
      embeddingStatus: embedded ? "ready" : "unavailable",
    },
  });

  return { pageCount: snapshots.length, chunkCount: persisted.chunks.length };
}

async function canWriteWebsiteSnapshot(input: {
  userId: string;
  materialId: string;
  materialRevisionId: string;
  sourceFile: MaterialSourceFile;
}) {
  const prisma = getPrisma();
  return (
    (await prisma.materialRevision.count({
      where: {
        id: input.materialRevisionId,
        materialId: input.materialId,
        userId: input.userId,
        status: MaterialRevisionStatus.PROCESSING,
        material: { status: StudyMaterialStatus.ACTIVE },
        sourceFiles: { some: { id: input.sourceFile.id, userId: input.userId } },
      },
    })) === 1
  );
}

function websiteSnapshotDeletionError() {
  return new MaterialIngestionError(
    "The material was deleted before its website snapshot could be finalized.",
    { retryable: false },
  );
}

type MaterialSourceFile = {
  id: string;
  byteSize: number | null;
  mimeType: string | null;
  storageBucket: string | null;
  storageKey: string | null;
  metadata: Prisma.JsonValue | null;
};

async function persistPdfIndex(input: {
  userId: string;
  materialRevisionId: string;
  sourceFileId: string;
  pages: ExtractedPdfPage[];
  sections: ReturnType<typeof buildPdfIndex>["sections"];
  chunks: ReturnType<typeof buildPdfIndex>["chunks"];
}) {
  const prisma = getPrisma();
  const sections = input.sections.map((section) => ({ ...section, id: randomUUID() }));
  const sectionIds = new Map(sections.map((section) => [section.ordinal, section.id]));
  const chunks = input.chunks.map((chunk) => {
    const sectionId = sectionIds.get(chunk.sectionOrdinal);
    if (!sectionId) {
      throw new MaterialIngestionError("PDF chunk did not resolve to an outline section.", {
        retryable: false,
      });
    }
    return { ...chunk, id: randomUUID(), sectionId };
  });

  await prisma.$transaction(async (tx) => {
    await tx.materialChunk.deleteMany({ where: { materialRevisionId: input.materialRevisionId, userId: input.userId } });
    await tx.materialPage.deleteMany({ where: { materialRevisionId: input.materialRevisionId, userId: input.userId } });
    await tx.materialSection.deleteMany({ where: { materialRevisionId: input.materialRevisionId, userId: input.userId } });
    await tx.materialSection.createMany({
      data: sections.map((section) => ({
        id: section.id,
        userId: input.userId,
        materialRevisionId: input.materialRevisionId,
        ordinal: section.ordinal,
        level: section.level,
        title: section.title,
        normalizedTitle: section.normalizedTitle,
        pageStart: section.pageStart,
        pageEnd: section.pageEnd,
        headingPath: section.headingPath,
      })),
    });
    const visualPages = input.pages.filter((page) => page.needsOcr || page.hasVisualContent);
    if (visualPages.length > 0) {
      await tx.materialPage.createMany({
        data: visualPages.map((page) => ({
          userId: input.userId,
          materialRevisionId: input.materialRevisionId,
          pageNumber: page.pageNumber,
          embeddedText: page.text || null,
          textStatus: page.needsOcr
            ? MaterialPageTextStatus.NEEDS_OCR
            : MaterialPageTextStatus.OCR_READY,
          contentHash: sha256(Buffer.from(page.text || `visual-page-${page.pageNumber}`)),
          tokenEstimate: page.text ? estimateTokens(page.text) : 0,
          metadata: {
            reason: page.needsOcr ? "insufficient-embedded-text" : "visual-content",
          },
        })),
      });
    }
    if (chunks.length > 0) {
      await tx.materialChunk.createMany({
        data: chunks.map((chunk) => ({
          id: chunk.id,
          userId: input.userId,
          materialRevisionId: input.materialRevisionId,
          materialSectionId: chunk.sectionId,
          sourceFileId: input.sourceFileId,
          ordinal: chunk.ordinal,
          text: chunk.text,
          tokenEstimate: chunk.tokenEstimate,
          contentHash: chunk.contentHash,
          headingText: chunk.headingText,
          locator: {
            version: 1,
            kind: "pdf",
            sectionId: chunk.sectionId,
            pageRange: { start: chunk.pageStart, end: chunk.pageEnd },
          },
        })),
      });
    }
  });

  return { sections, chunks };
}

async function persistWebsiteIndex(input: {
  userId: string;
  materialRevisionId: string;
  sourceFileId: string;
  snapshots: Array<{ url: string; title: string; html: string }>;
}) {
  const sections = input.snapshots.map((snapshot, ordinal) => ({
    id: randomUUID(),
    ordinal,
    title: snapshot.title,
    normalizedTitle: normalizeHeading(snapshot.title),
    url: snapshot.url,
    readable: extractReadableWebPage(snapshot.html, snapshot.title),
  }));
  const chunks = sections.flatMap((section) =>
    chunkSectionText(section.readable.text).map((chunk) => ({
      ...chunk,
      id: randomUUID(),
      sectionId: section.id,
      headingText: section.title,
      url: section.url,
      anchor: section.readable.headings[0]?.anchor ?? null,
    })),
  ).map((chunk, ordinal) => ({ ...chunk, ordinal }));
  const prisma = getPrisma();

  await prisma.$transaction(async (tx) => {
    await tx.materialChunk.deleteMany({ where: { materialRevisionId: input.materialRevisionId, userId: input.userId } });
    await tx.materialPage.deleteMany({ where: { materialRevisionId: input.materialRevisionId, userId: input.userId } });
    await tx.materialSection.deleteMany({ where: { materialRevisionId: input.materialRevisionId, userId: input.userId } });
    await tx.materialSection.createMany({
      data: sections.map((section) => ({
        id: section.id,
        userId: input.userId,
        materialRevisionId: input.materialRevisionId,
        ordinal: section.ordinal,
        level: 1,
        title: section.title,
        normalizedTitle: section.normalizedTitle,
        url: section.url,
        anchor: section.readable.headings[0]?.anchor ?? null,
        headingPath: [section.title],
        metadata: { headings: section.readable.headings.slice(0, 100) },
      })),
    });
    if (chunks.length > 0) {
      await tx.materialChunk.createMany({
        data: chunks.map((chunk) => ({
          id: chunk.id,
          userId: input.userId,
          materialRevisionId: input.materialRevisionId,
          materialSectionId: chunk.sectionId,
          sourceFileId: input.sourceFileId,
          ordinal: chunk.ordinal,
          text: chunk.text,
          tokenEstimate: chunk.tokenEstimate,
          contentHash: chunk.contentHash,
          headingText: chunk.headingText,
          locator: {
            version: 1,
            kind: "web",
            sectionId: chunk.sectionId,
            url: chunk.url,
            anchor: chunk.anchor,
          },
        })),
      });
    }
  });

  return { sections, chunks };
}

async function embedPersistedChunks(input: {
  userId: string;
  materialRevisionId: string;
  chunks: Array<{ id: string; text: string; headingText: string }>;
  embeddingGenerator: MaterialEmbeddingGenerator | null;
}) {
  if (!input.embeddingGenerator || input.chunks.length === 0) {
    return false;
  }

  try {
    for (let start = 0; start < input.chunks.length; start += MATERIAL_EMBEDDING_BATCH_SIZE) {
      const batch = input.chunks.slice(start, start + MATERIAL_EMBEDDING_BATCH_SIZE);
      const embeddings = await input.embeddingGenerator({
        texts: batch.map((chunk) => chunk.text),
        titles: batch.map((chunk) => chunk.headingText),
      });
      if (embeddings.length !== batch.length) {
        throw new Error("Embedding generator returned an incomplete batch.");
      }
      await Promise.all(
        batch.map((chunk, index) =>
          storeMaterialChunkEmbedding({
            userId: input.userId,
            materialRevisionId: input.materialRevisionId,
            chunkId: chunk.id,
            embedding: embeddings[index],
          }),
        ),
      );
    }
    return true;
  } catch (error) {
    console.warn("[materials] chunk embeddings unavailable", {
      materialRevisionId: input.materialRevisionId,
      message: error instanceof Error ? error.message : "Unknown embedding error",
    });
    return false;
  }
}

export function buildMaterialObjectKey(input: {
  userId: string;
  materialId: string;
  materialRevisionId: string;
  fileName: string;
}) {
  return [
    MATERIAL_STORAGE_PREFIX,
    sanitizeKeySegment(input.userId),
    sanitizeKeySegment(input.materialId),
    sanitizeKeySegment(input.materialRevisionId),
    sanitizeFileName(input.fileName),
  ].join("/");
}

function resolveMaterialStorage(storage?: SourceObjectStorage) {
  if (storage) {
    return { status: "ready" as const, storage };
  }
  return resolveS3SourceObjectStorage();
}

function safelyResolveEmbeddingGenerator() {
  try {
    return createGeminiMaterialEmbeddingGenerator();
  } catch {
    return null;
  }
}

function normalizeIngestionError(error: unknown) {
  if (error instanceof MaterialIngestionError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "Material processing failed.";
  const retryable = !/limit|at most|not readable|not contain enough|missing|invalid|unsupported/i.test(message);
  return new MaterialIngestionError(message, { retryable, cause: error });
}

function readStringArray(value: Prisma.JsonValue | null, key: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const candidate = value[key];
  return Array.isArray(candidate)
    ? candidate.filter((item): item is string => typeof item === "string" && item.length > 0)
    : [];
}

function normalizeHeading(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function sanitizeKeySegment(value: string) {
  return value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120) || "unknown";
}

function sanitizeFileName(value: string) {
  return value
    .replace(/[\\/]/g, "_")
    .replace(/[^A-Za-z0-9._ -]/g, "_")
    .trim()
    .slice(0, 180) || "material";
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}
