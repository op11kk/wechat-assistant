import { buildPublicObjectUrl, hasObjectStorageConfig, hasWechatMediaConfig } from "@/lib/env";
import { isDuplicateError } from "@/lib/http";
import { buildChatObjectKey, putObjectBuffer } from "@/lib/r2";
import { getSupabaseAdmin } from "@/lib/supabase";
import { downloadWechatMedia } from "@/lib/wechat";

export const REVIEW_STATUSES = new Set(["pending", "approved", "rejected"]);
export const PARTICIPANT_STATUSES = new Set(["active", "paused", "withdrawn"]);
export const SUBMISSION_SOURCES = new Set(["chat", "h5"]);

type VideoSubmissionInsert = {
  participant_id: number;
  participant_code: string;
  source: string;
  object_key: string;
  wechat_media_id?: string | null;
  file_name?: string | null;
  size_bytes?: number | null;
  mime?: string | null;
  duration_sec?: number | null;
  user_comment?: string | null;
  review_status: "pending";
};

export async function findParticipantByOpenId(openid: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("participants")
    .select("*")
    .eq("wechat_openid", openid)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return data;
}

export async function findParticipantByCode(participantCode: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("participants")
    .select("*")
    .eq("participant_code", participantCode)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return data;
}

export async function findParticipantByCodeAndOpenId(participantCode: string, openid: string) {
  const { data, error } = await getSupabaseAdmin()
    .from("participants")
    .select("id, participant_code, status")
    .eq("participant_code", participantCode)
    .eq("wechat_openid", openid)
    .maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return data;
}

export async function nextParticipantCode(): Promise<string> {
  const { data, error } = await getSupabaseAdmin()
    .from("participants")
    .select("participant_code")
    .order("id", { ascending: false })
    .limit(1);
  if (error) {
    throw new Error(error.message);
  }
  const current = data?.[0]?.participant_code;
  const next = Number.parseInt(String(current ?? "0"), 10) + 1;
  if (!Number.isFinite(next) || next > 999_999) {
    return "000001";
  }
  return String(next).padStart(6, "0");
}

export async function insertVideoSubmissionRow(row: VideoSubmissionInsert): Promise<{
  status: "inserted" | "duplicate" | "error";
  submission?: Record<string, unknown>;
  detail?: string;
}> {
  const { data, error } = await getSupabaseAdmin()
    .from("video_submissions")
    .insert(row)
    .select("*")
    .single();
  if (!error && data) {
    return { status: "inserted", submission: data };
  }
  if (isDuplicateError(error)) {
    return { status: "duplicate" };
  }
  return {
    status: "error",
    detail: error?.message ?? "Insert returned no row",
  };
}

export async function findExistingSubmissionForDedup(params: {
  participantId: number;
  objectKey: string;
  wechatMediaId?: string | null;
}) {
  const client = getSupabaseAdmin().from("video_submissions").select("*").limit(1);
  const query = params.wechatMediaId
    ? client.eq("wechat_media_id", params.wechatMediaId)
    : client.eq("participant_id", params.participantId).eq("object_key", params.objectKey);
  const { data, error } = await query.maybeSingle();
  if (error) {
    throw new Error(error.message);
  }
  return data;
}

export async function syncWechatMediaToR2(
  submissionId: number,
  mediaId: string,
  participantCode: string,
): Promise<void> {
  if (!hasObjectStorageConfig() || !hasWechatMediaConfig()) {
    return;
  }
  const download = await downloadWechatMedia(mediaId);
  if (!download) {
    return;
  }
  const objectKey = buildChatObjectKey(participantCode, submissionId, download.contentType);
  await putObjectBuffer({
    objectKey,
    body: download.body,
    contentType: download.contentType,
  });
  const patch = {
    object_key: objectKey,
    size_bytes: download.body.length,
    mime: download.contentType,
  };
  const { error } = await getSupabaseAdmin()
    .from("video_submissions")
    .update(patch)
    .eq("id", submissionId);
  if (error) {
    console.error("video_submissions update failed", error.message);
  }
}

export type ChatVideoIngestResult =
  | { ok: true; submissionId: number }
  | {
      ok: false;
      reason: "not_registered" | "participant_inactive" | "duplicate" | "insert_failed";
      detail?: string;
    };

export async function ingestChatVideoWechat(params: {
  openid: string;
  mediaId: string;
  userComment?: string | null;
}): Promise<ChatVideoIngestResult> {
  const participant = await findParticipantByOpenId(params.openid);
  if (!participant) {
    console.info("wechat chat video skipped because participant does not exist");
    return { ok: false, reason: "not_registered" };
  }
  if (participant.status !== "active") {
    console.info("wechat chat video skipped because participant is not active", participant.status);
    return { ok: false, reason: "participant_inactive" };
  }
  const row: VideoSubmissionInsert = {
    participant_id: participant.id,
    participant_code: participant.participant_code,
    source: "chat",
    object_key: `wechat/pending/${params.mediaId}`,
    wechat_media_id: params.mediaId,
    user_comment: params.userComment ?? null,
    review_status: "pending",
  };
  const insertResult = await insertVideoSubmissionRow(row);
  if (insertResult.status !== "inserted" || !insertResult.submission) {
    if (insertResult.status === "duplicate") {
      return { ok: false, reason: "duplicate" };
    }
    return {
      ok: false,
      reason: "insert_failed",
      detail: insertResult.detail ?? "insert did not return row",
    };
  }
  const submissionId = Number(insertResult.submission.id);
  if (!Number.isFinite(submissionId)) {
    return { ok: false, reason: "insert_failed", detail: "invalid submission id" };
  }
  void syncWechatMediaToR2(submissionId, params.mediaId, participant.participant_code).catch((error) => {
    console.error("wechat media sync failed", error);
  });
  return { ok: true, submissionId };
}

export function decorateSubmissionObjectUrl<T extends { object_key?: string | null }>(row: T): T & {
  object_url: string | null;
} {
  return {
    ...row,
    object_url: row.object_key ? buildPublicObjectUrl(row.object_key) : null,
  };
}
