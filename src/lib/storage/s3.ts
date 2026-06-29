import "server-only";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import { formatEnvError, getS3Env, type S3Env } from "@/lib/env";

export { getS3Env };

export type SourceObjectHead = {
  byteSize: number | null;
  mimeType: string | null;
};

export class SourceObjectSizeLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceObjectSizeLimitError";
  }
}

export function isSourceObjectSizeLimitError(
  error: unknown,
): error is SourceObjectSizeLimitError {
  return error instanceof SourceObjectSizeLimitError;
}

export type SourceObjectStorage = {
  bucketName: string;
  createPresignedUploadUrl(input: {
    key: string;
    mimeType: string;
    byteSize: number;
    maxBytes: number;
    expiresInSeconds?: number;
  }): Promise<string>;
  headObject(input: { key: string; bucket?: string }): Promise<SourceObjectHead>;
  getObjectBytes(input: { key: string; bucket?: string; maxBytes?: number }): Promise<Buffer>;
  listObjects(input?: { prefix?: string; bucket?: string }): Promise<string[]>;
  deleteObject(input: { key: string; bucket?: string }): Promise<void>;
};

export type SourceObjectStorageSetup =
  | {
      status: "ready";
      storage: SourceObjectStorage;
    }
  | {
      status: "missing-env";
      message: string;
    };

export function resolveS3SourceObjectStorage(): SourceObjectStorageSetup {
  try {
    return {
      status: "ready",
      storage: createS3SourceObjectStorage(getS3Env()),
    };
  } catch (error) {
    return {
      status: "missing-env",
      message: formatEnvError(error),
    };
  }
}

export function createS3SourceObjectStorage(env: S3Env): SourceObjectStorage {
  const client = new S3Client({
    region: env.AWS_REGION,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  });

  return {
    bucketName: env.S3_BUCKET_NAME,
    async createPresignedUploadUrl(input) {
      if (input.byteSize > input.maxBytes) {
        throw new SourceObjectSizeLimitError(
          `Upload exceeds maximum size of ${input.maxBytes} bytes.`,
        );
      }

      return getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: env.S3_BUCKET_NAME,
          Key: input.key,
          ContentLength: input.byteSize,
          ContentType: input.mimeType,
        }),
        {
          expiresIn: input.expiresInSeconds ?? 600,
        },
      );
    },
    async headObject(input) {
      const bucket = input.bucket ?? env.S3_BUCKET_NAME;
      const result = await client.send(
        new HeadObjectCommand({
          Bucket: bucket,
          Key: input.key,
        }),
      );

      return {
        byteSize: result.ContentLength ?? null,
        mimeType: result.ContentType ?? null,
      };
    },
    async getObjectBytes(input) {
      const bucket = input.bucket ?? env.S3_BUCKET_NAME;
      const result = await client.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: input.key,
        }),
      );

      if (!result.Body) {
        throw new Error(`S3 object ${bucket}/${input.key} had no response body.`);
      }

      return streamToBuffer(result.Body as AsyncIterable<Uint8Array>, input.maxBytes);
    },
    async listObjects(input = {}) {
      const bucket = input.bucket ?? env.S3_BUCKET_NAME;
      const keys: string[] = [];
      let continuationToken: string | undefined;

      do {
        const result = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: input.prefix,
            ContinuationToken: continuationToken,
          }),
        );

        for (const object of result.Contents ?? []) {
          if (object.Key) {
            keys.push(object.Key);
          }
        }

        continuationToken = result.NextContinuationToken;
      } while (continuationToken);

      return keys;
    },
    async deleteObject(input) {
      const bucket = input.bucket ?? env.S3_BUCKET_NAME;
      await client.send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: input.key,
        }),
      );
    },
  };
}

async function streamToBuffer(
  stream: AsyncIterable<Uint8Array>,
  maxBytes?: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of stream) {
    totalBytes += chunk.byteLength;

    if (maxBytes !== undefined && totalBytes > maxBytes) {
      throw new SourceObjectSizeLimitError(
        `S3 object exceeded maximum read size of ${maxBytes} bytes.`,
      );
    }

    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks, totalBytes);
}
