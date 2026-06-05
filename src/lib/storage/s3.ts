import "server-only";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";

import { formatEnvError } from "@/lib/env";

const s3EnvSchema = z.object({
  AWS_REGION: z.string({ error: "AWS_REGION is required" }).trim().min(1, "AWS_REGION is required"),
  S3_BUCKET_NAME: z
    .string({ error: "S3_BUCKET_NAME is required" })
    .trim()
    .min(1, "S3_BUCKET_NAME is required"),
  AWS_ACCESS_KEY_ID: z
    .string({ error: "AWS_ACCESS_KEY_ID is required" })
    .trim()
    .min(1, "AWS_ACCESS_KEY_ID is required"),
  AWS_SECRET_ACCESS_KEY: z
    .string({ error: "AWS_SECRET_ACCESS_KEY is required" })
    .trim()
    .min(1, "AWS_SECRET_ACCESS_KEY is required"),
});

export type S3Env = z.infer<typeof s3EnvSchema>;

export type SourceObjectHead = {
  byteSize: number | null;
  mimeType: string | null;
};

export type SourceObjectStorage = {
  bucketName: string;
  createPresignedUploadUrl(input: {
    key: string;
    mimeType: string;
    expiresInSeconds?: number;
  }): Promise<string>;
  headObject(input: { key: string }): Promise<SourceObjectHead>;
  getObjectBytes(input: { key: string }): Promise<Buffer>;
  deleteObject(input: { key: string }): Promise<void>;
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

export function getS3Env(): S3Env {
  return s3EnvSchema.parse(process.env);
}

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
      return getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: env.S3_BUCKET_NAME,
          Key: input.key,
          ContentType: input.mimeType,
        }),
        {
          expiresIn: input.expiresInSeconds ?? 600,
        },
      );
    },
    async headObject(input) {
      const result = await client.send(
        new HeadObjectCommand({
          Bucket: env.S3_BUCKET_NAME,
          Key: input.key,
        }),
      );

      return {
        byteSize: result.ContentLength ?? null,
        mimeType: result.ContentType ?? null,
      };
    },
    async getObjectBytes(input) {
      const result = await client.send(
        new GetObjectCommand({
          Bucket: env.S3_BUCKET_NAME,
          Key: input.key,
        }),
      );

      if (!result.Body) {
        return Buffer.alloc(0);
      }

      return streamToBuffer(result.Body as AsyncIterable<Uint8Array>);
    },
    async deleteObject(input) {
      await client.send(
        new DeleteObjectCommand({
          Bucket: env.S3_BUCKET_NAME,
          Key: input.key,
        }),
      );
    },
  };
}

async function streamToBuffer(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}
