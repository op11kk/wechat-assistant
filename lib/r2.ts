import { randomUUID } from "node:crypto";
import type { Readable as NodeReadable } from "node:stream";

import {
  AbortMultipartUploadCommand,
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
  getCosEndpoint,
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
const OBJECT_STORAGE_PUT_TIMEOUT_MS = 90_000;

async function sendStorageCommandWithTimeout(command: PutObjectCommand): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OBJECT_STORAGE_PUT_TIMEOUT_MS);
  try {
    await getStorageClient().send(command, {
      abortSignal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function getDefaultPresignedUploadExpiresIn(): number {
  const raw = Number.parseInt(env.UPLOAD_PRESIGN_EXPIRES_IN || "1800", 10);
  if (!Number.isFinite(raw)) {
    return 1800;
  }
  return Math.min(Math.max(raw, 300), 3600);
}

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
    // 腾讯云 COS 要求虚拟主机域名，path-style 会报 PathStyleDomainForbidden
    client = new S3Client({
      region: env.COS_REGION,
      endpoint: getCosEndpoint(),
      credentials: {
        accessKeyId: env.COS_SECRET_ID,
        secretAccessKey: env.COS_SECRET_KEY,
      },
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
  const expiresIn = params.expiresIn ?? getDefaultPresignedUploadExpiresIn();
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
  await sendStorageCommandWithTimeout(
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
  await sendStorageCommandWithTimeout(
    new PutObjectCommand({
      Bucket: getStorageBucket(provider),
      Key: params.objectKey,
      Body: params.body,
      ContentType: params.contentType,
    }),
  );
}

export async function createMultipartUpload(params: {
  objectKey: string;
  contentType: string;
}): Promise<{
  uploadId: string;
  storage: ObjectStorageProvider;
  object_key: string;
  object_url: string | null;
}> {
  const provider = getObjectStorageProvider();
  if (!provider) {
    throw new Error("Object storage is not configured");
  }
  const response = await getStorageClient().send(
    new CreateMultipartUploadCommand({
      Bucket: getStorageBucket(provider),
      Key: params.objectKey,
      ContentType: params.contentType,
    }),
  );
  if (!response.UploadId) {
    throw new Error("Multipart upload did not return UploadId");
  }
  return {
    uploadId: response.UploadId,
    storage: provider,
    object_key: params.objectKey,
    object_url: buildPublicObjectUrl(params.objectKey),
  };
}

export async function createPresignedUploadPartUrl(params: {
  objectKey: string;
  uploadId: string;
  partNumber: number;
  expiresIn?: number;
}): Promise<{
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  object_key: string;
  upload_id: string;
  part_number: number;
  expires_in: number;
  storage: ObjectStorageProvider;
}> {
  const provider = getObjectStorageProvider();
  if (!provider) {
    throw new Error("Object storage is not configured");
  }
  const expiresIn = params.expiresIn ?? getDefaultPresignedUploadExpiresIn();
  const command = new UploadPartCommand({
    Bucket: getStorageBucket(provider),
    Key: params.objectKey,
    UploadId: params.uploadId,
    PartNumber: params.partNumber,
  });
  const url = await getSignedUrl(getStorageClient(), command, { expiresIn });
  return {
    method: "PUT",
    url,
    headers: {},
    object_key: params.objectKey,
    upload_id: params.uploadId,
    part_number: params.partNumber,
    expires_in: expiresIn,
    storage: provider,
  };
}

export async function completeMultipartUpload(params: {
  objectKey: string;
  uploadId: string;
  parts: Array<{ part_number: number; etag: string }>;
}): Promise<{
  object_key: string;
  object_url: string | null;
}> {
  const provider = getObjectStorageProvider();
  if (!provider) {
    throw new Error("Object storage is not configured");
  }
  const normalizedParts = params.parts
    .filter((part) => Number.isInteger(part.part_number) && part.part_number > 0 && part.etag.trim())
    .sort((a, b) => a.part_number - b.part_number)
    .map((part) => ({
      ETag: part.etag,
      PartNumber: part.part_number,
    }));
  if (normalizedParts.length === 0) {
    throw new Error("Multipart complete requires at least one uploaded part");
  }
  await getStorageClient().send(
    new CompleteMultipartUploadCommand({
      Bucket: getStorageBucket(provider),
      Key: params.objectKey,
      UploadId: params.uploadId,
      MultipartUpload: {
        Parts: normalizedParts,
      },
    }),
  );
  return {
    object_key: params.objectKey,
    object_url: buildPublicObjectUrl(params.objectKey),
  };
}

export async function abortMultipartUpload(params: {
  objectKey: string;
  uploadId: string;
}): Promise<void> {
  const provider = getObjectStorageProvider();
  if (!provider) {
    throw new Error("Object storage is not configured");
  }
  await getStorageClient().send(
    new AbortMultipartUploadCommand({
      Bucket: getStorageBucket(provider),
      Key: params.objectKey,
      UploadId: params.uploadId,
    }),
  );
}
