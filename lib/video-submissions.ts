import { after } from "next/server";

import {
  buildPublicObjectUrl,
  env,
  getWechatIngestApiSecret,
  getWechatIngestApiTimeoutMs,
  getWechatMediaWorkerTimeoutMs,
  hasWechatIngestApiConfig,
  hasObjectStorageConfig,
  hasWechatMediaConfig,
  hasWechatMediaWorkerConfig,
} from "@/lib/env";
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
    console.warn("wechat media sync skipped because storage or wechat media config is missing", {
      submissionId,
      hasObjectStorageConfig: hasObjectStorageConfig(),
      hasWechatMediaConfig: hasWechatMediaConfig(),
    });
    return;
  }
  console.info("wechat media sync started", { submissionId, mediaId, participantCode });
  const download = await downloadWechatMedia(mediaId);
  if (!download) {
    console.warn("wechat media sync skipped because media download failed", { submissionId, mediaId });
    return;
  }
  const objectKey = buildChatObjectKey(participantCode, submissionId, download.contentType);
  console.info("wechat media cos upload started", {
    submissionId,
    objectKey,
    sizeBytes: download.body.length,
    contentType: download.contentType,
  });
  await putObjectBuffer({
    objectKey,
    body: download.body,
    contentType: download.contentType,
  });
  console.info("wechat media cos upload completed", { submissionId, objectKey });
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
    return;
  }
  console.info("wechat media sync completed", {
    submissionId,
    objectKey,
    sizeBytes: download.body.length,
    contentType: download.contentType,
  });
}

export async function dispatchWechatMediaWorker(params: {
  submissionId: number;
  mediaId: string;
  participantCode: string;
}): Promise<void> {
  const timeoutMs = getWechatMediaWorkerTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    console.info("wechat media worker dispatch started", {
      submissionId: params.submissionId,
      participantCode: params.participantCode,
      timeoutMs,
    });
    const response = await fetch(env.WECHAT_MEDIA_WORKER_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.WECHAT_MEDIA_WORKER_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        submission_id: params.submissionId,
        media_id: params.mediaId,
        participant_code: params.participantCode,
      }),
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      console.error("wechat media worker dispatch failed", {
        submissionId: params.submissionId,
        status: response.status,
        body: text.slice(0, 500),
      });
      return;
    }
    console.info("wechat media worker dispatch completed", {
      submissionId: params.submissionId,
      status: response.status,
      body: text.slice(0, 500),
    });
  } catch (error) {
    console.error("wechat media worker dispatch error", {
      submissionId: params.submissionId,
      name: error instanceof Error ? error.name : null,
      message: error instanceof Error ? error.message : String(error),
      timeoutMs,
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function syncChatMedia(params: {
  submissionId: number;
  mediaId: string;
  participantCode: string;
}): Promise<void> {
  if (hasWechatMediaWorkerConfig()) {
    await dispatchWechatMediaWorker(params);
    return;
  }
  await syncWechatMediaToR2(params.submissionId, params.mediaId, params.participantCode);
}

export type ChatVideoIngestResult =
  | { ok: true; submissionId: number; participantCode: string }
  | {
      ok: false;
      reason: "not_registered" | "participant_inactive" | "duplicate" | "insert_failed";
      detail?: string;
    };

export async function createChatVideoWechatSubmission(params: {
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
  return {
    ok: true,
    submissionId,
    participantCode: participant.participant_code,
  };
}

export async function ingestChatVideoWechat(params: {
  openid: string;
  mediaId: string;
  userComment?: string | null;
}): Promise<ChatVideoIngestResult> {
  const result = await createChatVideoWechatSubmission(params);
  if (!result.ok) {
    return result;
  }
  after(async () => {
    try {
      await syncChatMedia({
        submissionId: result.submissionId,
        mediaId: params.mediaId,
        participantCode: result.participantCode,
      });
    } catch (error) {
      console.error("wechat media sync failed", error);
    }
  });
  return result;
}

export async function ingestChatVideoWechatViaApi(params: {
  openid: string;
  mediaId: string;
  userComment?: string | null;
}): Promise<ChatVideoIngestResult> {
  if (!hasWechatIngestApiConfig()) {
    return {
      ok: false,
      reason: "insert_failed",
      detail: "WECHAT_INGEST_API_URL or secret not configured",
    };
  }
  const timeoutMs = getWechatIngestApiTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(env.WECHAT_INGEST_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getWechatIngestApiSecret()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        openid: params.openid,
        media_id: params.mediaId,
        user_comment: params.userComment ?? null,
      }),
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => null)) as ChatVideoIngestResult | { error?: string } | null;
    if (!response.ok || !payload) {
      return {
        ok: false,
        reason: "insert_failed",
        detail: payload && "error" in payload ? payload.error : `remote ingest status ${response.status}`,
      };
    }
    return payload as ChatVideoIngestResult;
  } catch (error) {
    return {
      ok: false,
      reason: "insert_failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function decorateSubmissionObjectUrl<T extends { object_key?: string | null }>(row: T): T & {
  object_url: string | null;
} {
  return {
    ...row,
    object_url: row.object_key ? buildPublicObjectUrl(row.object_key) : null,
  };
}
