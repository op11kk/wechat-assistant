import { NextRequest } from "next/server";

import { hasBackendProxyOrigin, proxyToBackend } from "@/lib/backend-proxy";
import { hasObjectStorageConfig } from "@/lib/env";
import { corsPreflightResponse, jsonResponse, withCorsHeaders } from "@/lib/http";
import { DEFAULT_MULTIPART_CONCURRENCY, getMultipartPartCount, getMultipartPartSize } from "@/lib/upload-multipart";
import { createMultipartUpload, buildH5ObjectKey } from "@/lib/r2";
import { createUploadSession } from "@/lib/upload-sessions";
import { findParticipantByCode } from "@/lib/video-submissions";

export const runtime = "nodejs";

export function OPTIONS(request: NextRequest) {
  if (hasBackendProxyOrigin()) {
    const url = new URL(request.url);
    return proxyToBackend(request, url.pathname, url.search);
  }
  return corsPreflightResponse(request.headers.get("origin"), "POST,OPTIONS");
}

export async function POST(request: NextRequest) {
  if (hasBackendProxyOrigin()) {
    const url = new URL(request.url);
    return proxyToBackend(request, url.pathname, url.search);
  }
  const corsHeaders = withCorsHeaders(undefined, request.headers.get("origin"), "POST,OPTIONS");
  if (!hasObjectStorageConfig()) {
    return jsonResponse({ error: "Object storage not configured" }, 503, { headers: corsHeaders });
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return jsonResponse({ error: "Invalid JSON body" }, 400, { headers: corsHeaders });
  }

  const participantCode = String(body.participant_code ?? "").trim();
  const contentType = String(body.content_type ?? "video/mp4").trim() || "video/mp4";
  const fileName = String(body.file_name ?? "").trim() || null;
  const sizeBytes = Number.parseInt(String(body.size_bytes ?? ""), 10);
  const userComment = String(body.user_comment ?? "").trim() || null;

  if (!participantCode || !Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return jsonResponse(
      {
        error: "Missing fields",
        detail: "participant_code and size_bytes required",
      },
      400,
      { headers: corsHeaders },
    );
  }

  try {
    const participant = await findParticipantByCode(participantCode);
    if (!participant) {
      return jsonResponse(
        {
          error: "Participant not found",
          detail: "上传码不存在，请回到公众号重新获取。",
        },
        404,
        { headers: corsHeaders },
      );
    }
    if (participant.status !== "active") {
      return jsonResponse(
        {
          error: "Participant not active",
          detail: "Participant must be active before using H5 upload.",
        },
        403,
        { headers: corsHeaders },
      );
    }

    const partSize = getMultipartPartSize(sizeBytes);
    const partCount = getMultipartPartCount(sizeBytes, partSize);
    if (partCount <= 0) {
      return jsonResponse({ error: "Invalid file size", detail: "size_bytes must be positive" }, 400, {
        headers: corsHeaders,
      });
    }

    const objectKey = buildH5ObjectKey(participant.participant_code, fileName, contentType);
    const multipart = await createMultipartUpload({
      objectKey,
      contentType,
    });
    const uploadSession = await createUploadSession({
      participantId: participant.id,
      participantCode: participant.participant_code,
      wechatOpenid: participant.wechat_openid,
      objectKey,
      fileName,
      sizeBytes,
      mime: contentType,
      uploadId: multipart.uploadId,
      partSize,
      partCount,
      userComment,
    });

    return jsonResponse(
      {
        session_id: uploadSession.id,
        participant_code: participant.participant_code,
        object_key: uploadSession.object_key,
        object_url: multipart.object_url,
        upload_id: uploadSession.upload_id,
        part_size: uploadSession.part_size,
        part_count: uploadSession.part_count,
        concurrency: DEFAULT_MULTIPART_CONCURRENCY,
        storage: multipart.storage,
      },
      200,
      { headers: corsHeaders },
    );
  } catch (error) {
    return jsonResponse({ error: "multipart init failed", detail: String(error) }, 500, { headers: corsHeaders });
  }
}
