import { describe, expect, it } from "vitest";

import { SourceFileKind, SourceFileStatus } from "@/generated/prisma/client";

import {
  MAX_SOURCE_UPLOAD_BYTES,
  MAX_SOURCE_UPLOAD_REQUEUE_ATTEMPTS,
  SOURCE_PROCESSING_STALE_AFTER_MS,
  buildSourceUploadRequeueMetadata,
  canRequeueSourceUploadMetadata,
  buildSourceUploadObjectKey,
  isDismissedSourceUploadMetadata,
  isSourceUploadDismissible,
  getSourceUploadRetryCount,
  isSourceUploadProcessingStale,
  normalizeSourceUploadInput,
  validateExtractedSourceText,
} from "@/lib/skills/uploads";
import { SOURCE_CONTEXT_CHAR_LIMIT } from "@/lib/skills";
import { getS3Env } from "@/lib/storage/s3";

describe("normalizeSourceUploadInput", () => {
  it("accepts image and pdf metadata and normalizes optional fields", () => {
    const result = normalizeSourceUploadInput({
      originalName: "  Worksheet Page 1.PNG  ",
      mimeType: "image/png",
      byteSize: String(1024),
      sourceLabel: "  Unit review  ",
      focusNote: "  Split into grammar topics.  ",
      collectionName: "  Spanish  ",
      tags: " Spanish, Grammar ",
    });

    expect(result).toEqual({
      status: "ready",
      value: {
        originalName: "Worksheet Page 1.PNG",
        mimeType: "image/png",
        byteSize: 1024,
        sourceLabel: "Unit review",
        focusNote: "Split into grammar topics.",
        collectionName: "Spanish",
        tags: ["spanish", "grammar"],
      },
    });
  });

  it("rejects unsupported mime types and oversized files", () => {
    const result = normalizeSourceUploadInput({
      originalName: "notes.txt",
      mimeType: "text/plain",
      byteSize: MAX_SOURCE_UPLOAD_BYTES + 1,
    });

    expect(result.status).toBe("invalid");

    if (result.status === "invalid") {
      expect(result.fieldErrors.mimeType).toEqual(["Upload a PNG, JPEG, WebP, or PDF file."]);
      expect(result.fieldErrors.byteSize).toEqual(["Upload a file smaller than 10 MB."]);
    }
  });
});

describe("buildSourceUploadObjectKey", () => {
  it("uses the source upload prefix, user id, source file id, and sanitized file name", () => {
    expect(
      buildSourceUploadObjectKey({
        userId: "user/abc",
        sourceFileId: "src_123",
        originalName: "Worksheet Page 1!!.pdf",
      }),
    ).toBe("source-uploads/user-abc/src_123/worksheet-page-1.pdf");
  });
});

describe("validateExtractedSourceText", () => {
  it("accepts and caps extracted source text", () => {
    const result = validateExtractedSourceText({
      extractedText: `A${"b".repeat(SOURCE_CONTEXT_CHAR_LIMIT + 200)}`,
    });

    expect(result.status).toBe("ready");

    if (result.status === "ready") {
      expect(result.extractedText.length).toBeLessThanOrEqual(SOURCE_CONTEXT_CHAR_LIMIT);
      expect(result.extractedText.endsWith("[truncated]")).toBe(true);
    }
  });

  it("rejects empty or malformed extraction responses", () => {
    expect(validateExtractedSourceText({ extractedText: "  " })).toMatchObject({
      status: "invalid",
      reason: "invalid-response",
    });
    expect(validateExtractedSourceText({ text: "wrong key" })).toMatchObject({
      status: "invalid",
      reason: "invalid-response",
    });
  });
});

