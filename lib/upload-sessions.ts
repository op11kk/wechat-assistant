import { randomUUID } from "node:crypto";

import type { QueryResultRow } from "pg";

import { dbQuery, dbQueryMaybeOne, dbQueryOne } from "@/lib/db";

export type UploadedPart = {
  part_number: number;
  etag: string;
};

export type UploadSessionStatus = "uploading" | "completed" | "aborted" | "expired" | "failed";

export type UploadSessionRow = {
  id: string;
  participant_id: number;
  participant_code: string;
  wechat_openid: string;
  source: "h5";
  object_key: string;
  file_name: string | null;
  size_bytes: number | null;
  mime: string | null;
  upload_id: string;
  part_size: number;
  part_count: number;
  uploaded_parts: UploadedPart[];
  status: UploadSessionStatus;
  user_comment: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function parseInteger(value: unknown): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected integer but received ${String(value)}`);
  }
  return parsed;
}

function parseNullableInteger(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeUploadedParts(value: unknown): UploadedPart[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Map<number, string>();
  for (const item of value) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const partNumber = Number.parseInt(String((item as { part_number?: unknown }).part_number ?? ""), 10);
    const etag = String((item as { etag?: unknown }).etag ?? "").trim();
    if (!Number.isInteger(partNumber) || partNumber <= 0 || !etag) {
      continue;
    }
    seen.set(partNumber, etag);
  }
  return Array.from(seen.entries())
    .sort(([a], [b]) => a - b)
    .map(([part_number, etag]) => ({ part_number, etag }));
}

function mapUploadSessionRow(row: QueryResultRow): UploadSessionRow {
  return {
    id: String(row.id),
    participant_id: parseInteger(row.participant_id),
    participant_code: String(row.participant_code),
    wechat_openid: String(row.wechat_openid),
    source: "h5",
    object_key: String(row.object_key),
    file_name: row.file_name ? String(row.file_name) : null,
    size_bytes: parseNullableInteger(row.size_bytes),
    mime: row.mime ? String(row.mime) : null,
    upload_id: String(row.upload_id),
    part_size: parseInteger(row.part_size),
    part_count: parseInteger(row.part_count),
    uploaded_parts: normalizeUploadedParts(row.uploaded_parts),
    status: String(row.status) as UploadSessionStatus,
    user_comment: row.user_comment ? String(row.user_comment) : null,
    error_message: row.error_message ? String(row.error_message) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    completed_at: row.completed_at ? String(row.completed_at) : null,
  };
}

export async function createUploadSession(params: {
  participantId: number;
  participantCode: string;
  wechatOpenid: string;
  objectKey: string;
  fileName: string | null;
  sizeBytes: number;
  mime: string;
  uploadId: string;
  partSize: number;
  partCount: number;
  userComment?: string | null;
}): Promise<UploadSessionRow> {
  const row = await dbQueryOne(
    `insert into public.upload_sessions (
       id,
       participant_id,
       participant_code,
       wechat_openid,
       source,
       object_key,
       file_name,
       size_bytes,
       mime,
       upload_id,
       part_size,
       part_count,
       uploaded_parts,
       status,
       user_comment
     ) values ($1, $2, $3, $4, 'h5', $5, $6, $7, $8, $9, $10, $11, $12, 'uploading', $13)
     returning *`,
    [
      randomUUID(),
      params.participantId,
      params.participantCode,
      params.wechatOpenid,
      params.objectKey,
      params.fileName,
      params.sizeBytes,
      params.mime,
      params.uploadId,
      params.partSize,
      params.partCount,
      JSON.stringify([]),
      params.userComment ?? null,
    ],
  );
  return mapUploadSessionRow(row);
}

export async function getUploadSessionById(sessionId: string): Promise<UploadSessionRow | null> {
  const row = await dbQueryMaybeOne(
    `select * from public.upload_sessions where id = $1 limit 1`,
    [sessionId],
  );
  return row ? mapUploadSessionRow(row) : null;
}

export async function updateUploadSessionUploadedParts(
  sessionId: string,
  uploadedParts: UploadedPart[],
): Promise<UploadSessionRow> {
  const normalized = normalizeUploadedParts(uploadedParts);
  const row = await dbQueryOne(
    `update public.upload_sessions
     set uploaded_parts = $1,
         updated_at = now()
     where id = $2
     returning *`,
    [JSON.stringify(normalized), sessionId],
  );
  return mapUploadSessionRow(row);
}

export async function updateUploadSessionStatus(params: {
  sessionId: string;
  status: UploadSessionStatus;
  errorMessage?: string | null;
  completedAt?: string | null;
}): Promise<UploadSessionRow> {
  const row = await dbQueryOne(
    `update public.upload_sessions
     set status = $1,
         error_message = $2,
         completed_at = $3,
         updated_at = now()
     where id = $4
     returning *`,
    [params.status, params.errorMessage ?? null, params.completedAt ?? null, params.sessionId],
  );
  return mapUploadSessionRow(row);
}

export async function pingUploadSessionsTable(): Promise<void> {
  await dbQuery("select 1 from public.upload_sessions limit 1");
}
