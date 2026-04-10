import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { hasObjectStorageConfig } from "@/lib/env";
import { jsonResponse } from "@/lib/http";
import { buildH5ObjectKey, s3CreateMultipartUpload } from "@/lib/r2";
import {
  encodeSessionToken,
  getMultipartSigningSecret,
  MULTIPART_PART_SIZE_BYTES,
} from "@/lib/upload-multipart-session";
import { findParticipantByCodeAndOpenId } from "@/lib/video-submissions";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const unauthorized = requireApiAuth(request);
  if (unauthorized) {
    return unauthorized;
  }
  const signingSecret = getMultipartSigningSecret();
  if (!signingSecret) {
    return jsonResponse(
      {
        error: "Multipart signing not configured",
        detail: "请配置 API_SECRET 或 WECHAT_TOKEN，用于分片上传会话校验。",
      },
      503,
    );
  }
  if (!hasObjectStorageConfig()) {
    return jsonResponse({ error: "Object storage not configured" }, 503);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const participantCode = String(body.participant_code ?? "").trim();
  const wechatOpenid = String(body.wechat_openid ?? "").trim();
  const fileName = String(body.file_name ?? "upload.mp4").trim() || "upload.mp4";
  const contentType = String(body.content_type ?? "application/octet-stream").trim() || "application/octet-stream";
  const totalSize = Number(body.total_size);

  if (!participantCode || !wechatOpenid) {
    return jsonResponse({ error: "participant_code and wechat_openid required" }, 400);
  }
  if (!Number.isFinite(totalSize) || totalSize <= 0 || !Number.isInteger(totalSize)) {
    return jsonResponse({ error: "total_size must be a positive integer" }, 400);
  }

  let participant;
  try {
    participant = await findParticipantByCodeAndOpenId(participantCode, wechatOpenid);
  } catch (error) {
    return jsonResponse({ error: "Query failed", detail: String(error) }, 500);
  }
  if (!participant) {
    return jsonResponse(
      { error: "Participant mismatch", detail: "No row for this participant_code and wechat_openid" },
      404,
    );
  }
  if (participant.status !== "active") {
    return jsonResponse({ error: "Participant not active" }, 403);
  }

  const objectKey = buildH5ObjectKey(participantCode, fileName, contentType);
  let uploadId: string;
  try {
    uploadId = await s3CreateMultipartUpload({ objectKey, contentType });
  } catch (error) {
    console.error("CreateMultipartUpload failed", error);
    return jsonResponse({ error: "CreateMultipartUpload failed", detail: String(error) }, 502);
  }

  const exp = Math.floor(Date.now() / 1000) + 3600;
  const sessionPayload = {
    v: 1 as const,
    uploadId,
    objectKey,
    participantCode,
    wechatOpenid,
    fileName,
    contentType,
    totalSize,
    exp,
  };
  const sessionToken = encodeSessionToken(sessionPayload, signingSecret);
  const totalParts = Math.ceil(totalSize / MULTIPART_PART_SIZE_BYTES);

  return jsonResponse({
    upload_id: uploadId,
    object_key: objectKey,
    session_token: sessionToken,
    part_size_bytes: MULTIPART_PART_SIZE_BYTES,
    total_parts: totalParts,
    expires_in_sec: 3600,
  });
}
