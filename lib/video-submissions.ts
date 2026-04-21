import type { QueryResultRow } from "pg";

import { buildPublicObjectUrl, hasObjectStorageConfig, hasWechatMediaConfig } from "@/lib/env";
import { dbQuery, dbQueryMaybeOne, dbQueryOne } from "@/lib/db";
import { isDuplicateError } from "@/lib/http";
import { buildChatObjectKey, putObjectBuffer } from "@/lib/r2";
import { downloadWechatMedia } from "@/lib/wechat";
import type { H5FormalStatus, H5TestStatus, H5UploadKind } from "@/lib/h5-workflow";

export const REVIEW_STATUSES = new Set(["pending", "approved", "rejected"]);
export const PARTICIPANT_STATUSES = new Set(["active", "paused", "withdrawn"]);
export const SUBMISSION_SOURCES = new Set(["chat", "h5"]);

export type ParticipantRow = {
  id: number;
  wechat_openid: string;
  real_name: string;
  phone: string;
  participant_code: string;
  status: string;
  consent_confirmed: boolean | null;
  test_status: H5TestStatus | null;
  formal_status: H5FormalStatus | null;
  extra: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

export type VideoSubmissionRow = {
  id: number;
  participant_id: number;
  participant_code: string;
  source: string;
  wechat_media_id: string | null;
  object_key: string;
  file_name: string | null;
  size_bytes: number | null;
  mime: string | null;
  duration_sec: number | null;
  user_comment: string | null;
  submission_type: H5UploadKind | null;
  scene: string | null;
  review_status: "pending" | "approved" | "rejected";
  reject_reason: string | null;
  reviewed_at: string | null;
  created_at: string;
};

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
  submission_type?: H5UploadKind | null;
  scene?: string | null;
  review_status: "pending";
};

