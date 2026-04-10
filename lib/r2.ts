import { randomUUID } from "node:crypto";
import type { Readable as NodeReadable } from "node:stream";

import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  buildPublicObjectUrl,
  env,
  getCosS3PathStyleEndpoint,
  getObjectStorageProvider,
  getR2Endpoint,
  ObjectStorageProvider,
} from "@/lib/env";

const EXT_BY_CONTENT_TYPE: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/quicktime": ".mov",
  "video/webm": ".webm",
  "video/x-msvideo": ".avi",
};

let client: S3Client | null = null;
let clientProvider: ObjectStorageProvider | null = null;

function getStorageBucket(provider: ObjectStorageProvider): string {
  return provider === "cloudflare_r2" ? env.CLOUDFLARE_R2_BUCKET : env.COS_BUCKET;
}

function getStorageClient(): S3Client {
  const provider = getObjectStorageProvider();
  if (!provider) {
    throw new Error("Object storage is not configured");
  }
  if (client && clientProvider === provider) {
    return client;
  }
  if (provider === "cloudflare_r2") {
    client = new S3Client({
      region: "auto",
      endpoint: getR2Endpoint(),
      credentials: {
        accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
        secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
      },
      // 避免预签名 URL 带上 CRC 等参数，浏览器直传只发 Content-Type 时与部分 S3 兼容端（含 COS）更稳
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
  } else {
    client = new S3Client({
      region: env.COS_REGION,
      endpoint: getCosS3PathStyleEndpoint(),
      credentials: {
        accessKeyId: env.COS_SECRET_ID,
        secretAccessKey: env.COS_SECRET_KEY,
      },
      forcePathStyle: true,
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
  }
  clientProvider = provider;
  return client;
}

function normalizeExtension(fileName?: string | null, contentType?: string | null): string {
  const fromName = fileName?.match(/(\.[a-z0-9]{1,10})$/i)?.[1]?.toLowerCase();
  if (fromName) {
    return fromName;
  }
  const byType = contentType ? EXT_BY_CONTENT_TYPE[contentType.toLowerCase()] : undefined;
  return byType ?? ".mp4";
}

export function buildH5ObjectKey(
  participantCode: string,
  fileName?: string | null,
  contentType?: string | null,
): string {
  return `uploads/${participantCode}/h5/${randomUUID()}${normalizeExtension(fileName, contentType)}`;
}

export function buildChatObjectKey(
  participantCode: string,
  submissionId: number,
  contentType?: string | null,
): string {
  return `uploads/${participantCode}/chat/${submissionId}${normalizeExtension(null, contentType)}`;
}

export async function createPresignedUploadUrl(params: {
  objectKey: string;
  contentType: string;
  expiresIn?: number;
}): Promise<{
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  object_key: string;
  expires_in: number;
  storage: ObjectStorageProvider;
  object_url: string | null;
}> {
  const expiresIn = params.expiresIn ?? 600;
  const provider = getObjectStorageProvider();
  if (!provider) {
    throw new Error("Object storage is not configured");
  }
  const command = new PutObjectCommand({
    Bucket: getStorageBucket(provider),
    Key: params.objectKey,
    ContentType: params.contentType,
  });
  const url = await getSignedUrl(getStorageClient(), command, { expiresIn });
  return {
    method: "PUT",
    url,
    headers: {
      "Content-Type": params.contentType,
    },
    object_key: params.objectKey,
    expires_in: expiresIn,
    storage: provider,
    object_url: buildPublicObjectUrl(params.objectKey),
  };
}

export async function putObjectBuffer(params: {
  objectKey: string;
  body: Buffer;
  contentType: string;
}): Promise<void> {
  const provider = getObjectStorageProvider();
  if (!provider) {
    throw new Error("Object storage is not configured");
  }
  await getStorageClient().send(
    new PutObjectCommand({
      Bucket: getStorageBucket(provider),
      Key: params.objectKey,
      Body: params.body,
      ContentType: params.contentType,
    }),
  );
}

export async function putObjectReadableStream(params: {
  objectKey: string;
  body: NodeReadable;
  contentType: string;
}): Promise<void> {
  const provider = getObjectStorageProvider();
  if (!provider) {
    throw new Error("Object storage is not configured");
  }
  await getStorageClient().send(
    new PutObjectCommand({
      Bucket: getStorageBucket(provider),
      Key: params.objectKey,
      Body: params.body,
      ContentType: params.contentType,
    }),
  );
}

export async function s3CreateMultipartUpload(params: { objectKey: string; contentType: string }): Promise<string> {
  const provider = getObjectStorageProvider();
  if (!provider) {
    throw new Error("Object storage is not configured");
  }
  const out = await getStorageClient().send(
    new CreateMultipartUploadCommand({
      Bucket: getStorageBucket(provider),
      Key: params.objectKey,
      ContentType: params.contentType,
    }),
  );
  if (!out.UploadId) {
    throw new Error("CreateMultipartUpload returned no UploadId");
  }
  return out.UploadId;
}

export async function s3UploadPart(params: {
  objectKey: string;
  uploadId: string;
  partNumber: number;
  body: Buffer;
}): Promise<string> {
  const provider = getObjectStorageProvider();
  if (!provider) {
    throw new Error("Object storage is not configured");
  }
  const out = await getStorageClient().send(
    new UploadPartCommand({
      Bucket: getStorageBucket(provider),
      Key: params.objectKey,
      UploadId: params.uploadId,
      PartNumber: params.partNumber,
      Body: params.body,
    }),
  );
  if (!out.ETag) {
    throw new Error("UploadPart returned no ETag");
  }
  return out.ETag;
}

export async function s3CompleteMultipartUpload(params: {
  objectKey: string;
  uploadId: string;
  parts: { PartNumber: number; ETag: string }[];
}): Promise<void> {
  const provider = getObjectStorageProvider();
  if (!provider) {
    throw new Error("Object storage is not configured");
  }
  const sorted = [...params.parts].sort((a, b) => a.PartNumber - b.PartNumber);
  await getStorageClient().send(
    new CompleteMultipartUploadCommand({
      Bucket: getStorageBucket(provider),
      Key: params.objectKey,
      UploadId: params.uploadId,
      MultipartUpload: {
        Parts: sorted.map((p) => ({ PartNumber: p.PartNumber, ETag: p.ETag })),
      },
    }),
  );
}
