import { afterEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(readonly input: unknown) {}
  }

  return {
    DeleteObjectCommand: Command,
    GetObjectCommand: Command,
    HeadObjectCommand: Command,
    ListObjectsV2Command: Command,
    PutObjectCommand: Command,
    S3Client: class {
      send = send;
    },
  };
});

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn(),
}));

import { createS3SourceObjectStorage } from "@/lib/storage/s3";

describe("S3 object reads", () => {
  afterEach(() => {
    send.mockReset();
  });

  it("cancels a stalled response body when the worker deadline aborts", async () => {
    const canceled = new Error("material OCR deadline reached");
    const signal = new AbortController();
    send.mockResolvedValueOnce({
      Body: {
        [Symbol.asyncIterator]() {
          return {
            next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
          };
        },
      },
    });
    const storage = createS3SourceObjectStorage({
      AWS_REGION: "us-east-1",
      AWS_ACCESS_KEY_ID: "test-access-key",
      AWS_SECRET_ACCESS_KEY: "test-secret-key",
      S3_BUCKET_NAME: "private-materials",
    });

    const read = storage.getObjectBytes({
      key: "materials/source.pdf",
      abortSignal: signal.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    signal.abort(canceled);

    await expect(read).rejects.toBe(canceled);
    expect(send).toHaveBeenCalledWith(expect.anything(), {
      abortSignal: signal.signal,
    });
  });
});
