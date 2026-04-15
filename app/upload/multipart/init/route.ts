import { NextRequest } from "next/server";

import { hasObjectStorageConfig } from "@/lib/env";
import { jsonResponse } from "@/lib/http";
import { DEFAULT_MULTIPART_CONCURRENCY, getMultipartPartCount, getMultipartPartSize } from "@/lib/upload-multipart";
import { createMultipartUpload, buildH5ObjectKey } from "@/lib/r2";
import { createUploadSession } from "@/lib/upload-sessions";
import { findParticipantByCodeAndOpenId } from "@/lib/video-submissions";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!hasObjectStorageConfig()) {
    return jsonResponse({ error: "Object storage not configured" }, 503);
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const participantCode = String(body.participant_code ?? "").trim();
  const wechatOpenid = String(body.wechat_openid ?? "").trim();
  const contentType = String(body.content_type ?? "video/mp4").trim() || "video/mp4";
  const fileName = String(body.file_name ?? "").trim() || null;
  const sizeBytes = Number.parseInt(String(body.size_bytes ?? ""), 10);
  const userComment = String(body.user_comment ?? "").trim() || null;

  if (!participantCode || !wechatOpenid || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return jsonResponse(
      {
        error: "Missing fields",
        detail: "participant_code, wechat_openid, size_bytes required",
      },
      400,
    );
  }

  try {
    const participant = await findParticipantByCodeAndOpenId(participantCode, wechatOpenid);
    if (!participant) {
      return jsonResponse(
        {
          error: "Participant mismatch",
          detail: "No row for this participant_code and wechat_openid. Please register first.",
        },
        404,
      );
    }
    if (participant.status !== "active") {
      return jsonResponse(
        {
          error: "Participant not active",
          detail: "Participant must be active before using H5 upload.",
        },
        403,
      );
    }

    const partSize = getMultipartPartSize(sizeBytes);
    const partCount = getMultipartPartCount(sizeBytes, partSize);
    if (partCount <= 0) {
      return jsonResponse({ error: "Invalid file size", detail: "size_bytes must be positive" }, 400);
    }

    const objectKey = buildH5ObjectKey(participantCode, fileName, contentType);
    const multipart = await createMultipartUpload({
      objectKey,
      contentType,
    });
    const session = await createUploadSession({
      participantId: participant.id,
      participantCode,
      wechatOpenid,
      objectKey,
      fileName,
      sizeBytes,
      mime: contentType,
      uploadId: multipart.uploadId,
      partSize,
      partCount,
      userComment,
    });

    return jsonResponse({
      session_id: session.id,
      object_key: session.object_key,
      object_url: multipart.object_url,
      upload_id: session.upload_id,
      part_size: session.part_size,
      part_count: session.part_count,
      concurrency: DEFAULT_MULTIPART_CONCURRENCY,
      storage: multipart.storage,
    });
  } catch (error) {
    return jsonResponse({ error: "multipart init failed", detail: String(error) }, 500);
  }
}
