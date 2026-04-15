import { getSupabaseAdmin } from "@/lib/supabase";

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

function mapUploadSessionRow(row: Record<string, unknown>): UploadSessionRow {
  return {
    id: String(row.id),
    participant_id: Number(row.participant_id),
    participant_code: String(row.participant_code),
    wechat_openid: String(row.wechat_openid),
    source: "h5",
    object_key: String(row.object_key),
    file_name: row.file_name ? String(row.file_name) : null,
    size_bytes:
      row.size_bytes === null || row.size_bytes === undefined ? null : Number.parseInt(String(row.size_bytes), 10),
    mime: row.mime ? String(row.mime) : null,
    upload_id: String(row.upload_id),
    part_size: Number.parseInt(String(row.part_size), 10),
    part_count: Number.parseInt(String(row.part_count), 10),
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
  const { data, error } = await getSupabaseAdmin()
    .from("upload_sessions")
    .insert({
      participant_id: params.participantId,
      participant_code: params.participantCode,
      wechat_openid: params.wechatOpenid,
      source: "h5",
      object_key: params.objectKey,
      file_name: params.fileName,
      size_bytes: params.sizeBytes,
      mime: params.mime,
      upload_id: params.uploadId,
      part_size: params.partSize,
      part_count: params.partCount,
      uploaded_parts: [],
      status: "uploading",
      user_comment: params.userComment ?? null,
    })
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to create upload session");
  }
  return mapUploadSessionRow(data as Record<string, unknown>);
}

export async function getUploadSessionById(sessionId: string): Promise<UploadSessionRow | null> {
  const { data, error } = await getSupabaseAdmin().from("upload_sessions").select("*").eq("id", sessionId).maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return data ? mapUploadSessionRow(data as Record<string, unknown>) : null;
}

export async function updateUploadSessionUploadedParts(sessionId: string, uploadedParts: UploadedPart[]): Promise<UploadSessionRow> {
  const normalized = normalizeUploadedParts(uploadedParts);
  const { data, error } = await getSupabaseAdmin()
    .from("upload_sessions")
    .update({ uploaded_parts: normalized })
    .eq("id", sessionId)
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to update uploaded parts");
  }
  return mapUploadSessionRow(data as Record<string, unknown>);
}

export async function updateUploadSessionStatus(params: {
  sessionId: string;
  status: UploadSessionStatus;
  errorMessage?: string | null;
  completedAt?: string | null;
}): Promise<UploadSessionRow> {
  const patch: Record<string, unknown> = {
    status: params.status,
    error_message: params.errorMessage ?? null,
  };
  if (params.completedAt !== undefined) {
    patch.completed_at = params.completedAt;
  }
  const { data, error } = await getSupabaseAdmin()
    .from("upload_sessions")
    .update(patch)
    .eq("id", params.sessionId)
    .select("*")
    .single();
  if (error || !data) {
    throw new Error(error?.message ?? "Failed to update upload session status");
  }
  return mapUploadSessionRow(data as Record<string, unknown>);
}