describe("source upload recovery helpers", () => {
  const now = new Date("2026-06-05T12:00:00.000Z");

  it.each([
    {
      name: "missing metadata",
      metadata: null,
      expected: false,
    },
    {
      name: "undefined metadata",
      metadata: undefined as never,
      expected: false,
    },
    {
      name: "empty metadata",
      metadata: {},
      expected: false,
    },
    {
      name: "invalid timestamp",
      metadata: {
        processingStartedAt: "not-a-date",
      },
      expected: false,
    },
    {
      name: "just before threshold",
      metadata: {
        processingStartedAt: new Date(
          now.getTime() - SOURCE_PROCESSING_STALE_AFTER_MS + 1,
        ).toISOString(),
      },
      expected: false,
    },
    {
      name: "at threshold",
      metadata: {
        processingStartedAt: new Date(
          now.getTime() - SOURCE_PROCESSING_STALE_AFTER_MS,
        ).toISOString(),
      },
      expected: true,
    },
    {
      name: "after threshold",
      metadata: {
        processingStartedAt: new Date(
          now.getTime() - SOURCE_PROCESSING_STALE_AFTER_MS - 1,
        ).toISOString(),
      },
      expected: true,
    },
  ])("detects stale processing uploads for $name", ({ metadata, expected }) => {
    expect(isSourceUploadProcessingStale(metadata, now)).toBe(expected);
  });

  it.each([
    {
      name: "missing metadata",
      metadata: null,
      expectedRetryCount: 1,
      expectedExtraFields: {},
    },
    {
      name: "undefined metadata",
      metadata: undefined as never,
      expectedRetryCount: 1,
      expectedExtraFields: {},
    },
    {
      name: "non-numeric retry count",
      metadata: { retryCount: "bad" },
      expectedRetryCount: 1,
      expectedExtraFields: {},
    },
    {
      name: "existing retry count and extra fields",
      metadata: {
        retryCount: 2,
        queuedAt: "2026-06-05T11:00:00.000Z",
        originalFileName: "worksheet.png",
      },
      expectedRetryCount: 3,
      expectedExtraFields: {
        originalFileName: "worksheet.png",
      },
    },
  ])(
    "increments retry count and records requeue timestamp for $name",
    ({ metadata, expectedRetryCount, expectedExtraFields }) => {
      expect(buildSourceUploadRequeueMetadata(metadata, now)).toMatchObject({
        ...expectedExtraFields,
        retryCount: expectedRetryCount,
        queuedAt: "2026-06-05T12:00:00.000Z",
        requeuedAt: "2026-06-05T12:00:00.000Z",
      });
    },
  );

  it("caps retryable failed upload metadata", () => {
    expect(getSourceUploadRetryCount({ retryCount: MAX_SOURCE_UPLOAD_REQUEUE_ATTEMPTS - 1 })).toBe(
      MAX_SOURCE_UPLOAD_REQUEUE_ATTEMPTS - 1,
    );
    expect(canRequeueSourceUploadMetadata({ retryCount: MAX_SOURCE_UPLOAD_REQUEUE_ATTEMPTS - 1 })).toBe(
      true,
    );
    expect(canRequeueSourceUploadMetadata({ retryCount: MAX_SOURCE_UPLOAD_REQUEUE_ATTEMPTS })).toBe(
      false,
    );
  });

  it("consumes a retry attempt for requeued uploaded source metadata", () => {
    expect(
      buildSourceUploadRequeueMetadata(
        {
          originalFileName: "worksheet.pdf",
        },
        now,
        { requeueAttemptId: "attempt-1" },
      ),
    ).toMatchObject({
      originalFileName: "worksheet.pdf",
      queuedAt: "2026-06-05T12:00:00.000Z",
      requeuedAt: "2026-06-05T12:00:00.000Z",
      requeueAttemptId: "attempt-1",
      retryCount: 1,
    });
  });

  it("dismisses failed uploads and capped waiting uploads that have not already been dismissed", () => {
    expect(
      isSourceUploadDismissible(
        {
          kind: SourceFileKind.PDF,
          status: SourceFileStatus.FAILED,
          metadata: { retryCount: MAX_SOURCE_UPLOAD_REQUEUE_ATTEMPTS - 1 },
          _count: { skillRefs: 0 },
        },
        now,
      ),
    ).toBe(true);

    expect(
      isSourceUploadDismissible(
        {
          kind: SourceFileKind.PDF,
          status: SourceFileStatus.UPLOADED,
          metadata: { retryCount: MAX_SOURCE_UPLOAD_REQUEUE_ATTEMPTS - 1 },
          _count: { skillRefs: 0 },
        },
        now,
      ),
    ).toBe(false);

    expect(
      isSourceUploadDismissible(
        {
          kind: SourceFileKind.PDF,
          status: SourceFileStatus.FAILED,
          metadata: { retryCount: MAX_SOURCE_UPLOAD_REQUEUE_ATTEMPTS },
          _count: { skillRefs: 0 },
        },
        now,
      ),
    ).toBe(true);

    expect(
      isSourceUploadDismissible(
        {
          kind: SourceFileKind.PDF,
          status: SourceFileStatus.FAILED,
          metadata: {
            dismissedAt: "2026-06-05T11:00:00.000Z",
            retryCount: MAX_SOURCE_UPLOAD_REQUEUE_ATTEMPTS,
          },
          _count: { skillRefs: 0 },
        },
        now,
      ),
    ).toBe(false);

    expect(
      isDismissedSourceUploadMetadata({ dismissedAt: "2026-06-05T11:00:00.000Z" }),
    ).toBe(true);
  });

});

describe("getS3Env", () => {
  it("returns a typed setup error when S3 env is missing", () => {
    const originalRegion = process.env.AWS_REGION;
    const originalBucket = process.env.S3_BUCKET_NAME;
    const originalAccessKey = process.env.AWS_ACCESS_KEY_ID;
    const originalSecretKey = process.env.AWS_SECRET_ACCESS_KEY;

    try {
      delete process.env.AWS_REGION;
      delete process.env.S3_BUCKET_NAME;
      delete process.env.AWS_ACCESS_KEY_ID;
      delete process.env.AWS_SECRET_ACCESS_KEY;

      expect(() => getS3Env()).toThrow(/AWS_REGION is required/);
    } finally {
      restoreEnv("AWS_REGION", originalRegion);
      restoreEnv("S3_BUCKET_NAME", originalBucket);
      restoreEnv("AWS_ACCESS_KEY_ID", originalAccessKey);
      restoreEnv("AWS_SECRET_ACCESS_KEY", originalSecretKey);
    }
  });
});

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