type CreateParticipantInput = {
  wechatOpenid: string;
  realName: string;
  phone: string;
  status: string;
  extra: Record<string, unknown>;
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

function parseNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function mapParticipantRow(row: QueryResultRow): ParticipantRow {
  return {
    id: parseInteger(row.id),
    wechat_openid: String(row.wechat_openid),
    real_name: String(row.real_name),
    phone: String(row.phone),
    participant_code: String(row.participant_code),
    status: String(row.status),
    consent_confirmed: row.consent_confirmed === null || row.consent_confirmed === undefined ? null : Boolean(row.consent_confirmed),
    test_status: row.test_status ? String(row.test_status) as H5TestStatus : null,
    formal_status: row.formal_status ? String(row.formal_status) as H5FormalStatus : null,
    extra: row.extra && typeof row.extra === "object" && !Array.isArray(row.extra) ? row.extra as Record<string, unknown> : {},
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function mapVideoSubmissionRow(row: QueryResultRow): VideoSubmissionRow {
  return {
    id: parseInteger(row.id),
    participant_id: parseInteger(row.participant_id),
    participant_code: String(row.participant_code),
    source: String(row.source),
    wechat_media_id: row.wechat_media_id ? String(row.wechat_media_id) : null,
    object_key: String(row.object_key),
    file_name: row.file_name ? String(row.file_name) : null,
    size_bytes: parseNullableInteger(row.size_bytes),
    mime: row.mime ? String(row.mime) : null,
    duration_sec: parseNullableNumber(row.duration_sec),
    user_comment: row.user_comment ? String(row.user_comment) : null,
    submission_type: row.submission_type ? String(row.submission_type) as H5UploadKind : null,
    scene: row.scene ? String(row.scene) : null,
    review_status: String(row.review_status) as VideoSubmissionRow["review_status"],
    reject_reason: row.reject_reason ? String(row.reject_reason) : null,
    reviewed_at: row.reviewed_at ? String(row.reviewed_at) : null,
    created_at: String(row.created_at),
  };
}

export async function findParticipantByOpenId(openid: string): Promise<ParticipantRow | null> {
  const row = await dbQueryMaybeOne(
    `select * from public.participants where wechat_openid = $1 limit 1`,
    [openid],
  );
  return row ? mapParticipantRow(row) : null;
}

export async function findParticipantByCode(participantCode: string): Promise<ParticipantRow | null> {
  const row = await dbQueryMaybeOne(
    `select * from public.participants where participant_code = $1 limit 1`,
    [participantCode],
  );
  return row ? mapParticipantRow(row) : null;
}

export async function findParticipantById(participantId: number): Promise<ParticipantRow | null> {
  const row = await dbQueryMaybeOne(
    `select * from public.participants where id = $1 limit 1`,
    [participantId],
  );
  return row ? mapParticipantRow(row) : null;
}

export async function updateParticipantWorkflow(
  participantId: number,
  patch: {
    consent_confirmed?: boolean;
    test_status?: H5TestStatus;
    formal_status?: H5FormalStatus;
  },
): Promise<ParticipantRow | null> {
  const assignments: string[] = [];
  const values: unknown[] = [];

  if (patch.consent_confirmed !== undefined) {
    assignments.push(`consent_confirmed = $${values.length + 1}`);
    values.push(patch.consent_confirmed);
  }
  if (patch.test_status !== undefined) {
    assignments.push(`test_status = $${values.length + 1}`);
    values.push(patch.test_status);
  }
  if (patch.formal_status !== undefined) {
    assignments.push(`formal_status = $${values.length + 1}`);
    values.push(patch.formal_status);
  }

  if (assignments.length === 0) {
    return findParticipantById(participantId);
  }

  const row = await dbQueryMaybeOne(
    `update public.participants
     set ${assignments.join(", ")},
         updated_at = now()
     where id = $${values.length + 1}
     returning *`,
    [...values, participantId],
  );
  return row ? mapParticipantRow(row) : null;
}

export async function findParticipantByCodeAndOpenId(
  participantCode: string,
  openid: string,
): Promise<Pick<ParticipantRow, "id" | "participant_code" | "status"> | null> {
  const row = await dbQueryMaybeOne(
    `select id, participant_code, status
     from public.participants
     where participant_code = $1 and wechat_openid = $2
     limit 1`,
    [participantCode, openid],
  );
  if (!row) {
    return null;
  }
  return {
    id: parseInteger(row.id),
    participant_code: String(row.participant_code),
    status: String(row.status),
  };
}

export async function nextParticipantCode(): Promise<string> {
  const row = await dbQueryMaybeOne<{ participant_code: string }>(
    `select participant_code from public.participants order by id desc limit 1`,
  );
  const current = row?.participant_code;
  const next = Number.parseInt(String(current ?? "0"), 10) + 1;
  if (!Number.isFinite(next) || next > 999_999) {
    return "000001";
  }
  return String(next).padStart(6, "0");
}

export async function createParticipant(params: CreateParticipantInput): Promise<{
  status: "created" | "exists" | "error";
  participant?: ParticipantRow;
  detail?: string;
}> {
  const existing = await findParticipantByOpenId(params.wechatOpenid);
  if (existing) {
    return { status: "exists", participant: existing };
  }

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const participantCode = await nextParticipantCode();
    try {
      const row = await dbQueryOne(
        `insert into public.participants (
           wechat_openid,
           real_name,
           phone,
           participant_code,
           status,
           consent_confirmed,
           test_status,
           formal_status,
           extra
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning *`,
        [
          params.wechatOpenid,
          params.realName,
          params.phone,
          participantCode,
          params.status,
          true,
          "not_started",
          "not_started",
          params.extra,
        ],
      );
      return { status: "created", participant: mapParticipantRow(row) };
    } catch (error) {
      if (!isDuplicateError(error as { code?: string; message?: string })) {
        return {
          status: "error",
          detail: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  return {
    status: "error",
    detail: "Could not allocate participant_code",
  };
}

export async function insertVideoSubmissionRow(row: VideoSubmissionInsert): Promise<{
  status: "inserted" | "duplicate" | "error";
  submission?: VideoSubmissionRow;
  detail?: string;
}> {
  try {
    const inserted = await dbQueryOne(
      `insert into public.video_submissions (
         participant_id,
         participant_code,
         source,
         object_key,
         wechat_media_id,
         file_name,
         size_bytes,
         mime,
         duration_sec,
         user_comment,
         submission_type,
         scene,
         review_status
       ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       returning *`,
      [
        row.participant_id,
        row.participant_code,
        row.source,
        row.object_key,
        row.wechat_media_id ?? null,
        row.file_name ?? null,
        row.size_bytes ?? null,
        row.mime ?? null,
        row.duration_sec ?? null,
        row.user_comment ?? null,
        row.submission_type ?? null,
        row.scene ?? null,
        row.review_status,
      ],
    );
    return { status: "inserted", submission: mapVideoSubmissionRow(inserted) };
  } catch (error) {
    if (isDuplicateError(error as { code?: string; message?: string })) {
      return { status: "duplicate" };
    }
    return {
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function findExistingSubmissionForDedup(params: {
  participantId: number;
  objectKey: string;
  wechatMediaId?: string | null;
}): Promise<VideoSubmissionRow | null> {
  const row = params.wechatMediaId
    ? await dbQueryMaybeOne(
        `select *
         from public.video_submissions
         where wechat_media_id = $1
         limit 1`,
        [params.wechatMediaId],
      )
    : await dbQueryMaybeOne(
        `select *
         from public.video_submissions
         where participant_id = $1 and object_key = $2
         limit 1`,
        [params.participantId, params.objectKey],
      );
  return row ? mapVideoSubmissionRow(row) : null;
}

export async function listVideoSubmissions(params: {
  reviewStatus?: string;
  limit: number;
}): Promise<VideoSubmissionRow[]> {
  const rows = params.reviewStatus
    ? await dbQuery(
        `select *
         from public.video_submissions
         where review_status = $1
         order by id desc
         limit $2`,
        [params.reviewStatus, params.limit],
      )
    : await dbQuery(
        `select *
         from public.video_submissions
         order by id desc
         limit $1`,
        [params.limit],
      );
  return rows.map(mapVideoSubmissionRow);
}

export async function listVideoSubmissionsByParticipantId(
  participantId: number,
  limit: number,
): Promise<VideoSubmissionRow[]> {
  const rows = await dbQuery(
    `select *
     from public.video_submissions
     where participant_id = $1
     order by id desc
     limit $2`,
    [participantId, limit],
  );
  return rows.map(mapVideoSubmissionRow);
}

export async function getVideoSubmissionById(id: number): Promise<VideoSubmissionRow | null> {
  const row = await dbQueryMaybeOne(
    `select * from public.video_submissions where id = $1 limit 1`,
    [id],
  );
  return row ? mapVideoSubmissionRow(row) : null;
}

export async function updateVideoSubmissionReview(params: {
  id: number;
  reviewStatus?: VideoSubmissionRow["review_status"];
  rejectReason?: string | null;
  reviewedAt?: string | null;
}): Promise<VideoSubmissionRow | null> {
  const patch: Array<[string, unknown]> = [];
  if (params.reviewStatus !== undefined) {
    patch.push(["review_status", params.reviewStatus]);
  }
  if (params.rejectReason !== undefined) {
    patch.push(["reject_reason", params.rejectReason]);
  }
  if (params.reviewedAt !== undefined) {
    patch.push(["reviewed_at", params.reviewedAt]);
  }
  if (patch.length === 0) {
    return getVideoSubmissionById(params.id);
  }
  const assignments = patch.map(([column], index) => `${column} = $${index + 1}`);
  const values = patch.map(([, value]) => value);
  const row = await dbQueryMaybeOne(
    `update public.video_submissions
     set ${assignments.join(", ")}
     where id = $${patch.length + 1}
     returning *`,
    [...values, params.id],
  );
  return row ? mapVideoSubmissionRow(row) : null;
}

async function updateVideoSubmissionStorage(params: {
  submissionId: number;
  objectKey: string;
  sizeBytes: number;
  mime: string;
}): Promise<void> {
  await dbQuery(
    `update public.video_submissions
     set object_key = $1,
         size_bytes = $2,
         mime = $3
     where id = $4`,
    [params.objectKey, params.sizeBytes, params.mime, params.submissionId],
  );
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
  await updateVideoSubmissionStorage({
    submissionId,
    objectKey,
    sizeBytes: download.body.length,
    mime: download.contentType,
  });
  console.info("wechat media sync completed", {
    submissionId,
    objectKey,
    sizeBytes: download.body.length,
    contentType: download.contentType,
  });
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
  return {
    ok: true,
    submissionId: insertResult.submission.id,
    participantCode: participant.participant_code,
  };
}

export async function processChatVideoWechat(params: {
  openid: string;
  mediaId: string;
  userComment?: string | null;
}): Promise<ChatVideoIngestResult> {
  const result = await createChatVideoWechatSubmission(params);
  if (!result.ok) {
    return result;
  }
  await syncWechatMediaToR2(result.submissionId, params.mediaId, result.participantCode);
  return result;
}

export function decorateSubmissionObjectUrl<T extends { object_key?: string | null }>(row: T): T & {
  object_url: string | null;
} {
  return {
    ...row,
    object_url: row.object_key ? buildPublicObjectUrl(row.object_key) : null,
  };
}
