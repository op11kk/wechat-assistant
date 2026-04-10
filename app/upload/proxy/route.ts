import { Readable } from "node:stream";

import { NextRequest } from "next/server";

import { requireApiAuth } from "@/lib/auth";
import { hasObjectStorageConfig } from "@/lib/env";
import { jsonResponse } from "@/lib/http";
import { buildH5ObjectKey, putObjectReadableStream } from "@/lib/r2";
import {
  decorateSubmissionObjectUrl,
  findParticipantByCodeAndOpenId,
  insertVideoSubmissionRow,
} from "@/lib/video-submissions";

export const runtime = "nodejs";

/** Vercel 上实际可传体积受套餐限制（Hobby 约 4.5MB）；Pro 等更高，仍建议大文件走预签名直传。 */
export const maxDuration = 300;

export async function POST(request: NextRequest) {
  const unauthorized = requireApiAuth(request);
  if (unauthorized) {
    return unauthorized;
  }
  if (!hasObjectStorageConfig()) {
    return jsonResponse({ error: "Object storage not configured" }, 503);
  }

  const participantCode = request.headers.get("x-participant-code")?.trim() ?? "";
  const wechatOpenid = request.headers.get("x-wechat-openid")?.trim() ?? "";
  const rawFileName = request.headers.get("x-file-name")?.trim() ?? "";
  const fileName = rawFileName ? decodeURIComponent(rawFileName) : "upload.mp4";
  const rawComment = request.headers.get("x-user-comment");
  const userComment =
    rawComment !== null && rawComment !== undefined && rawComment !== ""
      ? decodeURIComponent(rawComment)
      : null;

  if (!participantCode || !wechatOpenid) {
    return jsonResponse(
      { error: "Missing headers", detail: "X-Participant-Code, X-Wechat-Openid required" },
      400,
    );
  }

  const contentTypeHeader = request.headers.get("content-type");
  const contentType = contentTypeHeader?.split(";")[0].trim() || "application/octet-stream";

  const webBody = request.body;
  if (!webBody) {
    return jsonResponse({ error: "Empty body" }, 400);
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
    return jsonResponse(
      { error: "Participant not active", detail: "登记状态非 active 时不能上传" },
      403,
    );
  }

  const objectKey = buildH5ObjectKey(participantCode, fileName, contentType);
  const contentLength = request.headers.get("content-length");
  let sizeBytes: number | null = null;
  if (contentLength) {
    const n = Number.parseInt(contentLength, 10);
    if (!Number.isFinite(n) || n < 0) {
      return jsonResponse({ error: "Invalid Content-Length" }, 400);
    }
    sizeBytes = n;
  }

  const nodeReadable = Readable.fromWeb(webBody as import("stream/web").ReadableStream<Uint8Array>);

  try {
    await putObjectReadableStream({
      objectKey,
      body: nodeReadable,
      contentType,
    });
  } catch (error) {
    console.error("upload proxy put failed", error);
    return jsonResponse({ error: "Object storage upload failed", detail: String(error) }, 502);
  }

  const insertResult = await insertVideoSubmissionRow({
    participant_id: participant.id,
    participant_code: participantCode,
    source: "h5",
    object_key: objectKey,
    file_name: fileName,
    size_bytes: sizeBytes,
    mime: contentType,
    user_comment: userComment,
    review_status: "pending",
  });

  if (insertResult.status !== "inserted" || !insertResult.submission) {
    return jsonResponse(
      {
        error: "DB insert failed",
        detail: insertResult.detail ?? insertResult.status,
        object_key: objectKey,
      },
      500,
    );
  }

  return jsonResponse({
    message: "ok",
    object_key: objectKey,
    submission: decorateSubmissionObjectUrl(insertResult.submission),
    via: "server_proxy",
    hint: "大文件请配置 COS CORS 后改用预签名直传；本站中转受 Vercel 请求体大小与函数超时限制。",
  });
}
